import { useState } from 'preact/hooks';
import { NATURES, type Nature } from '../schema.ts';
import { SP_MAX_STAT, SP_MAX_TOTAL, STAT_IDS, STAT_LABEL, STAT_NAME, finalStats, natureEffect, natureLabel, setSp, spTotal, type SpTuple, type StatTable } from './lib/stats.ts';
import { spLine } from './lib/paste.ts';

interface Spread {
  nature: Nature;
  sp: SpTuple;
  share: number;
}

interface Props {
  /** Forme name, e.g. "Mega Salamence". */
  name: string;
  /** Unique per page (forme id): prefixes element ids. */
  idPrefix: string;
  base: StatTable;
  /** Most common spreads (best first) offered as one-tap presets. */
  spreads?: Spread[];
}

const EMPTY: SpTuple = [0, 0, 0, 0, 0, 0];

/**
 * Island: Stat Point allocator. 66 points, at most 32 per stat, level 50, nature ±10 %. Shows
 * the final stats live; the server renders the most common spread so the numbers are useful
 * before (and without) hydration.
 */
export default function StatPlanner({ name, idPrefix, base, spreads = [] }: Props) {
  const first = spreads[0];
  const [nature, setNature] = useState<Nature>(first?.nature ?? 'Serious');
  const [sp, setSpState] = useState<SpTuple>(first ? [...first.sp] : [...EMPTY]);
  const stats = finalStats(base, sp, nature);
  const effect = natureEffect(nature);
  const total = spTotal(sp);

  const update = (i: number, raw: string | number) => {
    const value = typeof raw === 'number' ? raw : Number.parseInt(raw, 10);
    setSpState(setSp(sp, i, Number.isFinite(value) ? value : 0));
  };

  return (
    <div class="pk-planner" data-planner={idPrefix}>
      <div class="pk-planner__head">
        <label class="pk-field" style="min-width: 12rem">
          <span>Nature</span>
          <select class="pk-select" value={nature} onChange={(e) => setNature((e.currentTarget as HTMLSelectElement).value as Nature)}>
            {NATURES.map((n) => (
              <option value={n} key={n}>
                {natureLabel(n)}
              </option>
            ))}
          </select>
        </label>
        <p class="pk-planner__total pk-num" data-full={total === SP_MAX_TOTAL ? 'true' : undefined} aria-live="polite">
          {total} / {SP_MAX_TOTAL} Stat Points · {SP_MAX_TOTAL - total} left
        </p>
      </div>

      {spreads.length > 0 && (
        <div class="pk-actions" role="group" aria-label={`Common ${name} spreads`}>
          {spreads.map((s, i) => (
            <button
              type="button"
              class="btn btn--sm"
              key={i}
              aria-pressed={s.nature === nature && s.sp.every((v, j) => v === sp[j]) ? 'true' : 'false'}
              onClick={() => {
                setNature(s.nature);
                setSpState([...s.sp]);
              }}
            >
              {s.nature} {s.sp.join('/')} <span class="pk-subtle">({Math.round(s.share * 100)}%)</span>
            </button>
          ))}
          <button type="button" class="btn btn--sm btn--ghost" onClick={() => setSpState([...EMPTY])}>
            Clear points
          </button>
        </div>
      )}

      <div class="pk-planner__rows">
        {STAT_IDS.map((stat, i) => {
          const id = `${idPrefix}-sp-${stat}`;
          const mark = effect?.plus === stat ? '+' : effect?.minus === stat ? '−' : '';
          const markText = mark === '+' ? ', raised by nature' : mark === '−' ? ', lowered by nature' : '';
          const max = Math.min(SP_MAX_STAT, sp[i]! + SP_MAX_TOTAL - total);
          return (
            <div class="pk-planner__row" key={stat}>
              <label for={id} title={STAT_NAME[stat]}>
                {STAT_LABEL[stat]}
                <span class="visually-hidden"> Stat Points (base {base[stat]})</span>
              </label>
              <input
                type="range"
                min={0}
                max={SP_MAX_STAT}
                step={1}
                value={sp[i]}
                aria-label={`${STAT_NAME[stat]} Stat Points`}
                aria-valuetext={`${sp[i]} points, ${stats[stat]} ${STAT_NAME[stat]}`}
                onInput={(e) => update(i, (e.currentTarget as HTMLInputElement).value)}
              />
              <input
                id={id}
                class="pk-input pk-input--sp"
                type="number"
                inputMode="numeric"
                min={0}
                max={max}
                step={1}
                value={sp[i]}
                onChange={(e) => update(i, (e.currentTarget as HTMLInputElement).value)}
              />
              <output for={id} class="pk-stat__final" aria-label={`${STAT_NAME[stat]} ${stats[stat]}${markText}`}>
                {stats[stat]}
                {mark && <span class="pk-stat__nat" aria-hidden="true">{mark}</span>}
              </output>
            </div>
          );
        })}
      </div>
      <p class="pk-subtle">
        Level 50, IVs 31. Paste line: <code>{spLine(sp) ? `EVs: ${spLine(sp)}` : 'EVs: (none)'}</code> · {nature} Nature
      </p>
    </div>
  );
}
