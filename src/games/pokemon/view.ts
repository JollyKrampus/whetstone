/**
 * View helpers for the Pokémon pages: URLs, outbound links, and conversions from loader data
 * (src/games/pokemon/load.ts) to the shared components' props (MatchupRow, EntityTile, TierRow).
 * Pure and browser-safe; pages call the loader and hand the results in.
 *
 * Score conventions (documented on /pokemon/about/):
 * - Replay head-to-head and partner edges keep their 1–100 score (50 = neutral, SPEC §6).
 * - Smogon "checks": score = 100 × (p − 2·sd), a cautious estimate of how often the checker KOs
 *   or forces out the Pokémon (p and its standard deviation sd come from Smogon).
 * - Smogon teammates: score = round(50 + 50·tanh(ln lift)), lift = share of this Pokémon's teams
 *   that include the teammate ÷ the teammate's overall usage. 50 = paired exactly as often as
 *   its popularity predicts; 1.25× ≈ 61, 2× ≈ 80.
 */
import type { Edge, Reason } from '../../core/game.ts';
import { compact, int, pct, pp } from '../../core/format.ts';
import { classifySample, isListableEdge, wilsonInterval } from '../../core/stats.ts';
import { pokemonTierValue, type TierInput } from '../../core/tiers.ts';
import type { MatchupRow } from '../../components/types.ts';
import { assetHref, navHref } from '../registry.ts';
import type { Species, Tournaments, Usage, UsageEntry } from './schema.ts';
import { formeLabel } from './components/lib/dex.ts';

export type SpeciesLike = Pick<Species, 'id' | 'name' | 'megaOf' | 'forme' | 'baseSpecies'> & { sprite?: string };
export type SpeciesLookup = (id: string) => SpeciesLike | undefined;

/** Id of the page a species lives on (Megas live on their base species' page). */
export function pageIdOf(s: Pick<Species, 'id' | 'megaOf'>): string {
  return s.megaOf ?? s.id;
}

/** /whetstone/pokemon/mon/<base>/ plus #<forme> for Megas (the forme's tab). */
export function monHref(s: Pick<Species, 'id' | 'megaOf'>): string {
  const base = navHref('pokemon', `mon/${pageIdOf(s)}/`);
  return s.megaOf ? `${base}#${s.id}` : base;
}

export function monHrefById(id: string, lookup: SpeciesLookup): string | undefined {
  const s = lookup(id);
  return s ? monHref(s) : undefined;
}

export function spriteHref(s: { sprite?: string } | undefined): string | undefined {
  return s?.sprite ? assetHref('pokemon', s.sprite) : undefined;
}

/** Friendly display name: "Mega Salamence" for Mega formes, the species name otherwise. */
export function displayName(s: SpeciesLike | undefined, fallback = ''): string {
  return s ? formeLabel(s) : fallback;
}

// ---- outbound links (links only, nothing is fetched or copied) -------------------------------

export interface OutboundLink {
  label: string;
  href: string;
  note: string;
}

function smogonSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[’'.:]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

function bulbapediaTitle(name: string): string {
  return encodeURIComponent(`${name.replace(/ /g, '_')}_(Pokémon)`).replace(/%2F/g, '/');
}

export function outboundLinks(s: Pick<Species, 'name' | 'baseSpecies'>, format: string): OutboundLink[] {
  const base = s.baseSpecies ?? s.name;
  return [
    { label: 'Smogon Pokédex', href: `https://www.smogon.com/dex/champions/pokemon/${smogonSlug(s.name)}/`, note: 'Champions dex entry, sets and analyses' },
    { label: 'Pikalytics', href: `https://www.pikalytics.com/pokedex/${format}/${encodeURIComponent(s.name)}`, note: 'Ladder usage and win rates' },
    { label: 'Bulbapedia', href: `https://bulbapedia.bulbagarden.net/wiki/${bulbapediaTitle(base)}`, note: 'Species facts, forms and history' },
    { label: 'Victory Road', href: `https://victoryroad.pro/?s=${encodeURIComponent(base)}`, note: 'VGC news, teams and tournament coverage' },
  ];
}

// ---- usage helpers -----------------------------------------------------------------------------

/** Usage share in percent text: 0.4659 → "46.6%". */
export const usageText = (share: number): string => pct(share, 1);

export interface UsageTrend {
  /** Change in percentage points vs the comparison snapshot. */
  deltaPp: number;
  direction: 'up' | 'down' | 'flat' | 'new';
  label: string;
}

/**
 * Usage change between two snapshots (e.g. this regulation vs the previous one at the same
 * cutoff). Flat inside ±0.5 pp; "new" when the Pokémon had no row before.
 */
export function usageTrend(id: string, current: Pick<Usage, 'pokemon'>, previous: Pick<Usage, 'pokemon'> | null, versus: string): UsageTrend | null {
  if (!previous) return null;
  const now = current.pokemon.find((p) => p.id === id);
  if (!now) return null;
  const before = previous.pokemon.find((p) => p.id === id);
  if (!before) return { deltaPp: now.usage * 100, direction: 'new', label: `New since ${versus}` };
  const deltaPp = (now.usage - before.usage) * 100;
  const direction = deltaPp >= 0.5 ? 'up' : deltaPp <= -0.5 ? 'down' : 'flat';
  return { deltaPp, direction, label: `${pp(deltaPp)} vs ${versus}` };
}

// ---- matchup rows ------------------------------------------------------------------------------

/** 100 × (p − 2·sd), clamped to 1–100. */
export function checkScore(p: number, d: number): number {
  return Math.min(100, Math.max(1, Math.round(100 * (p - 2 * d))));
}

/** round(50 + 50·tanh(ln(share / baseline))), clamped to 1–100; 50 when the baseline is unknown. */
export function teammateScore(share: number, baseline: number): number {
  if (!(share > 0) || !(baseline > 0)) return 50;
  return Math.min(100, Math.max(1, Math.round(50 + 50 * Math.tanh(Math.log(share / baseline)))));
}

interface RowContext {
  lookup: SpeciesLookup;
  /** Smogon cutoff and month, for reason text. */
  label: string;
}

/** Smogon "checks and counters" of `entry` as MatchupRows, strongest check first. */
export function checkRows(entry: UsageEntry, ctx: RowContext): MatchupRow[] {
  const target = ctx.lookup(entry.id);
  const targetName = displayName(target, entry.id);
  return entry.checks
    .map((c) => {
      const s = ctx.lookup(c.id);
      const n = Math.round(c.n);
      const row: MatchupRow = {
        id: c.id,
        name: displayName(s, c.id),
        score: checkScore(c.p, c.d),
        n,
        source: 'usage',
        sourceLabel: 'Smogon',
        lowSample: classifySample(n) !== 'ok',
        reasons: [
          {
            kind: 'usage',
            text: `KOs or forces out ${targetName} in ${pct(c.p, 0)} of encounters (±${pct(c.d, 0)}), ${ctx.label}`,
            n,
            source: 'smogon',
          },
        ],
      };
      const href = s ? monHref(s) : undefined;
      if (href) row.href = href;
      const img = spriteHref(s);
      if (img) row.image = img;
      return row;
    })
    .filter((r) => classifySample(r.n ?? 0) !== 'hidden')
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

/** Teammates of `entry` as MatchupRows scored by lift over the teammate's own usage. */
export function teammateRows(entry: UsageEntry, usage: Pick<Usage, 'pokemon'>, ctx: RowContext): MatchupRow[] {
  const overall = new Map(usage.pokemon.map((p) => [p.id, p.usage]));
  const selfName = displayName(ctx.lookup(entry.id), entry.id);
  return entry.teammates
    .map((t) => {
      const s = ctx.lookup(t.id);
      const base = overall.get(t.id);
      const name = displayName(s, t.id);
      const n = Math.round(entry.raw * t.share);
      const lift = base ? t.share / base : undefined;
      const reason: Reason = {
        kind: 'usage',
        text:
          base !== undefined
            ? `On ${pct(t.share, 0)} of ${selfName} teams; ${name} is on ${pct(base, 0)} of all teams (${lift!.toFixed(2)}× as often), ${ctx.label}`
            : `On ${pct(t.share, 0)} of ${selfName} teams, ${ctx.label}`,
        source: 'smogon',
      };
      const row: MatchupRow = {
        id: t.id,
        name,
        score: base !== undefined ? teammateScore(t.share, base) : 50,
        n,
        source: 'usage',
        sourceLabel: 'Teammate',
        reasons: [reason],
      };
      if (base !== undefined) row.delta = (t.share - base) * 100;
      const href = s ? monHref(s) : undefined;
      if (href) row.href = href;
      const img = spriteHref(s);
      if (img) row.image = img;
      return row;
    })
    .sort((a, b) => b.score - a.score || (a.id < b.id ? -1 : 1));
}

function edgeRow(id: string, edge: Edge, lookup: SpeciesLookup, text: string): MatchupRow {
  const s = lookup(id);
  const reasons: Reason[] = [{ kind: 'stat', text, source: 'showdown-replays', ...(edge.delta !== undefined ? { delta: edge.delta } : {}), ...(edge.n !== undefined ? { n: edge.n } : {}) }];
  const row: MatchupRow = { id, name: displayName(s, id), score: edge.score, source: edge.source, sourceLabel: 'Replays', reasons };
  if (edge.delta !== undefined) row.delta = edge.delta;
  if (edge.n !== undefined) {
    row.n = edge.n;
    row.lowSample = classifySample(edge.n) !== 'ok';
  }
  const href = s ? monHref(s) : undefined;
  if (href) row.href = href;
  const img = spriteHref(s);
  if (img) row.image = img;
  return row;
}

export interface EdgeLists {
  /** Pokémon whose teams beat teams bringing this one (counters to it). */
  counteredBy: MatchupRow[];
  /** Pokémon this one's teams beat. */
  strongAgainst: MatchupRow[];
  /** Partners brought together with a positive result. */
  goodWith: MatchupRow[];
}

/**
 * Replay head-to-head rows for one species id (and its alternative ids, e.g. a base species
 * page also showing its Mega). Hidden below n = 15; headline lists need n ≥ 50 and |Δ| ≥ 1.5 pp
 * (isListableEdge), weaker rows are dropped rather than shown as findings.
 */
export function edgeLists(ids: readonly string[], h2h: { counters: readonly Edge[]; synergies: readonly Edge[] } | null, lookup: SpeciesLookup): EdgeLists {
  const out: EdgeLists = { counteredBy: [], strongAgainst: [], goodWith: [] };
  if (!h2h) return out;
  const mine = new Set(ids);
  const byScore = (a: MatchupRow, b: MatchupRow) => b.score - a.score || (a.id < b.id ? -1 : 1);
  for (const e of h2h.counters) {
    if (!isListableEdge(e)) continue;
    if (mine.has(e.b) && (e.delta ?? 0) > 0) {
      const name = displayName(lookup(e.a), e.a);
      out.counteredBy.push(edgeRow(e.a, e, lookup, `Teams with ${name} beat teams bringing ${displayName(lookup(e.b), e.b)} more often than expected`));
    }
    if (mine.has(e.a) && (e.delta ?? 0) > 0) {
      out.strongAgainst.push(edgeRow(e.b, e, lookup, `Beats teams bringing ${displayName(lookup(e.b), e.b)} more often than expected`));
    }
  }
  for (const e of h2h.synergies) {
    if (!isListableEdge(e) || (e.delta ?? 0) <= 0) continue;
    const other = mine.has(e.a) ? e.b : mine.has(e.b) ? e.a : null;
    if (!other) continue;
    out.goodWith.push(edgeRow(other, e, lookup, `Wins more often when brought together with ${displayName(lookup(other), other)}`));
  }
  out.counteredBy.sort(byScore);
  out.strongAgainst.sort(byScore);
  out.goodWith.sort(byScore);
  return out;
}

// ---- tiers -------------------------------------------------------------------------------------

export interface TierSourceRow {
  id: string;
  usagePct: number;
  n: number;
  wins?: number;
  games?: number;
  /** Human text for the item ("46.6% · n 94k"). */
  note: string;
  wrNote?: string;
}

/** Ladder tiers: Smogon usage %, adjusted by tournament win rate where the Wilson interval excludes 50 %. */
export function ladderTierRows(usage: Usage, tournaments: Tournaments | null): TierSourceRow[] {
  const wr = new Map((tournaments?.species ?? []).map((s) => [s.id, s]));
  return usage.pokemon.map((p) => {
    const t = wr.get(p.id);
    const games = t ? t.wins + t.losses + t.ties : 0;
    const row: TierSourceRow = { id: p.id, usagePct: p.usage * 100, n: p.raw, note: `${pct(p.usage, 1)} · n ${compact(p.raw)}` };
    if (t && games > 0) {
      row.wins = t.wins + t.ties / 2;
      row.games = games;
      row.wrNote = wrNote(row.wins, games);
    }
    return row;
  });
}

/** Tournament tiers: share of Limitless teams, adjusted by the same win-rate rule; n = teams. */
export function tournamentTierRows(tournaments: Tournaments): TierSourceRow[] {
  return tournaments.species.map((s) => {
    const games = s.wins + s.losses + s.ties;
    const row: TierSourceRow = { id: s.id, usagePct: s.share * 100, n: s.teams, note: `${pct(s.share, 1)} of teams · n ${int(s.teams)}` };
    if (games > 0) {
      row.wins = s.wins + s.ties / 2;
      row.games = games;
      row.wrNote = wrNote(row.wins, games);
    }
    return row;
  });
}

function wrNote(wins: number, games: number): string {
  const ci = wilsonInterval(wins, games);
  return `WR ${pct(wins / games, 1)} (95% ${pct(ci.lower, 0)}–${pct(ci.upper, 0)}, ${int(games)} games)`;
}

export function toTierInputs(rows: readonly TierSourceRow[]): TierInput[] {
  return rows.map((r) => {
    const input: { usagePct: number; wins?: number; games?: number } = { usagePct: r.usagePct };
    if (r.wins !== undefined) input.wins = r.wins;
    if (r.games !== undefined) input.games = r.games;
    return { id: r.id, value: pokemonTierValue(input), n: r.n };
  });
}

// ---- speed -------------------------------------------------------------------------------------

export interface SpeedNeighbour {
  id: string;
  speed: number;
}

/** Where `speed` lands among the given entries: how many it outspeeds, ties and is outsped by. */
export function speedPosition(speed: number, entries: readonly SpeedNeighbour[], self?: string) {
  const others = entries.filter((e) => e.id !== self);
  return {
    faster: others.filter((e) => speed > e.speed).length,
    ties: others.filter((e) => speed === e.speed).length,
    slower: others.filter((e) => speed < e.speed).length,
    total: others.length,
  };
}
