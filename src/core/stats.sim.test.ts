/**
 * Simulation harness for the SPEC §6 pipeline math (critique G5). Synthetic heroes with known
 * strengths and a sparse set of planted counter effects play 5v5 games under a logit-additive
 * team model; we then run exactly the production math (EB hero shrinkage → expectation-centred
 * pair shrinkage → antisymmetry → display gates) and count what a hero page would list.
 *
 * Volumes bracket the critique's 6× uncertainty for Storm League: ~330 games/day (the
 * hotspatchnotes reading) and ~3,000/day (the Heroes Profile id-growth estimate), both over a
 * 30-day patch window. Everything is seeded (mulberry32); no Math.random.
 *
 * Set WHETSTONE_SIM_VERBOSE=1 to print the measured rates when recalibrating the gates.
 */
import { describe, expect, it } from 'vitest';
import type { Edge } from './game.ts';
import {
  HIGH_VOLUME_MIN_ABS_Z,
  edgesFromPairs,
  fitBetaPrior,
  isListableEdge,
  shrinkRate,
  sigmoid,
  type PairRow,
  type StatGates,
} from './stats.ts';

const HEROES = 90;
const DAYS = 30;
const LOW_GAMES = 330 * DAYS;
const HIGH_GAMES = 3000 * DAYS;
/** A planted effect only counts as "seen-able" when its pair has this many games. */
const RECALL_MIN_N = 400;

interface WorldConfig {
  seed: number;
  /** Share of unordered hero pairs with a real counter relationship. */
  density: number;
  /** Planted effect sizes at the pair level, in pp (uniform between the two). */
  minPp: number;
  maxPp: number;
  /** "Large" effects the high-volume run must recover. */
  largePp: number;
}

/** Real counters are "usually 1–5 points" (hots-stats-api §7.3): a sparse, moderate world. */
const SPARSE: WorldConfig = { seed: 20261008, density: 0.06, minPp: 3, maxPp: 9, largePp: 6 };
/** Denser and stronger effects, closer to the k ≈ 150–600 the stats report expects. */
const STRONG: WorldConfig = { seed: 20261009, density: 0.1, minPp: 4, maxPp: 10, largePp: 6 };

/** mulberry32: tiny, fast, good enough for Monte Carlo, identical on every engine. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

interface World {
  config: WorldConfig;
  /** Logit strength per hero (sd 0.1 ≈ 2.5 pp of win rate). */
  strength: Float64Array;
  /** Relative pick popularity (log-normal: a few staples, a long niche tail). */
  weight: Float64Array;
  /** Antisymmetric counter effects in logit units, H×H: counter[a*H+b] = −counter[b*H+a]. */
  counter: Float64Array;
  /** Planted effect in pp for (a beats b), 0 when none. */
  plantedPp: Float64Array;
}

function makeWorld(config: WorldConfig): World {
  const rand = prng(config.seed);
  const strength = new Float64Array(HEROES);
  const weight = new Float64Array(HEROES);
  for (let h = 0; h < HEROES; h++) {
    strength[h] = 0.1 * gaussian(rand);
    weight[h] = Math.exp(0.6 * gaussian(rand));
  }
  const counter = new Float64Array(HEROES * HEROES);
  const plantedPp = new Float64Array(HEROES * HEROES);
  for (let a = 0; a < HEROES; a++) {
    for (let b = a + 1; b < HEROES; b++) {
      if (rand() >= config.density) continue;
      const size = config.minPp + (config.maxPp - config.minPp) * rand();
      const sign = rand() < 0.5 ? -1 : 1;
      // Near 50 %, Δ pp ≈ 25 · Δ logit (σ'(0) = 1/4), so 4 pp ≈ 0.16 logit.
      const logitEffect = (sign * size) / 25;
      counter[a * HEROES + b] = logitEffect;
      counter[b * HEROES + a] = -logitEffect;
      plantedPp[a * HEROES + b] = sign * size;
      plantedPp[b * HEROES + a] = -sign * size;
    }
  }
  return { config, strength, weight, counter, plantedPp };
}

interface Tallies {
  heroWins: Float64Array;
  heroGames: Float64Array;
  /** Σ P(win) over the hero's games: its true win rate in exactly the lineups it played. */
  heroExpected: Float64Array;
  enemyWins: Float64Array;
  enemyGames: Float64Array;
  allyWins: Float64Array;
  allyGames: Float64Array;
}

function simulate(world: World, games: number, seed: number): Tallies {
  const rand = prng(seed);
  const H = HEROES;
  const t: Tallies = {
    heroWins: new Float64Array(H),
    heroGames: new Float64Array(H),
    heroExpected: new Float64Array(H),
    enemyWins: new Float64Array(H * H),
    enemyGames: new Float64Array(H * H),
    allyWins: new Float64Array(H * H),
    allyGames: new Float64Array(H * H),
  };
  const cumulative = new Float64Array(H);
  let total = 0;
  for (let h = 0; h < H; h++) {
    total += world.weight[h]!;
    cumulative[h] = total;
  }
  const draw = (): number => {
    const u = rand() * total;
    let lo = 0;
    let hi = H - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid]! > u) hi = mid;
      else lo = mid + 1;
    }
    return lo;
  };
  const used = new Uint8Array(H);
  const lineup = new Int32Array(10);
  for (let g = 0; g < games; g++) {
    used.fill(0);
    for (let i = 0; i < 10; ) {
      const h = draw();
      if (used[h]) continue;
      used[h] = 1;
      lineup[i++] = h;
    }
    let x = 0;
    for (let i = 0; i < 5; i++) {
      const a = lineup[i]!;
      x += world.strength[a]!;
      for (let j = 5; j < 10; j++) x += world.counter[a * H + lineup[j]!]!;
    }
    for (let j = 5; j < 10; j++) x -= world.strength[lineup[j]!]!;
    const p = sigmoid(x);
    const firstWins = rand() < p;
    for (let i = 0; i < 10; i++) {
      const h = lineup[i]!;
      const onFirst = i < 5;
      t.heroGames[h]!++;
      if (onFirst === firstWins) t.heroWins[h]!++;
      t.heroExpected[h]! += onFirst ? p : 1 - p;
    }
    for (let i = 0; i < 5; i++) {
      const a = lineup[i]!;
      for (let j = 5; j < 10; j++) {
        const b = lineup[j]!;
        t.enemyGames[a * H + b]!++;
        t.enemyGames[b * H + a]!++;
        if (firstWins) t.enemyWins[a * H + b]!++;
        else t.enemyWins[b * H + a]!++;
      }
    }
    for (const [from, won] of [
      [0, firstWins],
      [5, !firstWins],
    ] as const) {
      for (let i = from; i < from + 5; i++) {
        for (let j = i + 1; j < from + 5; j++) {
          const a = lineup[i]!;
          const b = lineup[j]!;
          t.allyGames[a * H + b]!++;
          t.allyGames[b * H + a]!++;
          if (won) {
            t.allyWins[a * H + b]!++;
            t.allyWins[b * H + a]!++;
          }
        }
      }
    }
  }
  return t;
}

const id = (h: number): string => `h${String(h).padStart(2, '0')}`;
const index = (heroId: string): number => Number(heroId.slice(1));

interface Analysis {
  /** RMSE of shrunk vs true hero win rate, pp. */
  shrunkRmsePp: number;
  rawRmsePp: number;
  counters: Edge[];
  synergies: Edge[];
}

/** The production pipeline, end to end, on simulated tallies. */
function analyse(t: Tallies): Analysis {
  const H = HEROES;
  const rates: number[] = [];
  const ns: number[] = [];
  for (let h = 0; h < H; h++) {
    ns.push(t.heroGames[h]!);
    rates.push(t.heroGames[h]! > 0 ? t.heroWins[h]! / t.heroGames[h]! : Number.NaN);
  }
  const prior = fitBetaPrior(rates, ns);
  const baseRates: Record<string, number> = {};
  let se = 0;
  let seRaw = 0;
  for (let h = 0; h < H; h++) {
    const n = t.heroGames[h]!;
    const shrunk = shrinkRate(t.heroWins[h]!, n, prior);
    baseRates[id(h)] = shrunk;
    const truth = t.heroExpected[h]! / n;
    se += (shrunk - truth) ** 2;
    seRaw += (t.heroWins[h]! / n - truth) ** 2;
  }
  const enemyRows: PairRow[] = [];
  const allyRows: PairRow[] = [];
  for (let a = 0; a < H; a++) {
    for (let b = 0; b < H; b++) {
      if (a === b) continue;
      const k = a * H + b;
      if (t.enemyGames[k]! > 0) enemyRows.push({ a: id(a), b: id(b), wins: t.enemyWins[k]!, games: t.enemyGames[k]! });
      if (t.allyGames[k]! > 0) allyRows.push({ a: id(a), b: id(b), wins: t.allyWins[k]!, games: t.allyGames[k]! });
    }
  }
  return {
    shrunkRmsePp: 100 * Math.sqrt(se / H),
    rawRmsePp: 100 * Math.sqrt(seRaw / H),
    counters: edgesFromPairs(enemyRows, { relation: 'counter', baseRates }),
    synergies: edgesFromPairs(allyRows, { relation: 'synergy', baseRates }),
  };
}

/**
 * Listed counter rows per hero page that no planted effect of the same sign backs. Each
 * directed edge (a, b) is one row on a's page ("strong/weak against b"). This is stricter than
 * judging against the true residual: small spill-over residuals count as false here too.
 */
function counterFalsePositivesPerPage(world: World, edges: readonly Edge[], gates: Partial<StatGates> = {}): number {
  let fp = 0;
  for (const e of edges) {
    if (!isListableEdge(e, gates)) continue;
    const planted = world.plantedPp[index(e.a) * HEROES + index(e.b)]!;
    if (planted === 0 || Math.sign(planted) !== Math.sign(e.delta ?? 0)) fp++;
  }
  return fp / HEROES;
}

/** No synergy is planted, so every listed synergy is false (each edge shows on two pages). */
function synergyFalsePositivesPerPage(edges: readonly Edge[]): number {
  return (2 * edges.filter((e) => isListableEdge(e)).length) / HEROES;
}

/** Share of large planted counters (with enough games to be visible) listed with the right sign. */
function largeEffectRecall(world: World, t: Tallies, edges: readonly Edge[], gates: Partial<StatGates> = {}): number {
  const byPair = new Map(edges.map((e) => [`${e.a}>${e.b}`, e]));
  let total = 0;
  let found = 0;
  for (let a = 0; a < HEROES; a++) {
    for (let b = 0; b < HEROES; b++) {
      const k = a * HEROES + b;
      if (world.plantedPp[k]! < world.config.largePp || t.enemyGames[k]! < RECALL_MIN_N) continue;
      total++;
      const e = byPair.get(`${id(a)}>${id(b)}`);
      if (e && isListableEdge(e, gates) && (e.delta ?? 0) > 0) found++;
    }
  }
  return total === 0 ? 0 : found / total;
}

function report(label: string, world: World, t: Tallies, r: Analysis): void {
  if (!process.env['WHETSTONE_SIM_VERBOSE']) return;
  const zGate = { listMinAbsZ: HIGH_VOLUME_MIN_ABS_Z };
  console.log(label, {
    shrunkRmsePp: r.shrunkRmsePp.toFixed(3),
    rawRmsePp: r.rawRmsePp.toFixed(3),
    counterFpPerPage: counterFalsePositivesPerPage(world, r.counters).toFixed(3),
    counterFpPerPageZ: counterFalsePositivesPerPage(world, r.counters, zGate).toFixed(3),
    synergyFpPerPage: synergyFalsePositivesPerPage(r.synergies).toFixed(3),
    largeRecall: largeEffectRecall(world, t, r.counters).toFixed(3),
    largeRecallZ: largeEffectRecall(world, t, r.counters, zGate).toFixed(3),
    listed: r.counters.filter((e) => isListableEdge(e)).length,
  });
}

function run(world: World, games: number, seed: number, label: string): { t: Tallies; r: Analysis } {
  const t = simulate(world, games, seed);
  const r = analyse(t);
  report(label, world, t, r);
  return { t, r };
}

describe('stats pipeline simulation (SPEC §6 gates)', () => {
  describe('sparse world (6 % of pairs, 3–9 pp)', () => {
    const world = makeWorld(SPARSE);

    it('plants a sparse, antisymmetric set of counters', () => {
      let planted = 0;
      for (let a = 0; a < HEROES; a++) {
        for (let b = 0; b < HEROES; b++) {
          const k = a * HEROES + b;
          if (world.plantedPp[k] !== 0) planted++;
          expect(world.counter[k]! + world.counter[b * HEROES + a]!).toBe(0);
        }
      }
      const share = planted / 2 / ((HEROES * (HEROES - 1)) / 2);
      expect(share).toBeGreaterThan(0.04);
      expect(share).toBeLessThan(0.08);
    });

    describe('low volume: 330 games/day × 30 days', () => {
      const { r } = run(world, LOW_GAMES, 1, 'sparse/low');

      it('keeps shrunk hero win rates close to the truth, closer than raw', () => {
        expect(r.shrunkRmsePp).toBeLessThan(1.6);
        expect(r.shrunkRmsePp).toBeLessThan(r.rawRmsePp);
      });

      it('lists at most one false counter per hero page on average', () => {
        expect(counterFalsePositivesPerPage(world, r.counters)).toBeLessThanOrEqual(1);
      });

      it('lists at most one false synergy per hero page on average', () => {
        expect(synergyFalsePositivesPerPage(r.synergies)).toBeLessThanOrEqual(1);
      });

      it('emits only displayable, well-formed edges', () => {
        for (const e of r.counters) {
          expect(e.n).toBeGreaterThanOrEqual(15);
          expect(e.score).toBeGreaterThanOrEqual(1);
          expect(e.score).toBeLessThanOrEqual(100);
          expect(e.source).toBe('stats');
        }
      });
    });

    describe('high volume: 3,000 games/day × 30 days', () => {
      const { t, r } = run(world, HIGH_GAMES, 2, 'sparse/high');

      it('tightens hero win rates', () => {
        expect(r.shrunkRmsePp).toBeLessThan(0.75);
      });

      // A sparse world fits a large k (strong shrinkage), so recall is modest: 0.52–0.72 across
      // seeds when this was calibrated. The threshold leaves room for seed-to-seed spread.
      it('recovers a good share of large planted counters that have enough games', () => {
        expect(largeEffectRecall(world, t, r.counters)).toBeGreaterThanOrEqual(0.4);
      });

      it('keeps false counters per page low', () => {
        expect(counterFalsePositivesPerPage(world, r.counters)).toBeLessThanOrEqual(1);
      });
    });
  });

  describe('strong world (10 % of pairs, 4–10 pp)', () => {
    const world = makeWorld(STRONG);

    it('low volume: the SPEC gates alone keep false counters ≤ 1 per page', () => {
      const { r } = run(world, LOW_GAMES, 3, 'strong/low');
      expect(counterFalsePositivesPerPage(world, r.counters)).toBeLessThanOrEqual(1);
    });

    describe('high volume', () => {
      const { t, r } = run(world, HIGH_GAMES, 4, 'strong/high');
      const zGate = { listMinAbsZ: HIGH_VOLUME_MIN_ABS_Z };

      it('recovers large planted counters', () => {
        expect(largeEffectRecall(world, t, r.counters)).toBeGreaterThanOrEqual(0.7);
        expect(largeEffectRecall(world, t, r.counters, zGate)).toBeGreaterThanOrEqual(0.6);
      });

      it('needs the optional |z| gate to keep false counters ≤ 1 per page', () => {
        const plain = counterFalsePositivesPerPage(world, r.counters);
        const gated = counterFalsePositivesPerPage(world, r.counters, zGate);
        expect(gated).toBeLessThanOrEqual(1);
        expect(gated).toBeLessThan(plain);
      });
    });
  });
});
