import { describe, expect, it } from 'vitest';
import { GATES } from '../../../../core/stats.ts';
import { H2HSchema } from '../../schema.ts';
import type { Edge } from '../../../../core/game.ts';
import { capPerSpecies, h2hFromGames } from './h2h.ts';
import type { LedgerGame } from './ledger.ts';

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const POOL = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];

/** Random 4-of-6 games where `a` beats sides that bring `b` 75% of the time. */
function games(n: number, seed = 7): LedgerGame[] {
  const r = rng(seed);
  const pick = (k: number): string[] => [...POOL].sort(() => r() - 0.5).slice(0, k);
  const out: LedgerGame[] = [];
  for (let i = 0; i < n; i++) {
    const one = pick(6);
    const two = pick(6);
    const b1 = one.slice(0, 4);
    const b2 = two.slice(0, 4);
    let p1 = 0.5;
    if (b1.includes('a') && b2.includes('b') && !b2.includes('a')) p1 = 0.75;
    if (b2.includes('a') && b1.includes('b') && !b1.includes('a')) p1 = 0.25;
    out.push({ date: '2026-10-08', winner: r() < p1 ? 1 : 2, sides: [{ team: one, brought: b1 }, { team: two, brought: b2 }] });
  }
  return out;
}

describe('h2hFromGames', () => {
  const names = Object.fromEntries(POOL.map((id) => [id, id.toUpperCase()]));
  const h2h = h2hFromGames(games(3000), {
    regulation: 'M-C',
    format: 'gen9championsvgc2026regmcbo3',
    window: { label: 'Last 30 days', from: '2026-09-09', to: '2026-10-08' },
    names,
  });

  it('is a valid h2h.json with replay-sourced edges', () => {
    expect(H2HSchema.safeParse(h2h).success).toBe(true);
    expect(h2h.replays).toBe(3000);
    expect(h2h.counters.every((e) => e.source === 'replays' && (e.n ?? 0) >= GATES.hideBelow)).toBe(true);
    expect(h2h.counters.every((e) => e.reasons.every((r) => r.source === 'showdown-replays'))).toBe(true);
    expect(h2h.attribution.text).toMatch(/player names removed/);
  });

  it('finds the planted counter, antisymmetric in both directions', () => {
    const ab = h2h.counters.find((e) => e.a === 'a' && e.b === 'b');
    const ba = h2h.counters.find((e) => e.a === 'b' && e.b === 'a');
    // Shrinkage toward the expectation is deliberately strong (k is fitted over every pair),
    // but the planted pair still stands out as the strongest edge and passes the list gate.
    const strongest = [...h2h.counters].sort((x, y) => (y.delta ?? 0) - (x.delta ?? 0))[0];
    expect(strongest).toBe(ab);
    expect(ab?.delta).toBeGreaterThan(GATES.listMinDeltaPp);
    expect(ab?.n).toBeGreaterThanOrEqual(GATES.listMinN);
    expect(ab?.score).toBeGreaterThan(60);
    expect(ba?.delta).toBeCloseTo(-(ab?.delta ?? 0), 6);
    expect(ab?.reasons[0]?.text).toContain('B');
    // Unplanted pairs stay near neutral.
    const cd = h2h.counters.find((e) => e.a === 'c' && e.b === 'd');
    expect(Math.abs(cd?.delta ?? 99)).toBeLessThan(3);
  });

  it('stores synergy once per pair with a < b', () => {
    expect(h2h.synergies.length).toBeGreaterThan(0);
    expect(h2h.synergies.every((e) => e.a < e.b)).toBe(true);
    const keys = h2h.synergies.map((e) => `${e.a}|${e.b}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('is deterministic and drops pairs below the display floor', () => {
    const again = h2hFromGames(games(3000), { regulation: 'M-C', format: 'f1', window: h2h.window, names });
    expect(again.counters).toEqual(h2h.counters);
    const few = h2hFromGames(games(10), { regulation: 'M-C', format: 'f1', window: h2h.window, names });
    expect(few.counters).toEqual([]);
    expect(few.synergies).toEqual([]);
  });
});

describe('capPerSpecies', () => {
  const edge = (a: string, b: string, delta: number, n = 50): Edge => ({ a, b, delta, n, score: 50, source: 'replays', reasons: [] });

  it('keeps the strongest and weakest edges of each species and both directions of a counter', () => {
    const edges = [edge('a', 'b', 5), edge('b', 'a', -5), edge('a', 'c', 0.1), edge('c', 'a', -0.1), edge('a', 'd', -3), edge('d', 'a', 3)];
    const kept = capPerSpecies(edges, 1, true);
    // a keeps a>b (best) and a>d (worst); c keeps its only edge c>a, whose mirror a>c survives too.
    expect(kept).toEqual(edges);
    const pruned = capPerSpecies([edge('a', 'b', 5), edge('a', 'c', 1), edge('a', 'd', -3)], 1, true);
    expect(pruned.map((e) => e.b)).toEqual(['b', 'd']);
  });

  it('lets either endpoint keep an undirected synergy', () => {
    const kept = capPerSpecies([edge('a', 'b', 4), edge('a', 'c', 2), edge('a', 'd', 1), edge('b', 'c', 0)], 1, false);
    // a keeps a-b and a-d; c keeps a-c (its best) and b-c (its worst).
    expect(kept.map((e) => e.a + e.b)).toEqual(['ab', 'ac', 'ad', 'bc']);
  });
});
