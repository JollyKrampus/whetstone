import type { ComponentChildren } from 'preact';
import { useMemo } from 'preact/hooks';
import type { Nature } from '../schema.ts';
import { NATURES } from './lib/vocab.ts';
import ComboInput, { OptionList, type ComboOption } from './ComboInput.tsx';
import IssueList, { type IssueItem } from './IssueList.tsx';
import { TypeList } from './TypeChip.tsx';
import { formeLabel, type DexIndex } from './lib/dex.ts';
import { SP_MAX_STAT, SP_MAX_TOTAL, STAT_IDS, STAT_LABEL, STAT_NAME, finalStats, natureEffect, natureLabel, setSp, spTotal } from './lib/stats.ts';
import { MOVES_PER_SET, type PokemonSet } from './lib/team.ts';
import { battleForme } from './lib/teamview.ts';

interface Props {
  /** Prefix for element ids, unique on the page (e.g. "slot2", "atk"). */
  idBase: string;
  /** Heading text, e.g. "Slot 3" or "Attacker". */
  title: string;
  /** Small leading marker in the heading (slot number). */
  marker?: string;
  set: PokemonSet;
  dex: DexIndex;
  speciesOptions: readonly ComboOption[];
  speciesListId: string;
  itemOptions: readonly ComboOption[];
  itemListId: string;
  issues?: readonly IssueItem[];
  onChange: (set: PokemonSet) => void;
  /** Header buttons (move, remove). */
  actions?: ComponentChildren;
  level?: 3 | 4;
}

/** A fresh set for `species`, keeping what still fits from `prev` (nature, points, item, legal moves). */
export function switchSpecies(dex: DexIndex, prev: PokemonSet | null, species: string): PokemonSet {
  const s = dex.speciesById(species);
  const learn = new Set(dex.learnset(species));
  const next: PokemonSet = {
    species,
    nature: prev?.nature ?? 'Serious',
    sp: prev ? [...prev.sp] : [0, 0, 0, 0, 0, 0],
    moves: (prev?.moves ?? []).filter((m) => learn.has(m)),
  };
  if (prev?.item) next.item = prev.item;
  const ability = prev?.ability && s?.abilities.includes(prev.ability) ? prev.ability : s?.abilities[0];
  if (ability) next.ability = ability;
  return next;
}

/**
 * Island part: edit one set (species, item, ability, nature, Stat Points with live final stats,
 * four moves). Used by the team builder and the damage calc.
 */
export default function SetEditor({ idBase, title, marker, set, dex, speciesOptions, speciesListId, itemOptions, itemListId, issues = [], onChange, actions, level = 3 }: Props) {
  const species = dex.speciesById(set.species);
  const forme = battleForme(dex, set);
  const mega = forme && forme.id !== set.species ? forme : undefined;
  const stats = forme ? finalStats(forme.base, set.sp, set.nature) : null;
  const effect = natureEffect(set.nature);
  const total = spTotal(set.sp);
  const moveOptions = useMemo<ComboOption[]>(
    () =>
      dex
        .learnset(set.species)
        .map((id) => ({ id, label: dex.moveName(id) }))
        .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)),
    [dex, set.species],
  );
  const Heading = `h${level}` as 'h3' | 'h4';
  const moveListId = `${idBase}-moves`;
  const update = (patch: Partial<PokemonSet>) => onChange({ ...set, ...patch });
  const setMove = (i: number, id: string | undefined) => {
    const moves = [...set.moves];
    if (id === undefined) moves.splice(i, 1);
    else if (i < moves.length) moves[i] = id;
    else moves.push(id);
    update({ moves: moves.filter((m, j) => moves.indexOf(m) === j).slice(0, MOVES_PER_SET) });
  };

  return (
    <div class="pk-slot" data-error={issues.some((x) => x.level === 'error') ? 'true' : undefined} data-slot={idBase}>
      <div class="pk-slot__head">
        <Heading class="pk-slot__title">
          {marker && <span class="pk-slot__num" aria-hidden="true">{marker}</span>}
          <span>{title}</span>
          {forme && <TypeList types={forme.types} small />}
        </Heading>
        {actions && <div class="pk-actions">{actions}</div>}
      </div>

      <div class="pk-slot__grid">
        <ComboInput
          id={`${idBase}-species`}
          label="Pokémon"
          value={set.species}
          options={speciesOptions}
          listId={speciesListId}
          onCommit={(id) => id && onChange(switchSpecies(dex, set, id))}
        />
        <ComboInput
          id={`${idBase}-item`}
          label="Item"
          value={set.item}
          options={itemOptions}
          listId={itemListId}
          placeholder="No item"
          onCommit={(id) => {
            const next = { ...set };
            if (id) next.item = id;
            else delete next.item;
            onChange(next);
          }}
        />
        <div class="pk-field">
          <label for={`${idBase}-ability`}>Ability</label>
          <select
            id={`${idBase}-ability`}
            class="pk-select"
            value={set.ability ?? ''}
            onChange={(e) => {
              const v = (e.currentTarget as HTMLSelectElement).value;
              const next = { ...set };
              if (v) next.ability = v;
              else delete next.ability;
              onChange(next);
            }}
          >
            {!set.ability && <option value="">Choose…</option>}
            {(species?.abilities ?? []).map((a) => (
              <option value={a} key={a}>
                {dex.abilityName(a)}
              </option>
            ))}
            {set.ability && !species?.abilities.includes(set.ability) && <option value={set.ability}>{dex.abilityName(set.ability)} (not legal)</option>}
          </select>
          {mega && <small class="pk-subtle">As {formeLabel(mega)}: {dex.abilityName(mega.abilities[0] ?? '')}</small>}
        </div>
        <div class="pk-field">
          <label for={`${idBase}-nature`}>Nature</label>
          <select id={`${idBase}-nature`} class="pk-select" value={set.nature} onChange={(e) => update({ nature: (e.currentTarget as HTMLSelectElement).value as Nature })}>
            {NATURES.map((n) => (
              <option value={n} key={n}>
                {natureLabel(n)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <fieldset class="pk-spfield">
        <legend class="pk-label">
          Stat Points <span class="pk-num">{total}/{SP_MAX_TOTAL}</span>
          {total < SP_MAX_TOTAL ? ` · ${SP_MAX_TOTAL - total} left` : ' · all spent'}
          {mega ? ` · stats as ${formeLabel(mega)}` : ''}
        </legend>
        <div class="pk-spgrid">
          {STAT_IDS.map((stat, i) => {
            const mark = effect?.plus === stat ? '+' : effect?.minus === stat ? '−' : '';
            const id = `${idBase}-sp-${stat}`;
            return (
              <div class="pk-field" key={stat}>
                <label for={id} title={STAT_NAME[stat]}>
                  {STAT_LABEL[stat]}
                  {mark && <span aria-hidden="true"> {mark}</span>}
                  <span class="visually-hidden"> Stat Points{mark === '+' ? ', raised by nature' : mark === '−' ? ', lowered by nature' : ''}</span>
                </label>
                <input
                  id={id}
                  class="pk-input pk-input--sp"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={SP_MAX_STAT}
                  step={1}
                  value={set.sp[i]}
                  onInput={(e) => {
                    const raw = (e.currentTarget as HTMLInputElement).value;
                    if (raw === '') return;
                    update({ sp: setSp(set.sp, i, Number.parseInt(raw, 10)) });
                  }}
                  onBlur={(e) => {
                    const el = e.currentTarget as HTMLInputElement;
                    if (el.value !== String(set.sp[i])) el.value = String(set.sp[i]);
                  }}
                />
                <output for={id} aria-label={`${STAT_NAME[stat]} ${stats ? stats[stat] : 'unknown'}`}>{stats ? stats[stat] : '—'}</output>
              </div>
            );
          })}
        </div>
      </fieldset>

      <fieldset class="pk-spfield">
        <legend class="pk-label">Moves</legend>
        <div class="pk-slot__grid pk-slot__grid--moves">
          {Array.from({ length: MOVES_PER_SET }, (_, i) => (
            <ComboInput
              key={i}
              id={`${idBase}-move${i + 1}`}
              label={`Move ${i + 1}`}
              hideLabel
              value={set.moves[i]}
              options={moveOptions}
              listId={moveListId}
              placeholder={`Move ${i + 1}`}
              disabled={i > set.moves.length}
              onCommit={(id) => setMove(i, id)}
            />
          ))}
        </div>
        <OptionList id={moveListId} options={moveOptions} />
      </fieldset>

      <IssueList issues={issues} label={`Problems with ${species?.name ?? title}`} />
    </div>
  );
}
