import { useState } from 'preact/hooks';
import type { TypeChart } from '../schema.ts';
import TypeChip from './TypeChip.tsx';
import type { DexIndex } from './lib/dex.ts';
import type { MetaSet } from './lib/metasets.ts';
import { pct } from '../../../core/format.ts';
import {
  multiplierLabel,
  sharedWeaknesses,
  teamCoverage,
  teamDefenseMatrix,
  type AttackMove,
  type MemberTyping,
} from './lib/types.ts';
import { ladderPosition, speedLadder, type ThreatRow, type ThreatSummary } from './lib/teamview.ts';

export interface PanelMember extends MemberTyping {
  /** Slot key. */
  id: string;
  speed: number;
}

/** "Garchomp, Gholdengo and Incineroar". */
export function nameList(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

// ---- defensive type matrix -----------------------------------------------------------------------

export function TypeMatrix({ chart, members }: { chart: TypeChart; members: readonly PanelMember[] }) {
  const rows = teamDefenseMatrix(chart, members);
  const holes = sharedWeaknesses(rows);
  const holeSet = new Set(holes.map((h) => h.type));
  return (
    <div class="pk-section" style="gap: var(--sp-3)">
      {holes.length > 0 ? (
        <p class="pk-issue" data-level="warning">
          <span class="pk-issue__tag">Watch</span>
          <span>
            Shared weakness{holes.length > 1 ? 'es' : ''}: {holes.map((h) => `${h.type} (${h.weak} weak, nothing resists)`).join('; ')}.
          </span>
        </p>
      ) : (
        <p class="pk-issue" data-level="ok">
          <span class="pk-issue__tag">OK</span>
          <span>No type hits two or more of your Pokémon without one of them resisting it.</span>
        </p>
      )}
      <div class="pk-scroll" tabindex={0} role="region" aria-label="Weakness matrix (scrolls sideways)">
        <table class="pk-table pk-matrix">
          <caption class="visually-hidden">Damage each attacking type does to each of your Pokémon. ×2 and ×4 are weaknesses; ×½, ×¼ and ×0 are resistances and immunities.</caption>
          <thead>
            <tr>
              <th scope="col">Attack</th>
              {members.map((m) => (
                <th scope="col" key={m.id}>
                  <span class="pk-matrix__member" title={m.name}>
                    {m.name}
                  </span>
                </th>
              ))}
              <th scope="col">Weak</th>
              <th scope="col">Resist</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.type} data-hole={holeSet.has(r.type) ? 'true' : undefined}>
                <th scope="row">
                  <TypeChip type={r.type} small />
                </th>
                {r.cells.map((c) => (
                  <td key={c.id} data-m={c.multiplier === 1 ? undefined : String(c.multiplier)} title={c.byAbility ? 'Changed by ability' : undefined}>
                    {c.multiplier === 1 ? <span class="pk-subtle" aria-label="neutral">·</span> : multiplierLabel(c.multiplier)}
                    {c.byAbility ? <span aria-label=" (ability)">*</span> : null}
                  </td>
                ))}
                <td class="pk-num">{r.weak || ''}</td>
                <td class="pk-num">{r.resist + r.immune || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="pk-subtle">* changed by the Pokémon's ability (Levitate, Flash Fire, Thick Fat…). Megas use their Mega typing and ability.</p>
    </div>
  );
}

// ---- offensive coverage -------------------------------------------------------------------------

export function Coverage({ chart, attacks, names, dex }: { chart: TypeChart; attacks: readonly AttackMove[]; names: Record<string, string>; dex: DexIndex }) {
  if (attacks.length === 0) return <p class="pk-subtle">Add damaging moves to see which types your team hits super-effectively.</p>;
  const cells = teamCoverage(chart, attacks);
  const gaps = cells.filter((c) => c.best <= 1);
  return (
    <div class="pk-section" style="gap: var(--sp-3)">
      <p class="pk-status">
        {gaps.length === 0
          ? 'Every type takes super-effective damage from at least one of your moves.'
          : `No super-effective move against ${nameList(gaps.map((g) => g.type))}.`}
      </p>
      <ul class="pk-cover" aria-label="Best multiplier against each type">
        {cells.map((c) => {
          const via = c.via.slice(0, 2).map((a) => `${dex.moveName(a.move.id)} (${names[a.member] ?? a.member})`);
          const text =
            c.best === 0 ? 'Nothing hits it' : c.best < 1 ? 'Every move is resisted' : c.best === 1 ? 'Neutral hits only' : via.join(', ') + (c.via.length > 2 ? ` +${c.via.length - 2}` : '');
          return (
            <li key={c.type} data-best={c.best <= 1 ? 'weak' : undefined}>
              <span class="pk-cover__top">
                <TypeChip type={c.type} small />
                <strong class="pk-num">{multiplierLabel(c.best)}</strong>
              </span>
              <span class="pk-subtle">{text}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ---- speed vs the top 50 ------------------------------------------------------------------------

export function SpeedPanel({ members, sets, usageLabel }: { members: readonly PanelMember[]; sets: readonly MetaSet[]; usageLabel: string | null }) {
  const [tailwind, setTailwind] = useState(false);
  const [trickRoom, setTrickRoom] = useState(false);
  if (sets.length === 0) return <p class="pk-subtle">Speed comparisons need ladder usage data, which is still warming up for this regulation.</p>;
  const ladder = speedLadder(
    members.map((m) => ({ key: m.id, name: m.name, speed: m.speed })),
    sets,
    { tailwind, trickRoom },
  );
  return (
    <div class="pk-section" style="gap: var(--sp-3)">
      <div class="pk-actions" role="group" aria-label="Speed conditions">
        <label class="pk-check">
          <input type="checkbox" checked={tailwind} onChange={(e) => setTailwind((e.currentTarget as HTMLInputElement).checked)} />
          Your Tailwind (×2)
        </label>
        <label class="pk-check">
          <input type="checkbox" checked={trickRoom} onChange={(e) => setTrickRoom((e.currentTarget as HTMLInputElement).checked)} />
          Trick Room (slowest first)
        </label>
      </div>
      <div class="pk-scroll">
        <table class="pk-table pk-speedsum">
          <caption class="visually-hidden">Your Pokémon's Speed and how many of the top {sets.length} they move before</caption>
          <thead>
            <tr>
              <th scope="col">Pokémon</th>
              <th scope="col" class="pk-num">Speed</th>
              <th scope="col" class="pk-num">Moves before</th>
              <th scope="col" class="pk-num">Ties</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => {
              const pos = ladderPosition(ladder, m.id, trickRoom);
              const row = ladder.find((r) => r.key === m.id);
              return (
                <tr key={m.id}>
                  <th scope="row">{m.name}</th>
                  <td class="pk-num">{row?.speed ?? m.speed}</td>
                  <td class="pk-num">
                    {pos.before} <span class="pk-subtle">of {pos.total}</span>
                  </td>
                  <td class="pk-num">{pos.ties || '–'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <details class="pk-details">
        <summary>Full speed ladder ({ladder.length} rows)</summary>
        <ol class="pk-ladder">
          {ladder.map((r) => (
            <li key={r.key} data-mine={r.mine ? 'true' : undefined}>
              <span class="pk-num">{r.speed}</span>
              <span>
                {r.name}
                {r.mine ? <span class="badge badge--accent">Yours</span> : null}
              </span>
            </li>
          ))}
        </ol>
      </details>
      <p class="pk-subtle">Top Pokémon at their most common spread{usageLabel ? ` (${usageLabel})` : ''}; no Scarf, paralysis or stat changes. Equal speeds move in random order.</p>
    </div>
  );
}

// ---- threats ------------------------------------------------------------------------------------

function hitText(hits: number, chance: number, from: number, to: number): string {
  const range = `${from}–${to}%`;
  if (hits === 1) return `${range}, ${chance >= 1 ? 'OHKO' : `${Math.round(chance * 100)}% OHKO`}`;
  if (hits === 2) return `${range}, 2HKO`;
  return range;
}

function ThreatCard({ row, names }: { row: ThreatRow; names: Record<string, string> }) {
  const w = row.worst;
  return (
    <li class="pk-card" data-threat={row.unanswered ? 'unanswered' : undefined}>
      <div class="pk-card__head">
        <span class="pk-card__name">
          {row.name} <span class="pk-subtle">#{row.rank} · {pct(row.usage, 0)}</span>
        </span>
        {row.unanswered && <span class="badge badge--negative">No answer</span>}
      </div>
      <p class="pk-breakdown">
        <span>OHKOs {row.ohko}</span>
        <span>2HKOs {row.twoHko}</span>
        <span>Outspeeds {row.outspeeds}</span>
        <span>Answers {row.answers.length}</span>
      </p>
      {w && (
        <p class="pk-subtle">
          Worst hit: {w.result.moveName} into {names[w.member] ?? w.member} ({hitText(w.hits, w.result.koChance, w.result.minPct, w.result.maxPct)})
        </p>
      )}
      <p class="pk-subtle">
        {row.answers.length === 0
          ? 'None of your Pokémon 2HKOs its common set.'
          : `Answers: ${row.answers
              .slice(0, 3)
              .map((a) => `${names[a.member] ?? a.member} (${a.result.moveName}, ${a.hits === 1 ? 'OHKO' : '2HKO'})`)
              .join(', ')}${row.answers.length > 3 ? ` +${row.answers.length - 3}` : ''}`}
      </p>
    </li>
  );
}

export function ThreatPanel({ summary, names, show = 10 }: { summary: ThreatSummary; names: Record<string, string>; show?: number }) {
  const [all, setAll] = useState(false);
  const rows = all ? summary.rows : summary.rows.slice(0, show);
  const unanswered = summary.rows.filter((r) => r.unanswered);
  return (
    <div class="pk-section" style="gap: var(--sp-3)">
      <p class="pk-status">
        {unanswered.length === 0
          ? 'Every common set that pressures two or more of your Pokémon has an answer that 2HKOs it.'
          : `${unanswered.length} common set${unanswered.length > 1 ? 's' : ''} pressure${unanswered.length > 1 ? '' : 's'} your team with no 2HKO answer: ${nameList(unanswered.slice(0, 4).map((r) => r.name))}${unanswered.length > 4 ? ' and more' : ''}.`}
      </p>
      <ol class="pk-cards pk-threats">
        {rows.map((r) => (
          <ThreatCard row={r} names={names} key={r.id} />
        ))}
      </ol>
      {summary.rows.length > show && (
        <button type="button" class="btn btn--sm btn--ghost" aria-expanded={all ? 'true' : 'false'} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${summary.rows.length}`}
        </button>
      )}
      {summary.skipped.length > 0 && <p class="pk-subtle">The calculator doesn't know {summary.skipped.length} of the common sets yet; they are left out.</p>}
    </div>
  );
}
