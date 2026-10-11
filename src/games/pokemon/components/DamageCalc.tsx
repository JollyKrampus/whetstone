import { useEffect, useMemo, useState } from 'preact/hooks';
import { OptionList, type ComboOption } from './ComboInput.tsx';
import DexStatus from './DexStatus.tsx';
import SetEditor from './SetEditor.tsx';
import { useAsync, useDebounced, useDex, type DexState } from './hooks.ts';
import type { DexIndex } from './lib/dex.ts';
import type { MetaSet } from './lib/metasets.ts';
import { effectiveSpeed } from './lib/stats.ts';
import type { PokemonSet } from './lib/team.ts';
import { battleAbility, metaToSet, setDisplayName, setStats, setToCalcMon } from './lib/teamview.ts';
import { calcClient } from '../worker/client.ts';
import type { BoostStat, CalcField, CalcMon, CalcResponse, CalcSideFlags, MoveResult, StatusId, TerrainId, WeatherId } from '../worker/protocol.ts';

interface Props {
  dexUrl: string | null;
  regulation: string;
  metaSets: MetaSet[];
  usageLabel: string | null;
}

interface Side {
  set: PokemonSet;
  boosts: Partial<Record<BoostStat, number>>;
  status: StatusId;
  hp: number;
}

type SideFlags = Required<CalcSideFlags>;

const NO_FLAGS: SideFlags = { helpingHand: false, reflect: false, lightScreen: false, auroraVeil: false, friendGuard: false, tailwind: false };

const FLAG_LABEL: Record<keyof SideFlags, string> = {
  helpingHand: 'Helping Hand',
  reflect: 'Reflect',
  lightScreen: 'Light Screen',
  auroraVeil: 'Aurora Veil',
  friendGuard: 'Friend Guard',
  tailwind: 'Tailwind',
};

const STATUS: { id: StatusId; label: string }[] = [
  { id: '', label: 'Healthy' },
  { id: 'brn', label: 'Burned' },
  { id: 'par', label: 'Paralyzed' },
  { id: 'psn', label: 'Poisoned' },
  { id: 'tox', label: 'Badly poisoned' },
  { id: 'slp', label: 'Asleep' },
  { id: 'frz', label: 'Frozen' },
];

const WEATHER: { id: WeatherId; label: string }[] = [
  { id: '', label: 'None' },
  { id: 'Sun', label: 'Sun' },
  { id: 'Rain', label: 'Rain' },
  { id: 'Sand', label: 'Sand' },
  { id: 'Snow', label: 'Snow' },
];

const TERRAIN: { id: TerrainId; label: string }[] = [
  { id: '', label: 'None' },
  { id: 'Electric', label: 'Electric' },
  { id: 'Grassy', label: 'Grassy' },
  { id: 'Psychic', label: 'Psychic' },
  { id: 'Misty', label: 'Misty' },
];

const BOOSTS: { id: BoostStat; label: string }[] = [
  { id: 'atk', label: 'Atk' },
  { id: 'def', label: 'Def' },
  { id: 'spa', label: 'SpA' },
  { id: 'spd', label: 'SpD' },
  { id: 'spe', label: 'Spe' },
];

function side(set: PokemonSet): Side {
  return { set, boosts: {}, status: '', hp: 100 };
}

function startSides(dex: DexIndex, metaSets: readonly MetaSet[], regulation: string): [Side, Side] | null {
  if (metaSets.length >= 2) return [side(metaToSet(metaSets[0]!, dex)), side(metaToSet(metaSets[1]!, dex))];
  const legal = dex.teamSpecies().filter((s) => s.legal.includes(regulation));
  const a = legal[0];
  const b = legal[1] ?? legal[0];
  if (!a || !b) return null;
  const mk = (id: string, abilities: readonly string[]): Side => side({ species: id, nature: 'Serious', sp: [0, 0, 0, 0, 0, 0], moves: dex.learnset(id).slice(0, 4), ...(abilities[0] ? { ability: abilities[0] } : {}) });
  return [mk(a.id, a.abilities), mk(b.id, b.abilities)];
}

function toCalcMon(dex: DexIndex, s: Side): CalcMon {
  const mon = setToCalcMon(dex, s.set);
  const boosts = Object.fromEntries(Object.entries(s.boosts).filter(([, v]) => v)) as Partial<Record<BoostStat, number>>;
  if (Object.keys(boosts).length) mon.boosts = boosts;
  if (s.status) mon.status = s.status;
  if (s.hp < 100) mon.hpPercent = s.hp;
  return mon;
}

function speedOf(dex: DexIndex, s: Side, tailwind: boolean): number | null {
  const stats = setStats(dex, s.set);
  if (!stats) return null;
  return effectiveSpeed(stats.spe, s.set.item, { stage: s.boosts.spe ?? 0, tailwind, paralysis: s.status === 'par' });
}

function koClass(r: MoveResult): string | undefined {
  return r.koN === 1 ? 'true' : undefined;
}

/** Abilities that set weather or terrain on entry, applied to the field when picked (as in Showdown's calc). */
const FIELD_ABILITIES: Readonly<Record<string, { weather?: WeatherId; terrain?: TerrainId }>> = {
  drought: { weather: 'Sun' },
  orichalcumpulse: { weather: 'Sun' },
  drizzle: { weather: 'Rain' },
  sandstream: { weather: 'Sand' },
  snowwarning: { weather: 'Snow' },
  electricsurge: { terrain: 'Electric' },
  hadronengine: { terrain: 'Electric' },
  grassysurge: { terrain: 'Grassy' },
  psychicsurge: { terrain: 'Psychic' },
  mistysurge: { terrain: 'Misty' },
};

/**
 * One direction's results. Before the first answer arrives, `pending` placeholder cards (one per
 * move) hold the space the results will take, so the page below does not jump.
 */
function ResultList({ title, response, emptyText, pending = 0 }: { title: string; response: CalcResponse | null; emptyText: string; pending?: number }) {
  const results = response?.results ?? [];
  return (
    <section class="pk-section" style="gap: var(--sp-2)">
      <h3 class="pk-list-title">{title}</h3>
      {response === null && pending > 0 ? (
        <ul class="pk-cards" aria-hidden="true">
          {Array.from({ length: pending }, (_, i) => (
            <li class="pk-result pk-result--pending" key={i} />
          ))}
        </ul>
      ) : results.length === 0 && (response?.errors.length ?? 0) === 0 ? (
        <p class="pk-subtle">{emptyText}</p>
      ) : (
        <ul class="pk-cards">
          {results.map((r) => {
            const from = Math.min(100, r.minPct);
            const to = Math.min(100, r.maxPct);
            return (
              <li class="pk-result" key={r.move} data-move={r.move}>
                <div class="pk-result__top">
                  <span>
                    <strong>{r.moveName}</strong>
                    {r.spread && (
                      <>
                        {' '}
                        <span class="badge">spread ×0.75</span>
                      </>
                    )}
                  </span>
                  <span class="pk-result__pct">
                    {r.max === 0 ? 'No damage' : `${r.minPct}–${r.maxPct}%`}
                  </span>
                </div>
                {r.max > 0 && (
                  <>
                    <div class="pk-range" data-ko={koClass(r)} aria-hidden="true">
                      <span class="pk-range__sure" style={`--from: 0%; --span: ${from}%`} />
                      <span style={`--from: ${Math.min(from, 99)}%; --span: ${Math.max(1, to - from)}%`} />
                    </div>
                    <p class="pk-result__ko">
                      {r.koText || 'Not a KO within four hits'}
                      <span class="pk-subtle pk-num">
                        {' '}
                        · {r.min}–{r.max} of {r.defenderHp} HP
                      </span>
                    </p>
                  </>
                )}
                {r.desc && <p class="pk-result__desc">{r.desc}</p>}
              </li>
            );
          })}
          {response?.errors.map((e) => (
            <li class="pk-issue" data-level="warning" key={`err-${e.move}`}>
              <span class="pk-issue__tag">Skipped</span>
              <span>{e.error}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SideExtras({ idBase, s, onChange, flags, onFlags, doubles }: { idBase: string; s: Side; onChange: (s: Side) => void; flags: SideFlags; onFlags: (f: SideFlags) => void; doubles: boolean }) {
  return (
    <div class="pk-extras">
      <fieldset class="pk-spfield">
        <legend class="pk-label">Stat changes</legend>
        <div class="pk-boosts">
          {BOOSTS.map((b) => (
            <label class="pk-field" key={b.id}>
              <span>{b.label}</span>
              <select
                class="pk-select"
                value={String(s.boosts[b.id] ?? 0)}
                onChange={(e) => onChange({ ...s, boosts: { ...s.boosts, [b.id]: Number((e.currentTarget as HTMLSelectElement).value) } })}
              >
                {[6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6].map((v) => (
                  <option value={String(v)} key={v}>
                    {v > 0 ? `+${v}` : v === 0 ? '±0' : String(v)}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
      </fieldset>
      <div class="pk-slot__grid">
        <label class="pk-field">
          <span>Status</span>
          <select class="pk-select" value={s.status} onChange={(e) => onChange({ ...s, status: (e.currentTarget as HTMLSelectElement).value as StatusId })}>
            {STATUS.map((x) => (
              <option value={x.id} key={x.id}>
                {x.label}
              </option>
            ))}
          </select>
        </label>
        <label class="pk-field" for={`${idBase}-hp`}>
          <span>Current HP %</span>
          <input
            id={`${idBase}-hp`}
            class="pk-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={100}
            value={s.hp}
            onInput={(e) => {
              const v = Number.parseInt((e.currentTarget as HTMLInputElement).value, 10);
              if (Number.isFinite(v)) onChange({ ...s, hp: Math.min(100, Math.max(1, v)) });
            }}
          />
        </label>
      </div>
      <fieldset class="pk-toggles">
        <legend class="pk-label">This side's field</legend>
        {(Object.keys(FLAG_LABEL) as (keyof SideFlags)[])
          .filter((k) => doubles || (k !== 'helpingHand' && k !== 'friendGuard'))
          .map((k) => (
            <label class="pk-check" key={k}>
              <input type="checkbox" checked={flags[k]} onChange={(e) => onFlags({ ...flags, [k]: (e.currentTarget as HTMLInputElement).checked })} />
              {FLAG_LABEL[k]}
            </label>
          ))}
      </fieldset>
    </div>
  );
}

/**
 * What the server renders and what shows while the dex loads: the calculator's own frame (results
 * card, two sides, field card) with placeholders of the final size, so nothing below moves when
 * the tool appears (CLS), and the load status or error with a retry in the results card.
 */
function CalcSkeleton({ state, retry }: { state: DexState; retry: () => void }) {
  return (
    <div class="pk-calc" data-loading="true">
      <section class="card pk-panel pk-calc__results" aria-labelledby="pk-results-h">
        <h2 id="pk-results-h">Results</h2>
        <DexStatus state={state} retry={retry} />
        <div class="pk-cols" aria-hidden="true">
          <div class="pk-skel pk-skel--results" />
          <div class="pk-skel pk-skel--results" />
        </div>
      </section>
      <div class="pk-calc__sides" aria-hidden="true">
        <div class="pk-skel pk-skel--side" />
        <span class="pk-calc__swap pk-skel pk-skel--swap" />
        <div class="pk-skel pk-skel--side" />
      </div>
      <div class="card pk-panel pk-skel--field" aria-hidden="true" />
    </div>
  );
}

/**
 * Island: Champions damage calculator on @smogon/calc (generation 0) in a Web Worker. Both
 * directions are calculated, with Doubles spread damage, weather, terrain, screens, Helping Hand,
 * Friend Guard and a speed check that accounts for Tailwind, Trick Room, Scarf and paralysis.
 */
export default function DamageCalc({ dexUrl, regulation, metaSets, usageLabel }: Props) {
  const dexState = useDex(dexUrl);
  const dex = dexState.status === 'ready' ? dexState.dex : null;
  const [a, setA] = useState<Side | null>(null);
  const [b, setB] = useState<Side | null>(null);
  const [flagsA, setFlagsA] = useState<SideFlags>(NO_FLAGS);
  const [flagsB, setFlagsB] = useState<SideFlags>(NO_FLAGS);
  const [doubles, setDoubles] = useState(true);
  const [weather, setWeather] = useState<WeatherId>('');
  const [terrain, setTerrain] = useState<TerrainId>('');
  const [gravity, setGravity] = useState(false);
  const [crit, setCrit] = useState(false);
  const [trickRoom, setTrickRoom] = useState(false);

  useEffect(() => {
    if (!dex || a) return;
    const start = startSides(dex, metaSets, regulation);
    if (start) {
      setA(start[0]);
      setB(start[1]);
    }
  }, [dex]);

  // Weather and terrain follow a newly picked setter ability on either side.
  const abilityA = dex && a ? battleAbility(dex, a.set) : undefined;
  const abilityB = dex && b ? battleAbility(dex, b.set) : undefined;
  const applyField = (ability: string | undefined) => {
    const fx = ability ? FIELD_ABILITIES[ability] : undefined;
    if (fx?.weather) setWeather(fx.weather);
    if (fx?.terrain) setTerrain(fx.terrain);
  };
  useEffect(() => applyField(abilityA), [abilityA]);
  useEffect(() => applyField(abilityB), [abilityB]);

  const options = useMemo(() => {
    if (!dex) return { species: [] as ComboOption[], items: [] as ComboOption[] };
    return {
      species: dex
        .teamSpecies()
        .filter((s) => s.legal.includes(regulation))
        .map((s) => ({ id: s.id, label: s.name })),
      items: dex.items
        .filter((i) => i.legal.includes(regulation))
        .map((i) => ({ id: i.id, label: i.name }))
        .sort((x, y) => (x.label < y.label ? -1 : x.label > y.label ? 1 : 0)),
    };
  }, [dex, regulation]);

  const field = (attacker: SideFlags, defender: SideFlags): CalcField => {
    const f: CalcField = { doubles, gravity, crit, attacker, defender };
    if (weather) f.weather = weather;
    if (terrain) f.terrain = terrain;
    return f;
  };

  const job = useMemo(() => {
    if (!dex || !a || !b) return null;
    const am = toCalcMon(dex, a);
    const bm = toCalcMon(dex, b);
    return {
      forward: { attacker: am, defender: bm, moves: a.set.moves, field: field(flagsA, flagsB) },
      reverse: { attacker: bm, defender: am, moves: b.set.moves, field: field(flagsB, flagsA) },
    };
  }, [dex, a, b, flagsA, flagsB, doubles, weather, terrain, gravity, crit]);
  const settled = useDebounced(job, 150);
  const result = useAsync(settled ? JSON.stringify(settled) : null, async () => {
    const client = calcClient();
    const [forward, reverse] = await Promise.all([client.calc(settled!.forward), client.calc(settled!.reverse)]);
    return { forward, reverse };
  });

  if (!dex || !a || !b) return <CalcSkeleton state={dexState} retry={dexState.retry} />;

  const nameA = setDisplayName(dex, a.set);
  const nameB = setDisplayName(dex, b.set);
  const speedA = speedOf(dex, a, flagsA.tailwind);
  const speedB = speedOf(dex, b, flagsB.tailwind);
  let speedText = '';
  if (speedA !== null && speedB !== null) {
    if (speedA === speedB) speedText = `Speed tie at ${speedA}: either can move first.`;
    else {
      const aFirst = trickRoom ? speedA < speedB : speedA > speedB;
      const [first, firstSpeed, second, secondSpeed] = aFirst ? [nameA, speedA, nameB, speedB] : [nameB, speedB, nameA, speedA];
      speedText = `${first} (Speed ${firstSpeed}) moves before ${second} (${secondSpeed})${trickRoom ? ' under Trick Room' : ''} at equal priority.`;
    }
  }
  const presetOptions = metaSets.map((m) => ({ id: m.id, label: `#${m.rank} ${m.name}` }));
  const swap = () => {
    setA(b);
    setB(a);
    setFlagsA(flagsB);
    setFlagsB(flagsA);
  };
  const done = result.status === 'done' ? result.value : null;

  const preset = (idBase: string, onPick: (m: MetaSet) => void) =>
    presetOptions.length > 0 && (
      <label class="pk-field" for={`${idBase}-preset`}>
        <span>Load a common set{usageLabel ? ` (${usageLabel})` : ''}</span>
        <select
          id={`${idBase}-preset`}
          class="pk-select"
          value=""
          onChange={(e) => {
            const id = (e.currentTarget as HTMLSelectElement).value;
            const m = metaSets.find((x) => x.id === id);
            if (m) onPick(m);
            (e.currentTarget as HTMLSelectElement).value = '';
          }}
        >
          <option value="">Choose a Pokémon…</option>
          {presetOptions.map((o) => (
            <option value={o.id} key={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
    );

  return (
    <div class="pk-calc" data-ready="true">
      <OptionList id="pk-calc-species" options={options.species} />
      <OptionList id="pk-calc-items" options={options.items} />

      <section class="card pk-panel pk-calc__results" aria-labelledby="pk-results-h" aria-busy={result.status === 'busy' ? 'true' : 'false'}>
        <h2 id="pk-results-h">Results</h2>
        <p class="pk-status" role="status" aria-live="polite">
          {result.status === 'busy' && !done ? 'Calculating…' : result.status === 'error' ? `The calculator failed: ${result.message}` : speedText}
        </p>
        <div class="pk-cols">
          <ResultList
            title={`${nameA} → ${nameB}`}
            response={done?.forward ?? null}
            pending={result.status === 'error' ? 0 : a.set.moves.length}
            emptyText={`Give ${nameA} a move to see its damage.`}
          />
          <ResultList
            title={`${nameB} → ${nameA}`}
            response={done?.reverse ?? null}
            pending={result.status === 'error' ? 0 : b.set.moves.length}
            emptyText={`Give ${nameB} a move to see its damage.`}
          />
        </div>
      </section>

      <div class="pk-calc__sides">
        <section class="pk-section" aria-labelledby="pk-side-a-h" style="gap: var(--sp-2)">
          <h2 id="pk-side-a-h" class="pk-label">
            Left side
          </h2>
          {preset('atk', (m) => setA(side(metaToSet(m, dex))))}
          <SetEditor
            idBase="atk"
            title={nameA}
            set={a.set}
            dex={dex}
            speciesOptions={options.species}
            speciesListId="pk-calc-species"
            itemOptions={options.items}
            itemListId="pk-calc-items"
            onChange={(set) => setA({ ...a, set })}
          />
          <SideExtras idBase="atk" s={a} onChange={setA} flags={flagsA} onFlags={setFlagsA} doubles={doubles} />
        </section>

        <button type="button" class="btn btn--sm pk-calc__swap" onClick={swap}>
          ⇄ Swap sides
        </button>

        <section class="pk-section" aria-labelledby="pk-side-b-h" style="gap: var(--sp-2)">
          <h2 id="pk-side-b-h" class="pk-label">
            Right side
          </h2>
          {preset('def', (m) => setB(side(metaToSet(m, dex))))}
          <SetEditor
            idBase="def"
            title={nameB}
            set={b.set}
            dex={dex}
            speciesOptions={options.species}
            speciesListId="pk-calc-species"
            itemOptions={options.items}
            itemListId="pk-calc-items"
            onChange={(set) => setB({ ...b, set })}
          />
          <SideExtras idBase="def" s={b} onChange={setB} flags={flagsB} onFlags={setFlagsB} doubles={doubles} />
        </section>
      </div>

      <section class="card pk-panel" aria-labelledby="pk-field-h">
        <h2 id="pk-field-h">Field</h2>
        <div class="pk-actions">
          <span class="pk-seg" role="group" aria-label="Battle format">
            <button type="button" aria-pressed={doubles ? 'true' : 'false'} onClick={() => setDoubles(true)}>
              Doubles
            </button>
            <button type="button" aria-pressed={doubles ? 'false' : 'true'} onClick={() => setDoubles(false)}>
              Singles
            </button>
          </span>
        </div>
        <div class="pk-slot__grid">
          <label class="pk-field">
            <span>Weather</span>
            <select class="pk-select" value={weather} onChange={(e) => setWeather((e.currentTarget as HTMLSelectElement).value as WeatherId)}>
              {WEATHER.map((w) => (
                <option value={w.id} key={w.id}>
                  {w.label}
                </option>
              ))}
            </select>
          </label>
          <label class="pk-field">
            <span>Terrain</span>
            <select class="pk-select" value={terrain} onChange={(e) => setTerrain((e.currentTarget as HTMLSelectElement).value as TerrainId)}>
              {TERRAIN.map((t) => (
                <option value={t.id} key={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <fieldset class="pk-toggles">
          <legend class="pk-label">Both sides</legend>
          <label class="pk-check">
            <input type="checkbox" checked={crit} onChange={(e) => setCrit((e.currentTarget as HTMLInputElement).checked)} />
            Critical hit
          </label>
          <label class="pk-check">
            <input type="checkbox" checked={gravity} onChange={(e) => setGravity((e.currentTarget as HTMLInputElement).checked)} />
            Gravity
          </label>
          <label class="pk-check">
            <input type="checkbox" checked={trickRoom} onChange={(e) => setTrickRoom((e.currentTarget as HTMLInputElement).checked)} />
            Trick Room (speed order only)
          </label>
        </fieldset>
        <p class="pk-subtle">
          Level 50 with Stat Points; Champions move and item changes come from @smogon/calc. In Doubles, moves that hit both foes do 0.75× damage. Tailwind,
          Trick Room, Choice Scarf and paralysis only change who moves first.
        </p>
      </section>
    </div>
  );
}
