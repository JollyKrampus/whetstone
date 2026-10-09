import { describe, expect, it } from 'vitest';
import type { Edge } from './game.ts';
import {
  GATES,
  HIGH_VOLUME_MIN_ABS_Z,
  PROB_EPS,
  SCORE_SCALE_PP,
  antisymmetrize,
  classifySample,
  counterExpectation,
  edgesFromPairs,
  fitBetaPrior,
  fitPairK,
  fitPairKFromRows,
  isListable,
  isListableEdge,
  isVoteCollapsed,
  logit,
  pairStat,
  priorFor,
  scoreFromDelta,
  shrinkAll,
  shrinkRate,
  sigmoid,
  synergyExpectation,
  voteScore,
  wilsonInterval,
  wilsonLower,
  wilsonLowerScore,
} from './stats.ts';

describe('wilsonInterval', () => {
  it('matches the closed form at p = 0.5, n = 100', () => {
    const ci = wilsonInterval(50, 100);
    expect(ci.center).toBeCloseTo(0.5, 12);
    expect(ci.lower).toBeCloseTo(0.403829, 5);
    expect(ci.upper).toBeCloseTo(0.596171, 5);
  });

  it('is uninformative without data and stays inside [0, 1]', () => {
    expect(wilsonInterval(0, 0)).toEqual({ lower: 0, upper: 1, center: 0.5 });
    const zero = wilsonInterval(0, 10);
    expect(zero.lower).toBe(0);
    expect(zero.upper).toBeGreaterThan(0);
    const all = wilsonInterval(10, 10);
    expect(all.upper).toBeLessThanOrEqual(1);
    expect(all.lower).toBeGreaterThan(0.6);
  });

  it('clamps k into [0, n] and narrows with n', () => {
    expect(wilsonInterval(15, 10)).toEqual(wilsonInterval(10, 10));
    const small = wilsonInterval(6, 10);
    const big = wilsonInterval(600, 1000);
    expect(big.upper - big.lower).toBeLessThan(small.upper - small.lower);
  });

  it('agrees with wilsonLower', () => {
    for (const [k, n] of [
      [3, 7],
      [40, 90],
      [812, 1500],
    ] as const) {
      expect(wilsonInterval(k, n).lower).toBeCloseTo(wilsonLower(k, n), 12);
    }
  });
});

describe('wilsonLowerScore (heroescounters formula)', () => {
  // up/down → points, verified 27,700/27,700 rows on heroescounters.com (hc-features §9).
  const cases: [number, number, number][] = [
    [1, 0, 21],
    [2, 0, 34],
    [4, 0, 51],
    [10, 0, 72],
    [23, 0, 86],
    [36, 0, 90],
    [1, 1, 9],
    [4, 2, 30],
    [452, 237, 62],
    [3262, 76, 97],
    [1, 11, 1],
  ];
  it.each(cases)('%i up / %i down → %i', (up, down, points) => {
    expect(voteScore(up, down)).toBe(points);
    expect(wilsonLowerScore(up, up + down)).toBe(points);
  });

  it('uses the raw (unrounded) bound for the "View more" collapse', () => {
    expect(wilsonLower(4, 6)).toBeLessThan(0.3);
    expect(isVoteCollapsed(4, 2)).toBe(true);
    expect(wilsonLower(21, 49)).toBeGreaterThan(0.3);
    expect(isVoteCollapsed(21, 28)).toBe(false);
  });

  it('scores no votes as 0', () => {
    expect(voteScore(0, 0)).toBe(0);
  });
});

describe('logit / sigmoid', () => {
  it('are inverses on the open interval', () => {
    for (const p of [0.01, 0.2, 0.5, 0.731, 0.99]) expect(sigmoid(logit(p))).toBeCloseTo(p, 12);
    expect(logit(0.5)).toBe(0);
  });

  it('clamp instead of returning infinities', () => {
    expect(Number.isFinite(logit(0))).toBe(true);
    expect(Number.isFinite(logit(1))).toBe(true);
    expect(logit(0)).toBeCloseTo(logit(PROB_EPS), 12);
    expect(logit(-3)).toBe(logit(0));
    expect(sigmoid(1000)).toBe(1);
    expect(sigmoid(-1000)).toBe(0);
    expect(Number.isNaN(sigmoid(-1000))).toBe(false);
  });
});

describe('fitBetaPrior', () => {
  it('recovers mean and strength when binomial noise is negligible', () => {
    const rates = [0.48, 0.52, 0.48, 0.52];
    const ns = [1e9, 1e9, 1e9, 1e9];
    const fit = fitBetaPrior(rates, ns);
    expect(fit.mu).toBeCloseTo(0.5, 9);
    expect(fit.tau2).toBeCloseTo(0.0004, 6);
    expect(fit.kappa).toBeCloseTo(0.25 / 0.0004 - 1, 1);
    expect(fit.alpha + fit.beta).toBeCloseTo(fit.kappa, 9);
    expect(fit.degenerate).toBe(false);
  });

  it('weights the mean by sample size', () => {
    const fit = fitBetaPrior([0.6, 0.4], [300, 100]);
    expect(fit.mu).toBeCloseTo(0.55, 12);
  });

  it('guards degenerate spread (all units equal) with the maximum strength', () => {
    const fit = fitBetaPrior([0.5, 0.5, 0.5], [100, 200, 300], { maxKappa: 4000 });
    expect(fit.degenerate).toBe(true);
    expect(fit.kappa).toBe(4000);
  });

  it('falls back when there is no data, and ignores junk units', () => {
    const empty = fitBetaPrior([], []);
    expect(empty).toMatchObject({ mu: 0.5, degenerate: true, used: 0 });
    const junk = fitBetaPrior([Number.NaN, 0.5, 0.7], [10, 0, -5]);
    expect(junk.degenerate).toBe(true);
    expect(junk.mu).toBe(0.5);
  });

  it('handles all-wins data without NaN', () => {
    const fit = fitBetaPrior([1, 1], [10, 20]);
    expect(fit.degenerate).toBe(true);
    expect(Number.isFinite(fit.kappa)).toBe(true);
  });
});

describe('shrinkRate / priorFor / shrinkAll', () => {
  it('computes the posterior mean', () => {
    expect(shrinkRate(60, 100, { mu: 0.5, kappa: 100 })).toBeCloseTo(0.55, 12);
    expect(shrinkRate(0, 0, { mu: 0.47, kappa: 100 })).toBe(0.47);
    expect(shrinkRate(5, 5, { mu: 0.5, kappa: 0 })).toBe(1);
  });

  it('carries last patch for unchanged entities at half strength', () => {
    const pop = { mu: 0.5, kappa: 400 };
    expect(priorFor(pop, 0.53)).toEqual({ mu: 0.53, kappa: 200 });
    expect(priorFor(pop, null)).toBe(pop);
    expect(priorFor(pop, undefined)).toBe(pop);
    expect(priorFor(pop, 1.2)).toBe(pop);
  });

  it('shrinks a roster and uses previous rates where given', () => {
    const units = [
      { id: 'a', wins: 520, n: 1000 },
      { id: 'b', wins: 480, n: 1000 },
      { id: 'c', wins: 3, n: 4 },
    ];
    const { prior, rates } = shrinkAll(units, { previous: { b: 0.52 } });
    expect(Object.keys(rates)).toEqual(['a', 'b', 'c']);
    expect(rates['c']!).toBeLessThan(0.75);
    expect(Math.abs(rates['c']! - prior.mu)).toBeLessThan(0.02);
    const noPrev = shrinkAll(units).rates;
    expect(rates['b']!).toBeGreaterThan(noPrev['b']!);
  });
});

describe('expectations', () => {
  it('counter expectation is logit-additive and complementary', () => {
    expect(counterExpectation(0.5, 0.5)).toBeCloseTo(0.5, 12);
    expect(counterExpectation(0.55, 0.45)).toBeCloseTo(sigmoid(2 * logit(0.55)), 12);
    expect(counterExpectation(0.53, 0.49) + counterExpectation(0.49, 0.53)).toBeCloseTo(1, 12);
    // To first order: pA − pB + 0.5.
    expect(counterExpectation(0.51, 0.5)).toBeCloseTo(0.51, 3);
  });

  it('synergy expectation is neutral against an average partner', () => {
    expect(synergyExpectation(0.5, 0.53)).toBeCloseTo(0.53, 12);
    expect(synergyExpectation(0.52, 0.52)).toBeGreaterThan(0.53);
  });
});

describe('pairStat / scoreFromDelta', () => {
  it('shrinks toward the expectation and reports pp, z and score', () => {
    const s = pairStat({ wins: 60, n: 100 }, 0.5, 100);
    expect(s.rate).toBeCloseTo(0.6, 12);
    expect(s.shrunk).toBeCloseTo(0.55, 12);
    expect(s.delta).toBeCloseTo(5, 10);
    expect(s.z).toBeCloseTo(2, 10);
    expect(s.score).toBe(Math.round(50 + 50 * Math.tanh(5 / 4)));
    expect(s.n).toBe(100);
  });

  it('is neutral without data', () => {
    const s = pairStat({ wins: 0, n: 0 }, 0.52, 200);
    expect(s).toMatchObject({ n: 0, rate: 0.52, shrunk: 0.52, delta: 0, z: 0, score: 50 });
  });

  it('maps pp with tanh(Δ/4) — identical to tanh(Δ/0.04) on proportions', () => {
    expect(SCORE_SCALE_PP).toBe(4);
    expect(scoreFromDelta(0)).toBe(50);
    expect(scoreFromDelta(4)).toBe(88);
    expect(scoreFromDelta(-4)).toBe(12);
    expect(scoreFromDelta(1.5)).toBe(Math.round(50 + 50 * Math.tanh(0.015 / 0.04)));
    expect(scoreFromDelta(100)).toBe(100);
    expect(scoreFromDelta(-100)).toBe(1);
    expect(scoreFromDelta(Number.NaN)).toBe(50);
  });
});

describe('gates', () => {
  it('classifies sample sizes', () => {
    expect(classifySample(0)).toBe('hidden');
    expect(classifySample(14)).toBe('hidden');
    expect(classifySample(15)).toBe('grey');
    expect(classifySample(29)).toBe('grey');
    expect(classifySample(30)).toBe('ok');
    expect(classifySample(Number.NaN)).toBe('hidden');
    expect(classifySample(20, { greyBelow: 20 })).toBe('ok');
  });

  it('lists only with enough n and a large enough effect', () => {
    expect(isListable(50, 1.5)).toBe(true);
    expect(isListable(50, -1.5)).toBe(true);
    expect(isListable(49, 9)).toBe(false);
    expect(isListable(500, 1.49)).toBe(false);
    expect(GATES).toEqual({ hideBelow: 15, greyBelow: 30, listMinN: 50, listMinDeltaPp: 1.5, listMinAbsZ: 0 });
    expect(Object.isFrozen(GATES)).toBe(true);
  });

  it('applies the optional significance gate only when asked', () => {
    expect(isListable(400, 2, { z: 1 })).toBe(true);
    expect(isListable(400, 2, { z: 1, listMinAbsZ: HIGH_VOLUME_MIN_ABS_Z })).toBe(false);
    expect(isListable(400, -2, { z: -2.6, listMinAbsZ: HIGH_VOLUME_MIN_ABS_Z })).toBe(true);
    expect(isListable(400, 2, { listMinAbsZ: 2.5 })).toBe(false);
  });

  it('gates edges', () => {
    expect(isListableEdge({ n: 60, delta: 2 })).toBe(true);
    expect(isListableEdge({ delta: 2 })).toBe(false);
    expect(isListableEdge({ n: 60, delta: 2, z: 1.2 }, { listMinAbsZ: 2.5 })).toBe(false);
    expect(isListableEdge({ n: 60, delta: 2, z: 3 }, { listMinAbsZ: 2.5 })).toBe(true);
  });
});

describe('antisymmetrize', () => {
  it('averages mirror estimates so Δ(a,b) = −Δ(b,a)', () => {
    const rows = [
      { a: 'x', b: 'y', delta: 3, z: 2, n: 100, score: 0 },
      { a: 'y', b: 'x', delta: -1, z: -1, n: 90, score: 0 },
      { a: 'x', b: 'z', delta: 2, z: 1, n: 40, score: 0 },
    ];
    const out = antisymmetrize(rows);
    expect(out[0]).toEqual({ a: 'x', b: 'y', delta: 2, z: 1.5, n: 90, score: scoreFromDelta(2) });
    expect(out[1]).toEqual({ a: 'y', b: 'x', delta: -2, z: -1.5, n: 90, score: scoreFromDelta(-2) });
    expect(out[2]).toBe(rows[2]);
    expect(rows[0]!.delta).toBe(3);
  });

  it('accepts separate forward and reverse lists', () => {
    const fwd = [{ a: 'p', b: 'q', delta: 4 }];
    const rev = [{ a: 'q', b: 'p', delta: -2 }];
    expect(antisymmetrize(fwd, rev)).toEqual([{ a: 'p', b: 'q', delta: 3 }]);
  });
});

describe('fitPairK', () => {
  it('shrinks as hard as allowed when residuals are pure noise', () => {
    const units = Array.from({ length: 50 }, () => ({ wins: 50, n: 100, expected: 0.5 }));
    expect(fitPairK(units)).toBe(2000);
    expect(fitPairK([])).toBe(2000);
  });

  it('shrinks lightly when residuals are large', () => {
    const units = Array.from({ length: 40 }, (_, i) => ({ wins: i % 2 ? 700 : 300, n: 1000, expected: 0.5 }));
    // tau² ≈ 0.04 − 0.00025 → k ≈ 0.25 / 0.03975 ≈ 6.3 → clamped to minK.
    expect(fitPairK(units)).toBe(25);
    expect(fitPairK(units, { minK: 1 })).toBeCloseTo(0.25 / (0.04 - 0.00025), 6);
  });

  it('ignores units below minN', () => {
    const units = [
      { wins: 29, n: 29, expected: 0.5 },
      { wins: 50, n: 100, expected: 0.5 },
    ];
    expect(fitPairK(units, { maxK: 999 })).toBe(999);
  });
});

describe('edgesFromPairs', () => {
  const names = { A: 'Abathur', B: 'Muradin', C: 'Chen' };
  const baseRates = { A: 0.509, B: 0.5, C: 0.49 };

  it('builds directed, antisymmetric counter edges with a stat reason', () => {
    const rows = [
      { a: 'B', b: 'A', wins: 373, games: 812 },
      { a: 'A', b: 'B', wins: 439, games: 812 },
      { a: 'A', b: 'C', wins: 5, games: 10 },
    ];
    const edges = edgesFromPairs(rows, { relation: 'counter', baseRates, k: 200, names, source: 'hp' });
    expect(edges.map((e) => `${e.a}>${e.b}`)).toEqual(['A>B', 'B>A']);
    const [ab, ba] = edges as [Edge, Edge];
    expect(ab.reasons).toEqual([
      { kind: 'stat', text: 'Wins 54.1% vs Muradin (expected 50.9%), n=812', n: 812, delta: ab.delta, source: 'hp' },
    ]);
    expect(ba.reasons[0]!.text).toBe('Wins 45.9% vs Abathur (expected 49.1%), n=812');
    expect(ab.delta).toBeCloseTo(-(ba.delta ?? 0), 10);
    const expected = pairStat({ wins: 439, n: 812 }, counterExpectation(0.509, 0.5), 200);
    expect(ab.delta).toBeCloseTo(expected.delta, 2);
    expect(ab.score).toBe(scoreFromDelta(expected.delta));
    expect(ab.source).toBe('stats');
    expect(ab.n).toBe(812);
    expect(ab.z).toBeCloseTo(expected.z, 2);
  });

  it('is independent of row order and skips unusable rows', () => {
    const rows = [
      { a: 'A', b: 'B', wins: 60, games: 100 },
      { a: 'B', b: 'A', wins: 40, games: 100 },
      { a: 'A', b: 'A', wins: 5, games: 10 },
      { a: 'A', b: 'X', wins: 50, games: 90 },
      { a: 'C', b: 'B', wins: 0, games: 0 },
    ];
    const one = edgesFromPairs(rows, { relation: 'counter', baseRates, k: 300 });
    const two = edgesFromPairs([...rows].reverse(), { relation: 'counter', baseRates, k: 300 });
    expect(two).toEqual(one);
    expect(one).toHaveLength(2);
    expect(one[0]!.reasons[0]!.source).toBeUndefined();
    expect('source' in one[0]!.reasons[0]!).toBe(false);
  });

  it('builds undirected synergy edges stored with a < b', () => {
    const rows = [
      { a: 'C', b: 'A', wins: 70, games: 120 },
      { a: 'A', b: 'C', wins: 70, games: 120 },
      { a: 'B', b: 'A', wins: 30, games: 60 },
    ];
    const edges = edgesFromPairs(rows, { relation: 'synergy', baseRates, k: 150 });
    expect(edges.map((e) => `${e.a}+${e.b}`)).toEqual(['A+B', 'A+C']);
    const ac = edges[1]!;
    const s = pairStat({ wins: 70, n: 120 }, synergyExpectation(0.509, 0.49), 150);
    expect(ac.delta).toBeCloseTo(s.delta, 2);
    expect(ac.reasons[0]!.text).toBe(`Wins 58.3% together (expected ${(s.expected * 100).toFixed(1)}%), n=120`);
  });

  it('fits k from the table when none is given', () => {
    const rows = [
      { a: 'A', b: 'B', wins: 52, games: 100 },
      { a: 'B', b: 'A', wins: 48, games: 100 },
    ];
    const edges = edgesFromPairs(rows, { relation: 'counter', baseRates: { A: 0.5, B: 0.5 } });
    // Pure-noise residual → maximal shrinkage → tiny delta.
    expect(Math.abs(edges[0]!.delta ?? 1)).toBeLessThan(0.2);
    const k = fitPairKFromRows(rows, { relation: 'counter', baseRates: { A: 0.5, B: 0.5 } });
    expect(edgesFromPairs(rows, { relation: 'counter', baseRates: { A: 0.5, B: 0.5 }, k })).toEqual(edges);
  });
});
