/**
 * Game-agnostic statistics (SPEC §6, critique D5). Browser-safe, deterministic, no I/O.
 *
 * Units, used consistently across this module and its callers:
 * - rates, expectations and shrunk rates are proportions in [0, 1];
 * - every `delta` that leaves this module (PairStat, Edge, Reason, gates, scores) is in
 *   percentage points (pp): 0.012 as a proportion is `1.2` here.
 * See docs/METHODOLOGY.md for the plain-language version.
 */
import type { Edge, Reason } from './game.ts';
import { int, pct } from './format.ts';

/** Two-sided 95 % normal quantile used for every displayed interval. */
export const Z95 = 1.96;
/** Probabilities are clamped to [PROB_EPS, 1 − PROB_EPS] before taking logits. */
export const PROB_EPS = 1e-6;
/** Score scale: Δ of this many pp maps to tanh(1) ≈ 88 on the 1–100 ring (Δ/0.04 in proportions). */
export const SCORE_SCALE_PP = 4;

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round = (x: number, digits: number): number => {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
};

/** Proportion → percentage points. */
export const toPp = (proportion: number): number => proportion * 100;

// ---- intervals ---------------------------------------------------------------------------

export interface Interval {
  lower: number;
  upper: number;
  center: number;
}

/** Wilson score interval for k successes out of n (n = 0 → the uninformative [0, 1]). */
export function wilsonInterval(k: number, n: number, z = Z95): Interval {
  if (!(n > 0)) return { lower: 0, upper: 1, center: 0.5 };
  const p = clamp(k, 0, n) / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  // Pin the ends exactly: center − half can come out as ±1e-17 at k = 0.
  const lower = p <= 0 ? 0 : clamp(center - half, 0, 1);
  const upper = p >= 1 ? 1 : clamp(center + half, 0, 1);
  return { lower, upper, center };
}

/**
 * Wilson lower bound, written exactly as heroescounters computes it (the expression order
 * matters for the hide threshold: 4 up / 2 down is 0.29999…, 21/28 is 0.30023).
 */
export function wilsonLower(k: number, n: number, z = Z95): number {
  if (!(n > 0)) return 0;
  const p = clamp(k, 0, n) / n;
  const z2 = z * z;
  const lower = (p + z2 / (2 * n) - z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / (1 + z2 / n);
  return Math.max(0, lower);
}

/** Vote-style score 0–100 = round(100 × Wilson lower bound) for k positive out of n total. */
export function wilsonLowerScore(k: number, n: number, z = Z95): number {
  return Math.round(100 * wilsonLower(k, n, z));
}

/** Same as {@link wilsonLowerScore} in up/down vote terms: `voteScore(4, 0)` → 51. */
export function voteScore(up: number, down: number, z = Z95): number {
  return wilsonLowerScore(up, up + down, z);
}

/** heroescounters collapses vote rows whose raw lower bound is below 0.30 behind "View more". */
export const VOTE_COLLAPSE_BELOW = 0.3;

export function isVoteCollapsed(up: number, down: number, z = Z95): boolean {
  return wilsonLower(up, up + down, z) < VOTE_COLLAPSE_BELOW;
}

// ---- logit scale ---------------------------------------------------------------------------

/** log-odds of p, with p clamped away from 0 and 1 so the result stays finite. */
export function logit(p: number): number {
  const q = clamp(p, PROB_EPS, 1 - PROB_EPS);
  return Math.log(q / (1 - q));
}

/** Logistic function, written to avoid overflow for large |x|. */
export function sigmoid(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

// ---- empirical-Bayes shrinkage ------------------------------------------------------------------

/** Beta prior as mean and strength (pseudo-games): alpha = mu·kappa, beta = (1 − mu)·kappa. */
export interface BetaPrior {
  mu: number;
  kappa: number;
}

export interface BetaFit extends BetaPrior {
  alpha: number;
  beta: number;
  /** Between-unit variance of the true rates after removing binomial noise (floored). */
  tau2: number;
  /** Units that informed tau2. */
  used: number;
  /** True when the data could not support a spread estimate (κ fell back to a bound). */
  degenerate: boolean;
}

export interface BetaFitOptions {
  /** Only units with at least this many trials inform the spread (default 50). */
  minN?: number;
  minKappa?: number;
  maxKappa?: number;
  tau2Floor?: number;
  /** Mean used when there is no data at all (default 0.5). */
  fallbackMu?: number;
}

/**
 * Method-of-moments Beta prior over units (heroes, cards…): mu is the pooled rate, tau² the
 * observed between-unit variance minus the average binomial noise, κ = mu(1−mu)/tau² − 1.
 */
export function fitBetaPrior(rates: readonly number[], ns: readonly number[], opts: BetaFitOptions = {}): BetaFit {
  const minN = opts.minN ?? 50;
  const minKappa = opts.minKappa ?? 10;
  const maxKappa = opts.maxKappa ?? 5000;
  const tau2Floor = opts.tau2Floor ?? 1e-5;
  const fallbackMu = opts.fallbackMu ?? 0.5;

  const units: { r: number; n: number }[] = [];
  const len = Math.min(rates.length, ns.length);
  for (let i = 0; i < len; i++) {
    const r = rates[i]!;
    const n = ns[i]!;
    if (Number.isFinite(r) && Number.isFinite(n) && n > 0) units.push({ r: clamp(r, 0, 1), n });
  }
  const finish = (mu: number, kappa: number, tau2: number, used: number, degenerate: boolean): BetaFit => ({
    mu,
    kappa,
    alpha: mu * kappa,
    beta: (1 - mu) * kappa,
    tau2,
    used,
    degenerate,
  });
  if (units.length === 0) return finish(fallbackMu, maxKappa, tau2Floor, 0, true);

  let wins = 0;
  let trials = 0;
  for (const u of units) {
    wins += u.r * u.n;
    trials += u.n;
  }
  const mu = wins / trials;
  if (mu <= 0 || mu >= 1) return finish(mu, maxKappa, tau2Floor, 0, true);

  let big = units.filter((u) => u.n >= minN);
  if (big.length < 2) big = units;
  if (big.length < 2) return finish(mu, maxKappa, tau2Floor, big.length, true);

  let acc = 0;
  for (const u of big) acc += (u.r - mu) ** 2 - (mu * (1 - mu)) / u.n;
  const raw = acc / big.length;
  const degenerate = !(raw > tau2Floor);
  const tau2 = degenerate ? tau2Floor : raw;
  const kappa = clamp((mu * (1 - mu)) / tau2 - 1, minKappa, maxKappa);
  return finish(mu, kappa, tau2, big.length, degenerate);
}

/** Posterior mean (wins + κμ) / (n + κ). */
export function shrinkRate(wins: number, n: number, prior: BetaPrior): number {
  const denom = n + prior.kappa;
  if (!(denom > 0)) return prior.mu;
  return (clamp(wins, 0, Math.max(0, n)) + prior.kappa * prior.mu) / denom;
}

/**
 * Patch-aware prior (SPEC §6): an entity unchanged since last patch is shrunk toward its own
 * previous shrunk rate with a fraction of the population strength; anything else toward μ.
 */
export function priorFor(population: BetaPrior, previous?: number | null, carry = 0.5): BetaPrior {
  if (previous === null || previous === undefined || !(previous > 0 && previous < 1)) return population;
  return { mu: previous, kappa: population.kappa * carry };
}

/** Shrink every unit with one population prior; returns id → shrunk rate. */
export function shrinkAll(
  units: readonly { id: string; wins: number; n: number }[],
  /** previous: last patch's shrunk rate, only for entities unchanged since (SPEC §6). */
  opts: BetaFitOptions & { previous?: Readonly<Record<string, number>>; carry?: number } = {},
): { prior: BetaFit; rates: Record<string, number> } {
  const prior = fitBetaPrior(
    units.map((u) => (u.n > 0 ? u.wins / u.n : Number.NaN)),
    units.map((u) => u.n),
    opts,
  );
  const rates: Record<string, number> = {};
  for (const u of units) {
    rates[u.id] = shrinkRate(u.wins, u.n, priorFor(prior, opts.previous?.[u.id], opts.carry));
  }
  return { prior, rates };
}

// ---- pairs ------------------------------------------------------------------------------------

/** Expected rate of A against B when both play at their base strength (logit-additive teams). */
export function counterExpectation(pA: number, pB: number): number {
  return sigmoid(logit(pA) - logit(pB));
}

/** Expected rate of a team holding both A and B. */
export function synergyExpectation(pA: number, pB: number): number {
  return sigmoid(logit(pA) + logit(pB));
}

export interface WinCount {
  wins: number;
  n: number;
}

export interface PairUnit extends WinCount {
  expected: number;
}

export interface PairKOptions {
  minN?: number;
  minK?: number;
  maxK?: number;
  tau2Floor?: number;
}

/**
 * Pseudo-count k for shrinking observed rates toward per-unit expectations (pairs toward their
 * logit expectation; hero×map toward the hero's own rate): k = mean e(1−e) / tau², with tau²
 * the excess variance of (observed − expected) over units with n ≥ minN (default 30).
 */
export function fitPairK(units: readonly PairUnit[], opts: PairKOptions = {}): number {
  const minN = opts.minN ?? 30;
  const minK = opts.minK ?? 25;
  const maxK = opts.maxK ?? 2000;
  const tau2Floor = opts.tau2Floor ?? 1e-5;
  let acc = 0;
  let ve = 0;
  let count = 0;
  for (const u of units) {
    if (!(u.n >= minN) || !Number.isFinite(u.expected)) continue;
    const e = clamp(u.expected, PROB_EPS, 1 - PROB_EPS);
    acc += (clamp(u.wins, 0, u.n) / u.n - e) ** 2 - (e * (1 - e)) / u.n;
    ve += e * (1 - e);
    count++;
  }
  // No usable pairs means no evidence of real effects: shrink as hard as allowed.
  if (count === 0) return maxK;
  const tau2 = Math.max(tau2Floor, acc / count);
  return clamp(ve / count / tau2, minK, maxK);
}

export interface PairStat {
  n: number;
  /** Observed rate w/n (the expectation when n = 0, so it never reads as an extreme). */
  rate: number;
  expected: number;
  /** (w + k·e) / (n + k). */
  shrunk: number;
  /** shrunk − expected, in percentage points. */
  delta: number;
  /** (w − n·e) / √(n·e(1−e)); 0 when undefined. */
  z: number;
  /** 1–100 ring score from delta. */
  score: number;
}

/** Shrink one pair toward its expectation and report Δ (pp), z and the 1–100 score. */
export function pairStat(count: WinCount, expected: number, k: number): PairStat {
  const n = Math.max(0, count.n);
  const wins = clamp(count.wins, 0, n);
  const e = clamp(expected, PROB_EPS, 1 - PROB_EPS);
  const kk = Math.max(0, k);
  const shrunk = n > 0 ? (wins + kk * e) / (n + kk) : e;
  const delta = toPp(shrunk - e);
  const variance = n * e * (1 - e);
  const z = variance > 0 ? (wins - n * e) / Math.sqrt(variance) : 0;
  return { n, rate: n > 0 ? wins / n : e, expected: e, shrunk, delta, z, score: scoreFromDelta(delta) };
}

/** 1–100 = round(50 + 50·tanh(Δpp / 4)), i.e. tanh(Δ / 0.04) with Δ as a proportion. */
export function scoreFromDelta(deltaPp: number): number {
  if (!Number.isFinite(deltaPp)) return 50;
  return clamp(Math.round(50 + 50 * Math.tanh(deltaPp / SCORE_SCALE_PP)), 1, 100);
}

// ---- display gates ------------------------------------------------------------------------------

export interface StatGates {
  /** Rows with n below this are not shown at all. */
  hideBelow: number;
  /** Rows with n below this are shown greyed out. */
  greyBelow: number;
  /** "Strong/weak against" lists need at least this n … */
  listMinN: number;
  /** … and at least this |Δ| in pp … */
  listMinDeltaPp: number;
  /**
   * … and, optionally, at least this |z|. Off (0) by default per SPEC §6; the simulation
   * harness shows 2.5 is needed to keep false counters ≤ 1 per page once volume is high and
   * real effects are strong (docs/METHODOLOGY.md, "Calibration").
   */
  listMinAbsZ: number;
}

export const GATES: Readonly<StatGates> = Object.freeze({
  hideBelow: 15,
  greyBelow: 30,
  listMinN: 50,
  listMinDeltaPp: 1.5,
  listMinAbsZ: 0,
});

/** Recommended significance gate for high-volume windows (see listMinAbsZ). */
export const HIGH_VOLUME_MIN_ABS_Z = 2.5;

export type SampleClass = 'hidden' | 'grey' | 'ok';

export function classifySample(n: number, gates: Partial<StatGates> = {}): SampleClass {
  const g = { ...GATES, ...gates };
  if (!(n >= g.hideBelow)) return 'hidden';
  if (n < g.greyBelow) return 'grey';
  return 'ok';
}

export interface ListOptions extends Partial<StatGates> {
  /** The pair's z; required (else not listable) when listMinAbsZ > 0. */
  z?: number;
}

/** May this pair appear in a "strong against" / "weak against" / "good with" list? */
export function isListable(n: number, deltaPp: number, opts: ListOptions = {}): boolean {
  const g = { ...GATES, ...opts };
  if (!(n >= g.listMinN) || !(Math.abs(deltaPp) >= g.listMinDeltaPp)) return false;
  if (g.listMinAbsZ > 0) return opts.z !== undefined && Math.abs(opts.z) >= g.listMinAbsZ;
  return true;
}

/** {@link isListable} for an Edge (missing n or delta means not listable). */
export function isListableEdge(edge: Pick<Edge, 'n' | 'delta' | 'z'>, gates: Partial<StatGates> = {}): boolean {
  if (edge.n === undefined || edge.delta === undefined) return false;
  const opts: ListOptions = { ...gates };
  if (edge.z !== undefined) opts.z = edge.z;
  return isListable(edge.n, edge.delta, opts);
}

// ---- antisymmetry ------------------------------------------------------------------------------

/** Minimal shape antisymmetrize works on; Edge and PairStat-bearing rows both fit. */
export interface DirectedEstimate {
  a: string;
  b: string;
  delta?: number;
  n?: number;
  z?: number;
  score?: number;
}

/**
 * Counter estimates must satisfy Δ(a,b) = −Δ(b,a). For each (a,b) in `edgesAB` whose mirror
 * (b,a) is in `edgesBA`, returns a copy with Δ = (Δab − Δba)/2, z = (zab − zba)/2,
 * n = min(nab, nba) and the score recomputed; rows without a mirror are returned unchanged.
 * Pass a single list containing both directions as both arguments (the default).
 */
export function antisymmetrize<T extends DirectedEstimate>(edgesAB: readonly T[], edgesBA: readonly T[] = edgesAB): T[] {
  const mirror = new Map<string, T>();
  for (const e of edgesBA) mirror.set(`${e.a}\u0000${e.b}`, e);
  return edgesAB.map((e) => {
    const m = mirror.get(`${e.b}\u0000${e.a}`);
    if (!m || e.a === e.b) return e;
    const out: T = { ...e };
    // Write through the constraint type: T's own property types may be narrower.
    const w: DirectedEstimate = out;
    const delta = ((e.delta ?? 0) - (m.delta ?? 0)) / 2;
    if (e.delta !== undefined || m.delta !== undefined) w.delta = delta;
    if (e.z !== undefined || m.z !== undefined) w.z = ((e.z ?? 0) - (m.z ?? 0)) / 2;
    if (e.n !== undefined && m.n !== undefined) w.n = Math.min(e.n, m.n);
    if (e.score !== undefined) w.score = scoreFromDelta(delta);
    return out;
  });
}

// ---- pair table → Edge[] ------------------------------------------------------------------------

/** One row of a generic pair table: `a` won `wins` of `games` against (or with) `b`. */
export interface PairRow {
  a: string;
  b: string;
  wins: number;
  games: number;
}

export interface EdgesFromPairsOptions {
  /** 'counter': directed a-vs-b, antisymmetrized. 'synergy': undirected, stored with a < b. */
  relation: 'counter' | 'synergy';
  /** Shrunk base rate per entity (proportions). Rows whose entities lack one are skipped. */
  baseRates: Readonly<Record<string, number>>;
  /** Pseudo-count; fitted from the rows with {@link fitPairK} when omitted. */
  k?: number;
  pairK?: PairKOptions;
  /** Display names used in reason text (falls back to the id). */
  names?: Readonly<Record<string, string>>;
  /** SourceRef.id recorded on each reason. */
  source?: string;
  /** Drop pairs below this n (default GATES.hideBelow) so shards only carry displayable rows. */
  minN?: number;
}

interface Est {
  a: string;
  b: string;
  stat: PairStat;
  delta: number;
  z: number;
  n: number;
}

/** Fixed digits for stored numbers so pipeline output is byte-stable. */
const DELTA_DIGITS = 2;
const Z_DIGITS = 2;

/**
 * Turn a pair table plus per-entity base rates into scored `Edge`s (source 'stats') with one
 * stat reason each, e.g. "Wins 54.1% vs Muradin (expected 50.9%), n=812". Output is sorted
 * by (a, b) and independent of row order.
 */
function usableRows(
  rows: readonly PairRow[],
  opts: Pick<EdgesFromPairsOptions, 'relation' | 'baseRates'>,
): (PairRow & { expected: number })[] {
  const expectation = opts.relation === 'counter' ? counterExpectation : synergyExpectation;
  const valid: (PairRow & { expected: number })[] = [];
  for (const r of rows) {
    if (r.a === r.b || !(r.games > 0)) continue;
    const pA = opts.baseRates[r.a];
    const pB = opts.baseRates[r.b];
    if (pA === undefined || pB === undefined || !Number.isFinite(pA) || !Number.isFinite(pB)) continue;
    valid.push({ ...r, wins: clamp(r.wins, 0, r.games), expected: expectation(pA, pB) });
  }
  return valid;
}

/** The k {@link edgesFromPairs} fits when none is given (for logging and run-to-run checks). */
export function fitPairKFromRows(
  rows: readonly PairRow[],
  opts: Pick<EdgesFromPairsOptions, 'relation' | 'baseRates' | 'pairK'>,
): number {
  return fitPairK(
    usableRows(rows, opts).map((r) => ({ wins: r.wins, n: r.games, expected: r.expected })),
    opts.pairK,
  );
}

export function edgesFromPairs(rows: readonly PairRow[], opts: EdgesFromPairsOptions): Edge[] {
  const { relation } = opts;
  const minN = opts.minN ?? GATES.hideBelow;
  const valid = usableRows(rows, opts);
  const k = opts.k ?? fitPairK(valid.map((r) => ({ wins: r.wins, n: r.games, expected: r.expected })), opts.pairK);

  // Duplicate (a,b) rows are summed so callers can feed several sources of the same games.
  const byKey = new Map<string, PairRow & { expected: number }>();
  for (const r of valid) {
    const key = `${r.a}\u0000${r.b}`;
    const prev = byKey.get(key);
    if (prev) byKey.set(key, { ...prev, wins: prev.wins + r.wins, games: prev.games + r.games });
    else byKey.set(key, r);
  }

  const ests: Est[] = [];
  for (const r of byKey.values()) {
    const stat = pairStat({ wins: r.wins, n: r.games }, r.expected, k);
    ests.push({ a: r.a, b: r.b, stat, delta: stat.delta, z: stat.z, n: stat.n });
  }

  let final: Est[];
  if (relation === 'counter') {
    final = antisymmetrize(ests);
  } else {
    // Synergy is symmetric: average the two directions (same games seen from each side).
    const merged = new Map<string, { est: Est; canonical: boolean }>();
    for (const e of ests) {
      const canonical = e.a < e.b;
      const a = canonical ? e.a : e.b;
      const b = canonical ? e.b : e.a;
      const key = `${a}\u0000${b}`;
      const prev = merged.get(key);
      if (!prev) {
        merged.set(key, { est: { ...e, a, b }, canonical });
      } else {
        // The reason text quotes the row recorded from the a < b side when both exist.
        const stat = prev.canonical ? prev.est.stat : e.stat;
        merged.set(key, {
          est: {
            a,
            b,
            stat,
            delta: (prev.est.delta + e.delta) / 2,
            z: (prev.est.z + e.z) / 2,
            n: Math.min(prev.est.n, e.n),
          },
          canonical: true,
        });
      }
    }
    final = [...merged.values()].map((m) => m.est);
  }

  const name = (id: string): string => opts.names?.[id] ?? id;
  const edges: Edge[] = [];
  for (const e of final) {
    if (!(e.n >= minN)) continue;
    const delta = round(e.delta, DELTA_DIGITS);
    const text =
      relation === 'counter'
        ? `Wins ${pct(e.stat.rate)} vs ${name(e.b)} (expected ${pct(e.stat.expected)}), n=${int(e.n)}`
        : `Wins ${pct(e.stat.rate)} together (expected ${pct(e.stat.expected)}), n=${int(e.n)}`;
    const reason: Reason = { kind: 'stat', text, n: e.n, delta };
    if (opts.source !== undefined) reason.source = opts.source;
    edges.push({
      a: e.a,
      b: e.b,
      score: scoreFromDelta(e.delta),
      delta,
      n: e.n,
      z: round(e.z, Z_DIGITS),
      source: 'stats',
      reasons: [reason],
    });
  }
  edges.sort((x, y) => (x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0));
  return edges;
}
