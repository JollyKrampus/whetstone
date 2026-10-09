import { useMemo, useState } from 'preact/hooks';
import type { Nature } from '../schema.ts';
import { modifiedSpeed, natureLabel, statValue, type SpeedMods } from './lib/stats.ts';

export interface SpeedRowData {
  id: string;
  name: string;
  href: string;
  base: number;
  /** Speed of the most common spread. */
  speed: number;
  nature: Nature;
  sp: number;
  share: number;
  max: number;
  neutral: number;
  min: number;
}

export interface SpeedSpecies {
  id: string;
  name: string;
  base: number;
}

interface Props {
  rows: SpeedRowData[];
  /** Legal Pokémon for "where does mine land". */
  species: SpeedSpecies[];
}

type Column = 'speed' | 'max' | 'neutral' | 'min';

const COLUMNS: { id: Column; label: string; hint: string }[] = [
  { id: 'speed', label: 'Common', hint: 'their most used spread' },
  { id: 'max', label: 'Max', hint: '+Spe nature, 32 SP' },
  { id: 'neutral', label: 'Neutral', hint: 'no Speed investment' },
  { id: 'min', label: 'Min', hint: '−Spe nature, 0 SP (Trick Room)' },
];

const SPEED_NATURES: { id: 'plus' | 'neutral' | 'minus'; label: string; nature: Nature }[] = [
  { id: 'plus', label: '+Spe (Timid/Jolly)', nature: 'Timid' },
  { id: 'neutral', label: 'Neutral', nature: 'Serious' },
  { id: 'minus', label: '−Spe (Brave/Quiet)', nature: 'Brave' },
];

function ModFields({ legend, mods, onChange, idp }: { legend: string; mods: SpeedMods; onChange: (m: SpeedMods) => void; idp: string }) {
  return (
    <fieldset class="pk-toggles">
      <legend class="pk-label">{legend}</legend>
      <label class="pk-check">
        <input type="checkbox" checked={Boolean(mods.scarf)} onChange={(e) => onChange({ ...mods, scarf: (e.currentTarget as HTMLInputElement).checked })} />
        Choice Scarf ×1.5
      </label>
      <label class="pk-check">
        <input type="checkbox" checked={Boolean(mods.tailwind)} onChange={(e) => onChange({ ...mods, tailwind: (e.currentTarget as HTMLInputElement).checked })} />
        Tailwind ×2
      </label>
      <label class="pk-check">
        <input type="checkbox" checked={Boolean(mods.paralysis)} onChange={(e) => onChange({ ...mods, paralysis: (e.currentTarget as HTMLInputElement).checked })} />
        Paralysis ×½
      </label>
      <label class="pk-check" for={`${idp}-stage`}>
        Stage
        <select
          id={`${idp}-stage`}
          class="pk-select"
          style="width: auto; min-height: 2.25rem"
          value={String(mods.stage ?? 0)}
          onChange={(e) => onChange({ ...mods, stage: Number((e.currentTarget as HTMLSelectElement).value) })}
        >
          {[-2, -1, 0, 1, 2].map((s) => (
            <option value={String(s)} key={s}>
              {s > 0 ? `+${s}` : s === 0 ? '±0' : String(s)}
              {s === -1 ? ' (Icy Wind)' : ''}
            </option>
          ))}
        </select>
      </label>
    </fieldset>
  );
}

/**
 * Island: the speed tier table with modifiers for your Pokémon and for everyone else, Trick Room
 * ordering and a "where does mine land" row. The server renders the plain table first.
 */
export default function SpeedTable({ rows, species }: Props) {
  const [column, setColumn] = useState<Column>('speed');
  const [theirs, setTheirs] = useState<SpeedMods>({});
  const [mine, setMine] = useState<SpeedMods>({});
  const [trickRoom, setTrickRoom] = useState(false);
  const [mineName, setMineName] = useState('');
  const [mineNature, setMineNature] = useState<'plus' | 'neutral' | 'minus'>('plus');
  const [mineSp, setMineSp] = useState(32);

  const pick = species.find((s) => s.name.toLowerCase() === mineName.trim().toLowerCase() || s.id === mineName.trim().toLowerCase());
  const mineSpeed = pick
    ? modifiedSpeed(statValue('spe', pick.base, mineSp, SPEED_NATURES.find((n) => n.id === mineNature)!.nature), mine)
    : null;

  const table = useMemo(() => {
    const list = rows.map((r) => ({ key: r.id, row: r, value: modifiedSpeed(r[column], theirs), mine: false }));
    if (pick && mineSpeed !== null) {
      const row: SpeedRowData = { id: pick.id, name: pick.name, href: '', base: pick.base, speed: mineSpeed, nature: 'Serious', sp: mineSp, share: 0, max: 0, neutral: 0, min: 0 };
      list.push({ key: `mine-${pick.id}`, row, value: mineSpeed, mine: true });
    }
    list.sort((a, b) => (trickRoom ? a.value - b.value : b.value - a.value) || (a.mine === b.mine ? (a.key < b.key ? -1 : 1) : a.mine ? -1 : 1));
    return list;
  }, [rows, column, theirs, trickRoom, pick, mineSpeed, mineSp]);

  const summary =
    pick && mineSpeed !== null
      ? (() => {
          const others = table.filter((t) => !t.mine);
          const faster = others.filter((t) => (trickRoom ? mineSpeed < t.value : mineSpeed > t.value)).length;
          const ties = others.filter((t) => t.value === mineSpeed).length;
          return `${pick.name} at ${mineSpeed} Speed moves before ${faster} of ${others.length}${ties ? ` and ties ${ties} (speed tie: random order)` : ''}${trickRoom ? ' under Trick Room' : ''}.`;
        })()
      : '';

  const colHint = COLUMNS.find((c) => c.id === column)!.hint;

  return (
    <div class="pk-tool">
      <div class="card pk-panel">
        <div class="pk-actions" role="group" aria-label="Which spread to compare">
          <span class="pk-label">Their spread</span>
          <span class="pk-seg">
            {COLUMNS.map((c) => (
              <button type="button" key={c.id} aria-pressed={column === c.id ? 'true' : 'false'} onClick={() => setColumn(c.id)} title={c.hint}>
                {c.label}
              </button>
            ))}
          </span>
          <label class="pk-check">
            <input type="checkbox" checked={trickRoom} onChange={(e) => setTrickRoom((e.currentTarget as HTMLInputElement).checked)} />
            Trick Room (slowest moves first)
          </label>
        </div>
        <div class="pk-cols">
          <ModFields legend="Everyone else" mods={theirs} onChange={setTheirs} idp="spd-theirs" />
          <div class="pk-section" style="gap: var(--sp-2)">
            <span class="pk-label">Where does mine land?</span>
            <div class="pk-slot__grid">
              <label class="pk-field">
                <span>Pokémon</span>
                <input class="pk-input" list="spd-species" value={mineName} placeholder="e.g. Garchomp" onInput={(e) => setMineName((e.currentTarget as HTMLInputElement).value)} />
              </label>
              <label class="pk-field">
                <span>Speed SP</span>
                <input
                  class="pk-input"
                  type="number"
                  inputMode="numeric"
                  min={0}
                  max={32}
                  value={mineSp}
                  onInput={(e) => setMineSp(Math.max(0, Math.min(32, Number.parseInt((e.currentTarget as HTMLInputElement).value, 10) || 0)))}
                />
              </label>
              <label class="pk-field">
                <span>Nature</span>
                <select class="pk-select" value={mineNature} onChange={(e) => setMineNature((e.currentTarget as HTMLSelectElement).value as 'plus' | 'neutral' | 'minus')}>
                  {SPEED_NATURES.map((n) => (
                    <option value={n.id} key={n.id}>
                      {n.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <datalist id="spd-species">
              {species.map((s) => (
                <option value={s.name} key={s.id} />
              ))}
            </datalist>
            <ModFields legend="Mine" mods={mine} onChange={setMine} idp="spd-mine" />
          </div>
        </div>
        <p class="pk-status" role="status" aria-live="polite">
          {summary || `Sorted by ${colHint}${trickRoom ? ', slowest first' : ''}.`}
        </p>
      </div>

      <div class="pk-scroll">
        <table class="pk-table" aria-label="Speed tiers">
          <thead>
            <tr>
              <th scope="col" class="pk-num">#</th>
              <th scope="col">Pokémon</th>
              <th scope="col" class="pk-num">
                Speed <span class="visually-hidden">({colHint})</span>
              </th>
              <th scope="col">Common spread</th>
              <th scope="col" class="pk-num">Base</th>
              <th scope="col" class="pk-num">Max</th>
              <th scope="col" class="pk-num">Neutral</th>
              <th scope="col" class="pk-num">Min</th>
            </tr>
          </thead>
          <tbody>
            {table.map((t, i) => {
              const prev = table[i - 1];
              const tie = prev !== undefined && prev.value === t.value;
              return (
                <tr key={t.key} data-mine={t.mine ? 'true' : undefined} data-tie={tie ? 'true' : undefined}>
                  <td class="pk-num">{i + 1}</td>
                  <th scope="row" style="font-weight: 600">
                    {t.mine ? (
                      <>
                        {t.row.name} <span class="badge badge--accent">Yours</span>
                      </>
                    ) : (
                      <a href={t.row.href}>{t.row.name}</a>
                    )}
                  </th>
                  <td class="pk-num">
                    <strong>{t.value}</strong>
                    {tie ? <span class="visually-hidden"> (tie)</span> : null}
                  </td>
                  <td class="pk-subtle">
                    {t.mine ? `${mineSp} SP, ${SPEED_NATURES.find((n) => n.id === mineNature)!.label}` : `${natureLabel(t.row.nature).replace(/ \(.*\)$/, '')} ${t.row.sp} SP · ${Math.round(t.row.share * 100)}%`}
                  </td>
                  <td class="pk-num">{t.row.base}</td>
                  <td class="pk-num">{t.mine ? '' : t.row.max}</td>
                  <td class="pk-num">{t.mine ? '' : t.row.neutral}</td>
                  <td class="pk-num">{t.mine ? '' : t.row.min}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
