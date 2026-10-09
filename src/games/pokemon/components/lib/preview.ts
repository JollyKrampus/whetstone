/**
 * Team Preview assistant: your 6 against their 6 → which 4 to bring and which 2 to lead, with
 * the reasons. Built on the generic scorer in src/core/draft.ts (scoreCandidates): each piece of
 * evidence is a provider returning signals on the shared logit-like scale (1.0 ≈ a 4 pp edge),
 * presets are weight sets, and every signal carries the reason (with n and source) that explains
 * it.
 *
 * core/draft's SignalKey vocabulary comes from HotS. Pokémon reuses its slots:
 *   counters → head-to-head replay results     theory → type matchups
 *   role     → speed and speed control          map    → damage (calc KO coverage)
 *   synergy  → partner results and teammates   tier   → not used
 *
 * Opponents are weighted by how likely they are to be brought. Without bring-rate data the
 * estimate is usage-based (bringWeights): proportional to usage, capped at 1, summing to four.
 * It is labelled as an estimate in the UI.
 */
import type { Edge, Reason } from '../../../../core/game.ts';
import { scoreCandidates, valueFromDelta, type DraftContext, type Provider, type Ranked, type Signal, type Weights } from '../../../../core/draft.ts';
import { classifySample } from '../../../../core/stats.ts';
import { pct, pp } from '../../../../core/format.ts';
import type { Move, PokemonType, TypeChart } from '../../schema.ts';
import { DEFENSIVE_ABILITIES, TYPE_CHANGING_ABILITIES, effectiveness } from './types.ts';

export type PreviewMove = Pick<Move, 'id' | 'name' | 'type' | 'category' | 'basePower' | 'priority' | 'target'>;

export interface PreviewMon {
  /** Unique within its side (slot key). */
  key: string;
  /** Battle forme id (Mega when holding its stone). */
  species: string;
  /** Registered species id. */
  base: string;
  name: string;
  types: readonly PokemonType[];
  ability?: string;
  speed: number;
  moves: readonly PreviewMove[];
  /** Usage share (0–1) for bring-likelihood; their side only. */
  usage?: number;
  /** Their side: the moves are the most common set, not known for sure. */
  assumed?: boolean;
}

/** Best move of one side into the other, from the calc worker. */
export interface DamageCell {
  move: string;
  moveName: string;
  minPct: number;
  maxPct: number;
  /** 1 = OHKO, 2 = 2HKO, …, 0 = no KO within four hits. */
  koN: number;
  koChance: number;
}

export interface DamageTable {
  /** mine[myKey][theirKey] */
  mine: Record<string, Record<string, DamageCell | null>>;
  /** theirs[theirKey][myKey] */
  theirs: Record<string, Record<string, DamageCell | null>>;
}

export interface PreviewInput {
  mine: readonly PreviewMon[];
  theirs: readonly PreviewMon[];
  chart: TypeChart;
  h2h?: { counters: readonly Edge[]; synergies: readonly Edge[] } | null;
  damage?: DamageTable | null;
}

export type PreviewPresetId = 'balanced' | 'replays' | 'types' | 'speed' | 'damage';

export const PREVIEW_PRESETS: Readonly<Record<PreviewPresetId, { label: string; weights: Weights }>> = {
  balanced: { label: 'Balanced', weights: { counters: 1, theory: 0.6, role: 0.7, map: 1, synergy: 0.5 } },
  replays: { label: 'Replay results', weights: { counters: 1, synergy: 0.5 } },
  types: { label: 'Types', weights: { theory: 1 } },
  speed: { label: 'Speed', weights: { role: 1 } },
  damage: { label: 'Damage', weights: { map: 1 } },
};

export const PREVIEW_PRESET_IDS = Object.keys(PREVIEW_PRESETS) as PreviewPresetId[];

/** Label of the evidence behind each signal key, for the breakdown. */
export const PREVIEW_SIGNAL_LABEL: Readonly<Record<string, string>> = {
  counters: 'Replays',
  theory: 'Types',
  role: 'Speed',
  map: 'Damage',
  synergy: 'Partners',
};

// ---- helpers ---------------------------------------------------------------------------------

const SPEED_CONTROL = new Set(['tailwind', 'trickroom', 'icywind', 'electroweb', 'thunderwave', 'scaryface', 'bulldoze']);
const SPREAD = new Set(['allAdjacentFoes', 'allAdjacent']);
const REDIRECT = new Set(['followme', 'ragepowder']);

export function hasMove(mon: PreviewMon, id: string): boolean {
  return mon.moves.some((m) => m.id === id);
}

function attackTypes(mon: PreviewMon): PokemonType[] {
  const change = mon.ability ? TYPE_CHANGING_ABILITIES[mon.ability] : undefined;
  return [
    ...new Set(
      mon.moves.filter((m) => m.category !== 'Status' && (m.basePower > 0 || m.id === 'bodypress')).map((m) => (change && m.type === 'Normal' ? change : m.type)),
    ),
  ];
}

function bestOffense(chart: TypeChart, attacker: PreviewMon, defender: PreviewMon): number {
  const types = attackTypes(attacker);
  if (types.length === 0) return 1;
  const adjust = defender.ability ? DEFENSIVE_ABILITIES[defender.ability] : undefined;
  return Math.max(...types.map((t) => effectiveness(chart, t, defender.types) * (adjust?.[t] ?? 1)));
}

/** Worst multiplier among the attacker's STAB types against the defender. */
function worstStabAgainst(chart: TypeChart, attacker: PreviewMon, defender: PreviewMon): number {
  const adjust = defender.ability ? DEFENSIVE_ABILITIES[defender.ability] : undefined;
  return Math.max(...attacker.types.map((t) => effectiveness(chart, t, defender.types) * (adjust?.[t] ?? 1)));
}

/**
 * Estimated chance each of their Pokémon is brought: proportional to usage, scaled so the chances
 * add up to the number brought (four, or fewer when fewer are known), never above 1. Capping one
 * Pokémon at 1 hands its excess to the rest in proportion, so the total stays exact.
 */
export function bringWeights(theirs: readonly PreviewMon[]): Map<string, number> {
  const out = new Map<string, number>();
  if (theirs.length === 0) return out;
  const bring = Math.min(4, theirs.length);
  const known = theirs.filter((m) => (m.usage ?? 0) > 0);
  // Pokémon without usage data get the average share of those with it (or an even split).
  const fallback = known.length ? known.reduce((s, m) => s + (m.usage ?? 0), 0) / known.length : 1;
  const raw = new Map(theirs.map((m) => [m.key, (m.usage ?? 0) > 0 ? (m.usage as number) : fallback]));
  const capped = new Set<string>();
  for (;;) {
    const open = theirs.filter((m) => !capped.has(m.key));
    const mass = open.reduce((s, m) => s + raw.get(m.key)!, 0);
    const scale = mass > 0 ? (bring - capped.size) / mass : 0;
    const over = open.filter((m) => raw.get(m.key)! * scale >= 1);
    if (over.length === 0 || open.length === over.length) {
      for (const m of theirs) out.set(m.key, capped.has(m.key) ? 1 : Math.min(1, raw.get(m.key)! * scale));
      return out;
    }
    for (const m of over) capped.add(m.key);
  }
}

function edgeIndex(edges: readonly Edge[] | undefined): Map<string, Edge> {
  const map = new Map<string, Edge>();
  for (const e of edges ?? []) map.set(`${e.a}>${e.b}`, e);
  return map;
}

const idsOf = (m: PreviewMon): string[] => (m.species === m.base ? [m.species] : [m.species, m.base]);

function findEdge(index: Map<string, Edge>, a: PreviewMon, b: PreviewMon, undirected = false): Edge | undefined {
  for (const x of idsOf(a)) {
    for (const y of idsOf(b)) {
      const e = index.get(`${x}>${y}`) ?? (undirected ? index.get(`${y}>${x}`) : undefined);
      if (e) return e;
    }
  }
  return undefined;
}

/** Sample-size factor: hidden below 15 games, half weight while greyed (15–29). */
function sampleFactor(n: number | undefined): number {
  if (n === undefined) return 0;
  const c = classifySample(n);
  return c === 'hidden' ? 0 : c === 'grey' ? 0.5 : 1;
}

const names = (list: readonly PreviewMon[]): string => {
  const ns = list.map((m) => m.name);
  if (ns.length <= 2) return ns.join(' and ');
  return `${ns.slice(0, -1).join(', ')} and ${ns.at(-1)}`;
};

// ---- providers -------------------------------------------------------------------------------

interface Built {
  mine: Map<string, PreviewMon>;
  theirs: readonly PreviewMon[];
  weights: Map<string, number>;
  counters: Map<string, Edge>;
  synergies: Map<string, Edge>;
}

function h2hProvider(b: Built): Provider {
  return (key) => {
    const me = b.mine.get(key);
    if (!me) return null;
    const out: Signal[] = [];
    for (const o of b.theirs) {
      const e = findEdge(b.counters, me, o);
      if (!e || e.delta === undefined) continue;
      const f = sampleFactor(e.n) * (b.weights.get(o.key) ?? 0);
      if (f === 0) continue;
      const better = e.delta >= 0;
      const reason: Reason = {
        kind: 'stat',
        text: better ? `Teams with ${me.name} win more often against ${o.name}` : `Teams with ${me.name} win less often against ${o.name}`,
        delta: e.delta,
        source: 'showdown-replays',
      };
      if (e.n !== undefined) reason.n = e.n;
      out.push({ key: 'counters', value: valueFromDelta(e.delta) * f, reasons: [reason] });
    }
    return out;
  };
}

function typeProvider(b: Built, chart: TypeChart): Provider {
  return (key) => {
    const me = b.mine.get(key);
    if (!me) return null;
    let offense = 0;
    let defense = 0;
    const hits: PreviewMon[] = [];
    const walls: PreviewMon[] = [];
    const threatened: PreviewMon[] = [];
    const safe: PreviewMon[] = [];
    for (const o of b.theirs) {
      const w = b.weights.get(o.key) ?? 0;
      const off = bestOffense(chart, me, o);
      if (off >= 4) offense += 0.4 * w;
      else if (off >= 2) offense += 0.25 * w;
      else if (off === 0) offense -= 0.25 * w;
      else if (off < 1) offense -= 0.15 * w;
      if (off >= 2) hits.push(o);
      if (off < 1) walls.push(o);
      const def = worstStabAgainst(chart, o, me);
      if (def >= 4) defense -= 0.4 * w;
      else if (def >= 2) defense -= 0.25 * w;
      else if (def === 0) defense += 0.25 * w;
      else if (def < 1) defense += 0.15 * w;
      if (def >= 2) threatened.push(o);
      if (def < 1) safe.push(o);
    }
    const out: Signal[] = [];
    if (offense !== 0) {
      const text =
        offense > 0
          ? `Super-effective coverage on ${names(hits)}`
          : `Resisted or blocked by ${names(walls)}`;
      out.push({ key: 'theory', value: offense, reasons: [{ kind: 'theory', text, source: 'showdown' }] });
    }
    if (defense !== 0) {
      const text =
        defense > 0 ? `Resists the main attacking types of ${names(safe)}` : `Weak to the main attacking types of ${names(threatened)}`;
      out.push({ key: 'theory', value: defense, reasons: [{ kind: 'theory', text, source: 'showdown' }] });
    }
    return out;
  };
}

function speedProvider(b: Built): Provider {
  return (key, ctx: DraftContext) => {
    const me = b.mine.get(key);
    if (!me) return null;
    const out: Signal[] = [];
    let total = 0;
    let faster = 0;
    const outsped: PreviewMon[] = [];
    for (const o of b.theirs) {
      const w = b.weights.get(o.key) ?? 0;
      total += w;
      if (me.speed > o.speed) {
        faster += w;
        outsped.push(o);
      }
    }
    if (total > 0) {
      const share = faster / total;
      const value = (share - 0.5) * 0.4;
      if (Math.abs(value) > 0.01) {
        out.push({
          key: 'role',
          value,
          reasons: [
            {
              kind: 'role',
              text: share > 0.5 ? `Outspeeds ${names(outsped)} (Speed ${me.speed})` : `Slower than most of their team (Speed ${me.speed})`,
            },
          ],
        });
      }
    }
    // Speed control is worth more when the speed race is going the wrong way.
    const allies = ctx.allies.map((k) => b.mine.get(k)).filter((m): m is PreviewMon => Boolean(m));
    const team = [me, ...allies];
    const ourAvg = team.reduce((s, m) => s + m.speed, 0) / team.length;
    const theirAvg = b.theirs.length ? b.theirs.reduce((s, m) => s + m.speed, 0) / b.theirs.length : ourAvg;
    if (hasMove(me, 'tailwind') && theirAvg > ourAvg) {
      out.push({ key: 'role', value: 0.3, reasons: [{ kind: 'role', text: `Tailwind: their team is faster on average (${Math.round(theirAvg)} vs ${Math.round(ourAvg)})` }] });
    }
    if (hasMove(me, 'trickroom') && ourAvg < theirAvg) {
      out.push({ key: 'role', value: 0.35, reasons: [{ kind: 'role', text: `Trick Room flips a speed race you lose (${Math.round(ourAvg)} vs ${Math.round(theirAvg)} on average)` }] });
    }
    if (me.ability === 'intimidate') {
      const physical = b.theirs.filter((o) => o.moves.some((m) => m.category === 'Physical' && m.basePower > 0));
      if (physical.length >= 2) {
        out.push({ key: 'role', value: 0.05 * physical.length, reasons: [{ kind: 'role', text: `Intimidate weakens ${physical.length} physical attackers` }] });
      }
    }
    return out;
  };
}

/** "OHKOs" / "2HKOs", or the damage range. */
function koVerb(c: DamageCell): string {
  if (c.koN === 1) return 'OHKOs';
  if (c.koN === 2) return '2HKOs';
  return `does ${c.minPct}–${c.maxPct}% to`;
}

/** " (88% chance)" for a KO that isn't guaranteed. */
function koChanceText(c: DamageCell): string {
  return (c.koN === 1 || c.koN === 2) && c.koChance < 1 ? ` (${Math.round(c.koChance * 100)}% chance)` : '';
}

function damageProvider(b: Built, damage: DamageTable): Provider {
  return (key) => {
    const me = b.mine.get(key);
    if (!me) return null;
    const out: Signal[] = [];
    let offense = 0;
    const kos: string[] = [];
    let defense = 0;
    const dangers: string[] = [];
    for (const o of b.theirs) {
      const w = b.weights.get(o.key) ?? 0;
      const mine = damage.mine[key]?.[o.key];
      if (mine) {
        const v = mine.koN === 1 ? 0.5 * Math.max(0.5, mine.koChance) : mine.koN === 2 ? 0.25 * Math.max(0.5, mine.koChance) : 0;
        offense += v * w;
        if (mine.koN === 1 || mine.koN === 2) kos.push(`${mine.moveName} ${koVerb(mine)} ${o.name}${koChanceText(mine)}`);
      }
      const theirs = damage.theirs[o.key]?.[key];
      if (theirs) {
        const v = theirs.koN === 1 ? 0.5 * Math.max(0.5, theirs.koChance) : theirs.koN === 2 ? 0.12 : 0;
        defense -= v * w;
        if (theirs.koN === 1) dangers.push(`${o.name}'s ${theirs.moveName}${koChanceText(theirs)}`);
      }
    }
    if (offense > 0) {
      out.push({ key: 'map', value: offense, reasons: [{ kind: 'stat', text: `${kos.slice(0, 2).join('; ')}${kos.length > 2 ? `; +${kos.length - 2} more` : ''}`, source: 'smogon-calc' }] });
    }
    if (defense < 0) {
      out.push({
        key: 'map',
        value: defense,
        reasons: [{ kind: 'stat', text: dangers.length ? `Can be OHKOed by ${dangers.slice(0, 2).join(' or ')}` : 'Takes heavy damage from their common sets', source: 'smogon-calc' }],
      });
    }
    return out;
  };
}

function synergyProvider(b: Built): Provider {
  return (key, ctx: DraftContext) => {
    const me = b.mine.get(key);
    if (!me) return null;
    const out: Signal[] = [];
    for (const allyKey of ctx.allies) {
      const ally = b.mine.get(allyKey);
      if (!ally) continue;
      const e = findEdge(b.synergies, me, ally, true);
      if (!e || e.delta === undefined) continue;
      const f = sampleFactor(e.n);
      if (f === 0) continue;
      const reason: Reason = { kind: 'stat', text: `Pairs well with ${ally.name} in replays`, delta: e.delta, source: 'showdown-replays' };
      if (e.n !== undefined) reason.n = e.n;
      // Spread over the allies: a partner only matters if both are brought.
      out.push({ key: 'synergy', value: (valueFromDelta(e.delta) * f) / Math.max(1, ctx.allies.length / 3), reasons: [reason] });
    }
    return out;
  };
}

// ---- recommendation --------------------------------------------------------------------------

export interface LeadPlan {
  leads: [string, string];
  back: string[];
  reasons: string[];
}

export interface PreviewResult {
  ranked: Ranked[];
  /** Keys of the recommended four, best first. */
  bring: string[];
  /** Why this four over the alternatives. */
  bringNotes: string[];
  lead: LeadPlan | null;
  /** Their side with estimated bring chance, most likely first. */
  theirBring: { key: string; weight: number }[];
}

function combinations<T>(items: readonly T[], k: number): T[][] {
  const out: T[][] = [];
  const pick = (start: number, acc: T[]) => {
    if (acc.length === k) {
      out.push([...acc]);
      return;
    }
    for (let i = start; i < items.length; i++) pick(i + 1, [...acc, items[i]!]);
  };
  pick(0, []);
  return out;
}

function pairSynergy(b: Built, x: PreviewMon, y: PreviewMon): number {
  const e = findEdge(b.synergies, x, y, true);
  if (!e || e.delta === undefined) return 0;
  return valueFromDelta(e.delta) * sampleFactor(e.n);
}

function leadBonus(x: PreviewMon, y: PreviewMon): { value: number; notes: string[] } {
  let value = 0;
  const notes: string[] = [];
  const pair = [x, y];
  const fakeOut = pair.filter((m) => hasMove(m, 'fakeout'));
  if (fakeOut.length) {
    value += 0.25;
    notes.push(`${fakeOut[0]!.name} has Fake Out for a free first turn`);
  }
  const control = pair.filter((m) => m.moves.some((mv) => SPEED_CONTROL.has(mv.id)));
  if (control.length) {
    value += 0.2;
    const mv = control[0]!.moves.find((m) => SPEED_CONTROL.has(m.id))!;
    notes.push(`${control[0]!.name} sets up ${mv.name} on turn one`);
  }
  const redirect = pair.filter((m) => m.moves.some((mv) => REDIRECT.has(mv.id)));
  if (redirect.length) {
    value += 0.1;
    notes.push(`${redirect[0]!.name} can redirect attacks`);
  }
  const spread = pair.filter((m) => m.moves.some((mv) => mv.category !== 'Status' && SPREAD.has(mv.target)));
  if (spread.length) {
    value += 0.1 * spread.length;
    notes.push(`${names(spread)} ${spread.length > 1 ? 'have' : 'has a'} spread move${spread.length > 1 ? 's' : ''} to pressure both foes`);
  }
  if (control.length && fakeOut.length && control[0] !== fakeOut[0]) value += 0.1;
  return { value, notes };
}

/**
 * Rank your six, pick the best four (individual scores plus partner results, avoiding four
 * Pokémon that share a weakness) and the best lead pair among them.
 */
export function recommend(input: PreviewInput, preset: PreviewPresetId = 'balanced'): PreviewResult {
  const weightsBring = bringWeights(input.theirs);
  const b: Built = {
    mine: new Map(input.mine.map((m) => [m.key, m])),
    theirs: input.theirs,
    weights: weightsBring,
    counters: edgeIndex(input.h2h?.counters),
    synergies: edgeIndex(input.h2h?.synergies),
  };
  const providers: Provider[] = [h2hProvider(b), typeProvider(b, input.chart), speedProvider(b), synergyProvider(b)];
  if (input.damage) providers.push(damageProvider(b, input.damage));
  const weights = PREVIEW_PRESETS[preset].weights;

  const keys = input.mine.map((m) => m.key);
  const ranked = keys.length
    ? scoreCandidates(
        {
          candidates: keys,
          context: {
            team: 'A',
            action: 'pick',
            allies: keys,
            enemies: input.theirs.map((m) => m.key),
            bans: [],
            picksLeft: 4,
            enemyPicksLeft: 4,
          },
        },
        // Each candidate's allies are the rest of your six.
        providers.map((p) => (id: string, ctx: DraftContext) => p(id, { ...ctx, allies: keys.filter((k) => k !== id) })),
        weights,
      )
    : [];

  const theirBring = [...weightsBring.entries()]
    .map(([key, weight]) => ({ key, weight }))
    .sort((x, y) => y.weight - x.weight || (x.key < y.key ? -1 : 1));

  if (ranked.length === 0) return { ranked, bring: [], bringNotes: [], lead: null, theirBring };

  const raw = new Map(ranked.map((r) => [r.id, r.raw]));
  const synergyWeight = weights.synergy ?? 0;
  const size = Math.min(4, ranked.length);
  let best: { combo: string[]; total: number } | null = null;
  for (const combo of combinations(ranked.map((r) => r.id), size)) {
    let total = combo.reduce((s, k) => s + (raw.get(k) ?? 0), 0);
    const mons = combo.map((k) => b.mine.get(k)!);
    for (let i = 0; i < mons.length; i++) for (let j = i + 1; j < mons.length; j++) total += synergyWeight * 0.5 * pairSynergy(b, mons[i]!, mons[j]!);
    // Penalise a four that shares one weakness with nothing to switch into.
    const theory = weights.theory ?? 0;
    if (theory > 0) {
      for (const type of new Set(input.theirs.flatMap((o) => o.types))) {
        const weak = mons.filter((m) => effectiveness(input.chart, type, m.types) > 1).length;
        if (weak >= 3) total -= 0.2 * theory;
      }
    }
    if (!best || total > best.total + 1e-9) best = { combo, total };
  }
  const order = new Map(ranked.map((r, i) => [r.id, i]));
  const bring = [...best!.combo].sort((x, y) => order.get(x)! - order.get(y)!);
  const left = ranked.filter((r) => !bring.includes(r.id));
  const bringNotes: string[] = [];
  const topFour = ranked.slice(0, size).map((r) => r.id);
  if (bring.some((k) => !topFour.includes(k))) {
    bringNotes.push('Swapped one of the top four for a better-fitting partner (partner results and shared weaknesses).');
  }
  for (const r of left) {
    const why = r.warning?.text ?? r.reasons[0]?.text;
    bringNotes.push(`Leave ${b.mine.get(r.id)?.name ?? r.id} in the back.${why ? ` ${why}${/[.!?)]$/.test(why) ? '' : '.'}` : ''}`);
  }

  let lead: LeadPlan | null = null;
  if (bring.length >= 2) {
    let bestLead: { pair: [string, string]; total: number; notes: string[] } | null = null;
    for (const [x, y] of combinations(bring, 2) as [string, string][]) {
      const mx = b.mine.get(x)!;
      const my = b.mine.get(y)!;
      const bonus = leadBonus(mx, my);
      const total = (raw.get(x) ?? 0) + (raw.get(y) ?? 0) + bonus.value + synergyWeight * pairSynergy(b, mx, my);
      if (!bestLead || total > bestLead.total + 1e-9) bestLead = { pair: [x, y], total, notes: bonus.notes };
    }
    const pair = bestLead!.pair;
    lead = { leads: pair, back: bring.filter((k) => !pair.includes(k)), reasons: bestLead!.notes };
    if (lead.reasons.length === 0) lead.reasons.push('Your two highest-scoring picks');
  }

  return { ranked, bring, bringNotes, lead, theirBring };
}

/** "45% likely" text for their side. */
export function bringText(weight: number): string {
  return `${pct(weight, 0)} likely`;
}

/** Δ text for reasons, e.g. "+3.2 pp". */
export const deltaText = pp;
