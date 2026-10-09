/**
 * Heroes Profile aggregates → stats.json (class B) and the draft-shard stats overlay
 * (SPEC §6, §12 entry 9). Pure. Input rows are OUR neutral shape (see HpWindowData); the
 * adapter in ../sources/heroesprofileAdapter.ts maps Heroes Profile responses into it.
 *
 * Model (src/core/stats.ts, critique D5):
 *  - hero WR: empirical-Bayes Beta shrinkage (shrinkAll), tiers by fixed pp bands (assignTiers);
 *  - counters/synergies: shrunk toward the logit-additive expectation (edgesFromPairs), counters
 *    antisymmetrised, pairs with n < 15 dropped;
 *  - hero × map: shrunk toward the hero's own shrunk WR with a fitted pseudo-count (fitPairK);
 *  - talent builds: ranked by a posterior 10th percentile so small samples do not win.
 * Cho and Gall rows collapse into the composite `chogall` (they always share a game and team).
 */
import { edgesFromPairs, fitPairK, pairStat, shrinkAll, type PairRow } from '../../../../core/stats.ts';
import { assignTiers } from '../../../../core/tiers.ts';
import type { ValidationIssue } from '../../../../core/game.ts';
import type { DraftShard, DraftStatsBlock, GameMap, GameMode, Stats, StatsWindow } from '../../schema.ts';
import { statsBlockFromWindow } from '../../draft/statsblock.ts';
import { compareStrings, round, searchKey, warn } from '../util.ts';

export interface HpHeroRow {
  /** Heroes Profile hero name ("Li-Ming", "Cho", "Gall"). */
  hero: string;
  games: number;
  wins: number;
  bans?: number;
}
export interface HpMapRow {
  hero: string;
  /** Heroes Profile map name. */
  map: string;
  games: number;
  wins: number;
}
/** `hero` won `wins` of `games` with (allies) or against (enemies) `other`. */
export interface HpPairRow {
  hero: string;
  other: string;
  games: number;
  wins: number;
}
export interface HpBuildRow {
  hero: string;
  /** heroes-data2 talent ids (== Heroes Profile talent names), level order. */
  talents: string[];
  games: number;
  wins: number;
}
export interface HpWindowData {
  heroes: HpHeroRow[];
  maps: HpMapRow[];
  enemies: HpPairRow[];
  allies: HpPairRow[];
  builds: HpBuildRow[];
}

export interface StatsEntity {
  id: string;
  name: string;
  slug: string;
  members?: readonly string[] | undefined;
  memberOf?: string | undefined;
}

export const SOURCE_ID = 'heroesprofile';
/** Posterior strength (pseudo-games) used for talent-build ranking. */
const BUILD_PRIOR_KAPPA = 30;
/** z for the 10th percentile. */
const Z10 = 1.2816;
const MAX_BUILDS = 5;

/** HP name → draftable entity id (members collapse into their composite). */
export function entityResolver(entities: readonly StatsEntity[]): (name: string) => string | null {
  const index = new Map<string, string>();
  for (const e of entities) {
    const target = e.memberOf ?? e.id;
    for (const k of [e.name, e.slug, e.id]) if (k) index.set(searchKey(k), target);
  }
  return (name) => index.get(searchKey(name)) ?? null;
}

/** HP map name → our map slug (curated hp.name first, then the display name). */
export function mapResolver(maps: readonly GameMap[]): (name: string) => string | null {
  const index = new Map<string, string>();
  for (const m of maps) {
    index.set(searchKey(m.name), m.id);
    index.set(searchKey(m.id), m.id);
    if (m.hp) index.set(searchKey(m.hp.name), m.id);
  }
  return (name) => index.get(searchKey(name)) ?? null;
}

interface Acc {
  games: number;
  wins: number;
  bans: number;
  rows: number;
}

/**
 * Groups rows by `key` (entity, entity×map, …). Rows from the same source name are summed
 * (e.g. pooled windows); rows of different source names that resolve to one entity are
 * composite members describing the same games (Cho and Gall), so those are averaged.
 */
function collapse<T extends { games: number; wins: number; bans?: number }>(rows: readonly T[], key: (r: T) => string | null, source: (r: T) => string): Map<string, Acc> {
  const groups = new Map<string, Map<string, Acc>>();
  for (const r of rows) {
    const k = key(r);
    if (k === null || !(r.games > 0)) continue;
    const bySource = groups.get(k) ?? new Map<string, Acc>();
    const s = source(r);
    const a = bySource.get(s) ?? { games: 0, wins: 0, bans: 0, rows: 0 };
    a.games += r.games;
    a.wins += Math.min(r.wins, r.games);
    a.bans += r.bans ?? 0;
    a.rows++;
    bySource.set(s, a);
    groups.set(k, bySource);
  }
  const out = new Map<string, Acc>();
  for (const [k, bySource] of groups) {
    const list = [...bySource.values()];
    const avg = (f: (a: Acc) => number): number => Math.round(list.reduce((s, a) => s + f(a), 0) / list.length);
    out.set(k, { games: avg((a) => a.games), wins: avg((a) => a.wins), bans: avg((a) => a.bans), rows: list.length });
  }
  return out;
}

/** Pools a previous window's rows at `weight` (first 14 days of a major, SPEC §5). */
export function poolWindows(current: HpWindowData, previous: HpWindowData, weight: number): HpWindowData {
  const scale = <T extends { games: number; wins: number; bans?: number }>(rows: readonly T[]): T[] =>
    rows.map((r) => ({ ...r, games: r.games * weight, wins: r.wins * weight, ...(r.bans !== undefined ? { bans: r.bans * weight } : {}) }));
  const round2 = <T extends { games: number; wins: number; bans?: number }>(rows: T[]): T[] =>
    rows.map((r) => ({ ...r, games: Math.round(r.games), wins: Math.round(r.wins), ...(r.bans !== undefined ? { bans: Math.round(r.bans) } : {}) }));
  return {
    heroes: round2([...current.heroes, ...scale(previous.heroes)]),
    maps: round2([...current.maps, ...scale(previous.maps)]),
    enemies: round2([...current.enemies, ...scale(previous.enemies)]),
    allies: round2([...current.allies, ...scale(previous.allies)]),
    builds: round2([...current.builds, ...scale(previous.builds)]),
  };
}

export interface WindowOptions {
  entities: readonly StatsEntity[];
  maps: readonly GameMap[];
  label: string;
  major: string;
  patchBuilds: string[];
  pooled?: { major: string; weight: number };
  /** Last patch's shrunk WR for heroes unchanged since (patch-aware prior, SPEC §6). */
  previousShrunk?: Readonly<Record<string, number>>;
}

export function buildStatsWindow(data: HpWindowData, opts: WindowOptions): { window: StatsWindow; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const entity = entityResolver(opts.entities);
  const mapOf = mapResolver(opts.maps);
  const unknownHeroes = new Set<string>();
  const unknownMaps = new Set<string>();
  const heroKey = (name: string): string | null => {
    const id = entity(name);
    if (!id) unknownHeroes.add(name);
    return id;
  };
  const names: Record<string, string> = {};
  for (const e of opts.entities) if (!e.memberOf) names[e.id] = e.name;

  // Heroes.
  const heroAcc = collapse(data.heroes, (r) => heroKey(r.hero), (r) => r.hero);
  const ids = [...heroAcc.keys()].sort(compareStrings);
  let totalHeroGames = 0;
  for (const a of heroAcc.values()) totalHeroGames += a.games;
  // Every game has 10 hero slots; Cho'gall fills two but is one row here.
  const G = Math.max(1, Math.round(totalHeroGames / 10));
  const { rates: shrunk } = shrinkAll(
    ids.map((id) => ({ id, wins: heroAcc.get(id)?.wins ?? 0, n: heroAcc.get(id)?.games ?? 0 })),
    opts.previousShrunk ? { previous: opts.previousShrunk } : {},
  );
  const tiers = new Map(assignTiers(ids.map((id) => ({ id, value: shrunk[id] ?? 0.5, n: heroAcc.get(id)?.games ?? 0 }))).map((t) => [t.id, t]));
  const heroes: StatsWindow['heroes'] = {};
  for (const id of ids) {
    const a = heroAcc.get(id) as Acc;
    const t = tiers.get(id);
    const stat: StatsWindow['heroes'][string] = {
      games: a.games,
      wins: a.wins,
      wr: round(a.wins / a.games, 4),
      shrunk: round(shrunk[id] ?? 0.5, 4),
      pick: round(Math.min(1, a.games / G), 4),
      ban: round(Math.min(1, a.bans / G), 4),
    };
    const tier = t && !t.early ? Number(t.tier.replace(/^T/, '')) : NaN;
    if (Number.isInteger(tier) && tier >= 1 && tier <= 5) stat.tier = tier;
    heroes[id] = stat;
  }

  // Pairs.
  const pairRows = (rows: readonly HpPairRow[]): PairRow[] => {
    const acc = collapse(rows, (r) => {
      const a = heroKey(r.hero);
      const b = heroKey(r.other);
      return a && b && a !== b ? `${a}\u0000${b}` : null;
    }, (r) => `${r.hero}\u0000${r.other}`);
    return [...acc].map(([k, v]) => {
      const [a, b] = k.split('\u0000') as [string, string];
      return { a, b, wins: v.wins, games: v.games };
    });
  };
  const counters = edgesFromPairs(pairRows(data.enemies), { relation: 'counter', baseRates: shrunk, names, source: SOURCE_ID });
  const synergies = edgesFromPairs(pairRows(data.allies), { relation: 'synergy', baseRates: shrunk, names, source: SOURCE_ID });

  // Hero × map, shrunk toward the hero's own rate.
  const mapAcc = collapse(data.maps, (r) => {
    const h = heroKey(r.hero);
    const m = mapOf(r.map);
    if (!m) unknownMaps.add(r.map);
    return h && m ? `${h}\u0000${m}` : null;
  }, (r) => `${r.hero}\u0000${r.map}`);
  const units = [...mapAcc].map(([k, v]) => ({ wins: v.wins, n: v.games, expected: shrunk[k.split('\u0000')[0] as string] ?? 0.5 }));
  const kMap = fitPairK(units);
  const maps: StatsWindow['maps'] = {};
  for (const [k, v] of [...mapAcc].sort(([a], [b]) => compareStrings(a, b))) {
    const [h, m] = k.split('\u0000') as [string, string];
    const base = shrunk[h];
    if (base === undefined) continue;
    const s = pairStat({ wins: v.wins, n: v.games }, base, kMap);
    (maps[h] ??= {})[m] = { games: v.games, wins: v.wins, shrunk: round(s.shrunk, 4), delta: round(s.delta, 2) };
  }

  // Talent builds.
  const builds: StatsWindow['builds'] = {};
  const buildAcc = new Map<string, Map<string, Acc>>();
  for (const r of data.builds) {
    const h = heroKey(r.hero);
    if (!h || !(r.games > 0) || r.talents.length === 0 || r.talents.length > 7) continue;
    const per = buildAcc.get(h) ?? new Map<string, Acc>();
    const key = r.talents.join('|');
    const a = per.get(key) ?? { games: 0, wins: 0, bans: 0, rows: 0 };
    a.games += r.games;
    a.wins += Math.min(r.wins, r.games);
    a.rows++;
    per.set(key, a);
    buildAcc.set(h, per);
  }
  for (const [h, per] of [...buildAcc].sort(([a], [b]) => compareStrings(a, b))) {
    const mu = shrunk[h] ?? 0.5;
    const list = [...per].map(([key, a]) => {
      const alpha = a.wins + BUILD_PRIOR_KAPPA * mu;
      const n = a.games + BUILD_PRIOR_KAPPA;
      const mean = alpha / n;
      const lower = Math.max(0, mean - Z10 * Math.sqrt((mean * (1 - mean)) / (n + 1)));
      return { talents: key.split('|'), games: a.games, wins: a.wins, shrunkLower: round(lower, 4) };
    });
    list.sort((x, y) => y.shrunkLower - x.shrunkLower || y.games - x.games || compareStrings(x.talents.join('|'), y.talents.join('|')));
    builds[h] = list.slice(0, MAX_BUILDS);
  }

  if (unknownHeroes.size > 0) issues.push(warn(`heroesprofile: hero names not matched to heroes.json: ${[...unknownHeroes].sort(compareStrings).slice(0, 10).join(', ')}`, 'heroesprofile'));
  if (unknownMaps.size > 0) issues.push(warn(`heroesprofile: map names not matched to maps.json: ${[...unknownMaps].sort(compareStrings).slice(0, 10).join(', ')}`, 'heroesprofile'));

  const window: StatsWindow = {
    label: opts.label,
    major: opts.major,
    patchBuilds: opts.patchBuilds,
    games: G,
    heroes,
    counters,
    synergies,
    maps,
    builds,
  };
  if (opts.pooled) window.pooled = { ...opts.pooled };
  return { window, issues };
}

/** Map slug → share of the window's games (for the Storm League pool, SPEC §5). */
export function mapShares(data: HpWindowData, maps: readonly GameMap[]): Map<string, number> {
  const mapOf = mapResolver(maps);
  const perMap = new Map<string, number>();
  let total = 0;
  for (const r of data.maps) {
    const m = mapOf(r.map);
    if (!m || !(r.games > 0)) continue;
    perMap.set(m, (perMap.get(m) ?? 0) + r.games);
    total += r.games;
  }
  const out = new Map<string, number>();
  if (total > 0) for (const [m, g] of perMap) out.set(m, g / total);
  return out;
}

export function buildStats(input: { fetchedAt: string; major: string; builds: string[]; sl: StatsWindow }): Stats {
  return {
    schema: 1,
    source: 'heroesprofile',
    fetchedAt: input.fetchedAt,
    major: input.major,
    builds: input.builds,
    modes: { sl: { current: input.sl } },
  };
}

/**
 * The class-B overlay for public/draft.json: dense matrices aligned with the shard's entity and
 * map order (DraftStatsBlockSchema). Pairs below the hide gate are null. One builder serves the
 * pipeline, the fixture overlay and the draft tests (draft/statsblock.ts).
 */
export function buildDraftStatsBlock(shard: Pick<DraftShard, 'heroes' | 'maps'>, window: StatsWindow, mode: GameMode = 'sl'): DraftStatsBlock {
  return statsBlockFromWindow(window, shard, { mode, timeframe: 'current' });
}
