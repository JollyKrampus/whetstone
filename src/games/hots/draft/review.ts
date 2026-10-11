/**
 * Finished-draft review (heroescounters' completed-draft summary, roadmap D4/D7): once both
 * teams are locked, the board says what the tool already knows about the result. The strongest
 * cross-team counters in each direction, the best synergy pair per team, map fit per team and
 * the guardrail verdict, plus a plain-text summary to paste into Discord.
 *
 * Same evidence as the suggestions: listable match statistics when a block is in use (n ≥ 50
 * and |Δ| ≥ 1.5 pp, the bar a hero page uses), theory edges otherwise, always labelled.
 */
import { displayScore, valueFromDelta, valueFromScore } from '../../../core/draft.ts';
import { int, pp } from '../../../core/format.ts';
import type { Reason } from '../../../core/game.ts';
import { isListable } from '../../../core/stats.ts';
import {
  statMap,
  statPair,
  theoryCounter,
  theoryMapFit,
  theorySynergy,
  type DraftData,
  type DraftHero,
  type DraftMap,
} from './data.ts';
import { theoryReasons } from './providers.ts';
import { conditionsText } from './suggest.ts';
import { teamSummary, type RoleHero, type TeamSummary } from './roles.ts';

/** Counter edges shown per direction. */
export const REVIEW_COUNTERS = 3;
/** Key matchups in the copied summary. */
export const SUMMARY_MATCHUPS = 3;
/** Edges weaker than this (signal scale; ≈ 0.4 pp) are not worth a line. */
const MIN_VALUE = 0.1;

export interface ReviewPair {
  /** Counters: the hero with the edge. Synergy: either of the pair. */
  a: DraftHero;
  b: DraftHero;
  /** Signal scale (1.0 ≈ a 4 pp edge); positive. */
  value: number;
  /** 1–100 ring for the value. */
  score: number;
  basis: 'stat' | 'theory';
  /** The headline reason (theory line with its conditions, or the statistic). */
  reason: Reason;
}

export interface MapFitRow {
  hero: DraftHero;
  value: number;
  score: number;
  basis: 'stat' | 'theory';
  reason: Reason | null;
}

export interface TeamReview {
  heroes: DraftHero[];
  bans: DraftHero[];
  /** This team's strongest counters against the other team, strongest first. */
  counters: ReviewPair[];
  /** Strongest synergy pair inside the team. */
  synergy: ReviewPair | null;
  /** Fit for the chosen map, best first (heroes with no edge for the map left out). */
  mapFit: MapFitRow[];
  summary: TeamSummary;
  /** No guardrail problems. */
  sound: boolean;
}

export interface DraftReview {
  map: DraftMap | null;
  ours: TeamReview;
  theirs: TeamReview;
  /** Any line rests on match statistics (their source must be credited with it). */
  usesStats: boolean;
}

export interface ReviewInput {
  ours: readonly string[];
  theirs: readonly string[];
  oursBans: readonly string[];
  theirsBans: readonly string[];
  map?: string;
  /** Use the shard's statistics block (default: whenever it exists). */
  useStats?: boolean;
}

function lookup(data: DraftData, ids: readonly string[]): DraftHero[] {
  return [...new Set(ids)].map((id) => data.byId.get(id)).filter((h): h is DraftHero => h !== undefined);
}

function statReason(text: string, n: number, delta: number, source: string | null): Reason {
  const r: Reason = { kind: 'stat', text, n, delta: Math.round(delta * 10) / 10 };
  if (source) r.source = source;
  return r;
}

/** How much `a` counters `b` (net of b's theory edge back), or null when not clearly. */
export function counterEdge(data: DraftData, useStats: boolean, a: DraftHero, b: DraftHero): ReviewPair | null {
  if (useStats) {
    const st = statPair(data, 'counters', a.index, b.index);
    if (st) {
      if (!isListable(st.n, st.delta) || st.delta <= 0) return null;
      const value = valueFromDelta(st.delta);
      return { a, b, value, score: displayScore(value), basis: 'stat', reason: statReason(`Beats ${b.name}`, st.n, st.delta, data.statsSource) };
    }
  }
  const fwd = theoryCounter(data, a.index, b.index);
  if (!fwd) return null;
  const rev = theoryCounter(data, b.index, a.index);
  const value = valueFromScore(fwd.score) - (rev ? valueFromScore(rev.score) : 0);
  const headline = theoryReasons(fwd)[0];
  if (value < MIN_VALUE || !headline) return null;
  return { a, b, value, score: displayScore(value), basis: 'theory', reason: headline };
}

function synergyEdge(data: DraftData, useStats: boolean, a: DraftHero, b: DraftHero): ReviewPair | null {
  if (useStats) {
    const st = statPair(data, 'synergies', a.index, b.index);
    if (st) {
      if (!isListable(st.n, st.delta) || st.delta <= 0) return null;
      const value = valueFromDelta(st.delta);
      return { a, b, value, score: displayScore(value), basis: 'stat', reason: statReason(`${a.name} and ${b.name} win together`, st.n, st.delta, data.statsSource) };
    }
  }
  const t = theorySynergy(data, a.index, b.index);
  const headline = t ? theoryReasons(t)[0] : undefined;
  if (!t || !headline) return null;
  const value = valueFromScore(t.score);
  return value < MIN_VALUE ? null : { a, b, value, score: displayScore(value), basis: 'theory', reason: headline };
}

function mapRow(data: DraftData, useStats: boolean, hero: DraftHero, map: DraftMap): MapFitRow | null {
  if (useStats) {
    const st = statMap(data, hero.index, map.index);
    if (st) {
      const value = valueFromDelta(st.delta);
      const text = isListable(st.n, st.delta) ? (st.delta >= 0 ? `Does well on ${map.name}` : `Weaker on ${map.name}`) : `${pp(st.delta)} on ${map.name}: too small to call`;
      return { hero, value, score: displayScore(value), basis: 'stat', reason: statReason(text, st.n, st.delta, data.statsSource) };
    }
  }
  const t = theoryMapFit(data, hero.index, map.index);
  if (!t) return null;
  const value = valueFromScore(t.score);
  return { hero, value, score: displayScore(value), basis: 'theory', reason: theoryReasons(t)[0] ?? null };
}

const byValue = (x: { value: number }, y: { value: number }) => y.value - x.value;

function teamReview(data: DraftData, useStats: boolean, team: DraftHero[], bans: DraftHero[], other: DraftHero[], map: DraftMap | null): TeamReview {
  const counters: ReviewPair[] = [];
  for (const a of team) for (const b of other) {
    const e = counterEdge(data, useStats, a, b);
    if (e) counters.push(e);
  }
  counters.sort((x, y) => byValue(x, y) || x.a.index - y.a.index || x.b.index - y.b.index);
  let synergy: ReviewPair | null = null;
  for (let i = 0; i < team.length; i++) {
    for (let j = i + 1; j < team.length; j++) {
      const e = synergyEdge(data, useStats, team[i]!, team[j]!);
      if (e && (!synergy || e.value > synergy.value)) synergy = e;
    }
  }
  const mapFit = map
    ? team
        .map((h) => mapRow(data, useStats, h, map))
        .filter((r): r is MapFitRow => r !== null)
        .sort((x, y) => byValue(x, y) || x.hero.index - y.hero.index)
    : [];
  const roleTeam: RoleHero[] = team;
  const summary = teamSummary(roleTeam, [], 0);
  return { heroes: team, bans, counters: counters.slice(0, REVIEW_COUNTERS), synergy, mapFit, summary, sound: summary.problems.length === 0 };
}

/** Review a finished draft from our side. */
export function reviewDraft(data: DraftData, input: ReviewInput): DraftReview {
  const useStats = (input.useStats ?? data.stats !== null) && data.stats !== null;
  const ours = lookup(data, input.ours);
  const theirs = lookup(data, input.theirs);
  const map = input.map ? (data.mapById.get(input.map) ?? null) : null;
  const a = teamReview(data, useStats, ours, lookup(data, input.oursBans), theirs, map);
  const b = teamReview(data, useStats, theirs, lookup(data, input.theirsBans), ours, map);
  const all = [...a.counters, ...b.counters, ...(a.synergy ? [a.synergy] : []), ...(b.synergy ? [b.synergy] : []), ...a.mapFit, ...b.mapFit];
  return { map, ours: a, theirs: b, usesStats: all.some((x) => x.basis === 'stat') };
}

export interface SummaryOptions {
  /** Team labels (default "You" / "Enemy"). */
  names?: { ours: string; theirs: string };
  /** Shareable link to this draft. */
  url?: string;
  /** Statistics label ("Storm League · 2.57 …") when statistics are in use. */
  statsLabel?: string | null;
  /** Credit line for the statistics' source (it must travel with copied numbers). */
  statsCredit?: string | null;
}

/** The key matchups across both teams, strongest first. */
export function keyMatchups(review: DraftReview, max = SUMMARY_MATCHUPS): { pair: ReviewPair; side: 'ours' | 'theirs' }[] {
  return [
    ...review.ours.counters.map((pair) => ({ pair, side: 'ours' as const })),
    ...review.theirs.counters.map((pair) => ({ pair, side: 'theirs' as const })),
  ]
    .sort((x, y) => byValue(x.pair, y.pair) || (x.side === y.side ? 0 : x.side === 'ours' ? -1 : 1))
    .slice(0, max);
}

function reasonLine(r: Reason): string {
  const cond = conditionsText(r);
  const stat = r.kind === 'stat' && r.delta !== undefined ? ` (${pp(r.delta)}${r.n !== undefined ? `, n = ${int(r.n)}` : ''})` : '';
  return `${r.text}${stat}${cond ? ` Only when ${cond}` : ''}`;
}

/** Plain text for chat (Discord-friendly: one line per item, "-" bullets, no markup beyond that). */
export function reviewText(review: DraftReview, opts: SummaryOptions = {}): string {
  const names = opts.names ?? { ours: 'You', theirs: 'Enemy' };
  const team = (t: TeamReview) => `${t.heroes.map((h) => h.name).join(', ') || 'no picks'}${t.bans.length ? ` (bans: ${t.bans.map((h) => h.name).join(', ')})` : ''}`;
  const lines = [`Draft review${review.map ? ` · ${review.map.name}` : ''}`, `${names.ours}: ${team(review.ours)}`, `${names.theirs}: ${team(review.theirs)}`];
  const key = keyMatchups(review);
  if (key.length) {
    lines.push('Key matchups:');
    for (const { pair, side } of key) {
      const label = side === 'ours' ? names.ours : names.theirs;
      lines.push(`- ${pair.a.name} (${label}) vs ${pair.b.name}: ${reasonLine(pair.reason)} [${pair.basis} ${pair.score}]`);
    }
  }
  const verdict = (t: TeamReview) => (t.sound ? 'no composition problems' : t.summary.problems.join(' '));
  lines.push(`${names.ours}: ${verdict(review.ours)}`, `${names.theirs}: ${verdict(review.theirs)}`);
  if (review.usesStats && opts.statsLabel) lines.push(`Match statistics: ${opts.statsLabel}.${opts.statsCredit ? ` ${opts.statsCredit}` : ''}`);
  else lines.push('Theory: rules applied to hero kits, not win rates.');
  if (opts.url) lines.push(opts.url);
  return lines.join('\n');
}
