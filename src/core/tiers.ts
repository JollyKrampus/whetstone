/**
 * Tier assignment with fixed bands (SPEC §6, critique D6). Fixed bands, not quantiles: a hero
 * keeps its tier when others move, so the list is stable day to day. Generic over games: a
 * config says how to turn an entry into a metric and where the band edges sit.
 */
import { wilsonInterval } from './stats.ts';

export interface TierBand {
  id: string;
  label?: string;
  /** Lower edge of the band in metric units. */
  min: number;
  /** true (default): metric ≥ min; false: metric > min. */
  inclusive?: boolean;
}

export interface TierConfig {
  /** Evaluated top-down; first match wins. The last band should catch everything (min −Infinity). */
  bands: readonly TierBand[];
  /** Entries with n below this get {@link EARLY} instead of a band. */
  minN: number;
  /** metric = (value − center) × scale (+ ban nudge). HotS: (shrunk WR − 0.5) × 100 = pp. */
  center: number;
  scale: number;
  /** Ban-rate nudge weight on proportions: value += w·(ban − mean ban). 0 disables. */
  banNudge: number;
}

/** Tier id for entries below the n gate. */
export const EARLY = 'early';

/** HotS: T1 ≥ +2.5 pp, T2 ≥ +1, T3 > −1, T4 > −2.5, else T5; n ≥ 200 else early data. */
export const HOTS_TIERS: Readonly<TierConfig> = Object.freeze({
  bands: Object.freeze([
    { id: 'T1', label: 'Tier 1', min: 2.5 },
    { id: 'T2', label: 'Tier 2', min: 1 },
    { id: 'T3', label: 'Tier 3', min: -1, inclusive: false },
    { id: 'T4', label: 'Tier 4', min: -2.5, inclusive: false },
    { id: 'T5', label: 'Tier 5', min: Number.NEGATIVE_INFINITY },
  ]),
  minN: 200,
  center: 0.5,
  scale: 100,
  banNudge: 0,
});

/**
 * Pokémon (VGC): the metric is usage % plus a win-rate adjustment (see pokemonTierValue), so
 * bands sit on the usage scale. n = teams (or games) behind the usage figure.
 */
export const POKEMON_TIERS: Readonly<TierConfig> = Object.freeze({
  bands: Object.freeze([
    { id: 'S', label: 'S', min: 20 },
    { id: 'A', label: 'A', min: 10 },
    { id: 'B', label: 'B', min: 5 },
    { id: 'C', label: 'C', min: 2 },
    { id: 'D', label: 'D', min: Number.NEGATIVE_INFINITY },
  ]),
  minN: 30,
  center: 0,
  scale: 1,
  banNudge: 0,
});

export interface PokemonTierInput {
  /** Usage share in percent (0–100), already shrunk/smoothed by the caller if needed. */
  usagePct: number;
  /** Tournament or ladder wins/games for the win-rate adjustment (optional). */
  wins?: number;
  games?: number;
}

export interface PokemonTierOptions {
  /** Usage points per pp of credible win-rate edge (default 0.5). */
  wrWeight?: number;
  /** Ignore win rate below this many games (default 30). */
  minGames?: number;
}

/**
 * Usage % adjusted by win rate only where the Wilson interval excludes 50 %: +λ·(lower − 50 %)
 * when it sits above, +λ·(upper − 50 %) when below. Small samples (wide intervals) add nothing,
 * which avoids rewarding a 6–1 run.
 */
export function pokemonTierValue(input: PokemonTierInput, opts: PokemonTierOptions = {}): number {
  const wrWeight = opts.wrWeight ?? 0.5;
  const minGames = opts.minGames ?? 30;
  const base = Number.isFinite(input.usagePct) ? input.usagePct : 0;
  const games = input.games ?? 0;
  if (!(games >= minGames) || input.wins === undefined) return base;
  const ci = wilsonInterval(input.wins, games);
  let edgePp = 0;
  if (ci.lower > 0.5) edgePp = (ci.lower - 0.5) * 100;
  else if (ci.upper < 0.5) edgePp = (ci.upper - 0.5) * 100;
  return base + wrWeight * edgePp;
}

export interface TierInput {
  id: string;
  /** HotS: shrunk win rate (proportion). Pokémon: pokemonTierValue(). */
  value: number;
  n: number;
  banRate?: number;
  /** Same entity in the previous window/patch, for change arrows and Δ. */
  previous?: { value?: number; tier?: string } | null;
}

export type TierChange = 'up' | 'down' | 'same' | 'new' | 'unranked';

export interface TierResult {
  id: string;
  /** Band id, or {@link EARLY}. */
  tier: string;
  early: boolean;
  /** Metric the band was chosen from (pp for HotS), after any ban nudge. */
  metric: number;
  n: number;
  change: TierChange;
  previousTier?: string;
  /** (value − previous value) × scale; pp for HotS. */
  deltaPrevious?: number;
}

function bandMatches(metric: number, band: TierBand): boolean {
  return band.inclusive === false ? metric > band.min : metric >= band.min;
}

/** Band id for a metric (the last band when nothing matches, e.g. NaN). */
export function bandFor(metric: number, config: Pick<TierConfig, 'bands'> = HOTS_TIERS): string {
  for (const band of config.bands) if (bandMatches(metric, band)) return band.id;
  return config.bands[config.bands.length - 1]?.id ?? EARLY;
}

/** 0 = best band; undefined for early/unknown ids. */
export function tierRank(tier: string | undefined, config: Pick<TierConfig, 'bands'> = HOTS_TIERS): number | undefined {
  if (tier === undefined) return undefined;
  const i = config.bands.findIndex((b) => b.id === tier);
  return i < 0 ? undefined : i;
}

const round = (x: number, digits: number): number => {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
};

/**
 * Assign tiers. Output is sorted best band first, then by metric (desc), then id, with early
 * entries last; metric and deltaPrevious are rounded to 0.01 for stable output.
 */
export function assignTiers(entries: readonly TierInput[], config: Readonly<TierConfig> = HOTS_TIERS): TierResult[] {
  let meanBan = 0;
  if (config.banNudge !== 0) {
    const bans = entries.filter((e) => e.n >= config.minN && e.banRate !== undefined && Number.isFinite(e.banRate));
    meanBan = bans.length ? bans.reduce((s, e) => s + (e.banRate ?? 0), 0) / bans.length : 0;
  }
  const results: TierResult[] = entries.map((e) => {
    let value = e.value;
    if (config.banNudge !== 0 && e.banRate !== undefined && Number.isFinite(e.banRate)) {
      value += config.banNudge * (e.banRate - meanBan);
    }
    // Rounded before comparing so float noise (0.49 → −1.0000000000000009) cannot pick the band.
    const metric = round((value - config.center) * config.scale, 9);
    const early = !(e.n >= config.minN) || !Number.isFinite(metric);
    const tier = early ? EARLY : bandFor(metric, config);
    const result: TierResult = { id: e.id, tier, early, metric: round(metric, 2), n: e.n, change: 'new' };
    const prev = e.previous ?? undefined;
    if (prev?.tier !== undefined) result.previousTier = prev.tier;
    if (prev?.value !== undefined && Number.isFinite(prev.value) && Number.isFinite(e.value)) {
      result.deltaPrevious = round((e.value - prev.value) * config.scale, 2);
    }
    const now = tierRank(tier, config);
    const before = tierRank(prev?.tier, config);
    if (now === undefined) result.change = 'unranked';
    else if (before === undefined) result.change = 'new';
    else result.change = now < before ? 'up' : now > before ? 'down' : 'same';
    return result;
  });
  results.sort((x, y) => {
    const rx = tierRank(x.tier, config) ?? Number.POSITIVE_INFINITY;
    const ry = tierRank(y.tier, config) ?? Number.POSITIVE_INFINITY;
    if (rx !== ry) return rx - ry;
    if (x.metric !== y.metric) return y.metric - x.metric;
    return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
  });
  return results;
}
