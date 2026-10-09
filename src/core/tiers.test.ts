import { describe, expect, it } from 'vitest';
import {
  EARLY,
  HOTS_TIERS,
  POKEMON_TIERS,
  assignTiers,
  bandFor,
  pokemonTierValue,
  tierRank,
  type TierConfig,
} from './tiers.ts';

describe('bandFor (HotS bands in pp)', () => {
  it.each([
    [3, 'T1'],
    [2.5, 'T1'],
    [2.49, 'T2'],
    [1, 'T2'],
    [0.99, 'T3'],
    [0, 'T3'],
    [-0.99, 'T3'],
    [-1, 'T4'],
    [-2.49, 'T4'],
    [-2.5, 'T5'],
    [-9, 'T5'],
  ])('%f pp → %s', (metric, tier) => {
    expect(bandFor(metric)).toBe(tier);
  });

  it('falls through to the last band for NaN', () => {
    expect(bandFor(Number.NaN)).toBe('T5');
  });
});

describe('assignTiers', () => {
  it('bands shrunk win rates and gates on n', () => {
    const out = assignTiers([
      { id: 'b', value: 0.53, n: 900 },
      { id: 'a', value: 0.53, n: 900 },
      { id: 'c', value: 0.49, n: 900 },
      { id: 'd', value: 0.475, n: 900 },
      { id: 'e', value: 0.56, n: 120 },
      { id: 'f', value: 0.51, n: 900 },
    ]);
    expect(out.map((r) => [r.id, r.tier])).toEqual([
      ['a', 'T1'],
      ['b', 'T1'],
      ['f', 'T2'],
      ['c', 'T4'],
      ['d', 'T5'],
      ['e', EARLY],
    ]);
    expect(out[0]!.metric).toBe(3);
    expect(out.find((r) => r.id === 'e')).toMatchObject({ early: true, change: 'unranked' });
  });

  it('reports tier change and Δ vs previous', () => {
    const out = assignTiers([
      { id: 'up', value: 0.53, n: 500, previous: { value: 0.505, tier: 'T3' } },
      { id: 'down', value: 0.48, n: 500, previous: { value: 0.52, tier: 'T2' } },
      { id: 'same', value: 0.5, n: 500, previous: { value: 0.502, tier: 'T3' } },
      { id: 'new', value: 0.5, n: 500 },
      { id: 'was-early', value: 0.5, n: 500, previous: { tier: EARLY } },
    ]);
    const by = Object.fromEntries(out.map((r) => [r.id, r]));
    expect(by['up']).toMatchObject({ change: 'up', previousTier: 'T3', deltaPrevious: 2.5 });
    expect(by['down']).toMatchObject({ change: 'down', previousTier: 'T2', deltaPrevious: -4 });
    expect(by['same']).toMatchObject({ change: 'same', deltaPrevious: -0.2 });
    expect(by['new']!.change).toBe('new');
    expect(by['new']!.deltaPrevious).toBeUndefined();
    expect('deltaPrevious' in by['new']!).toBe(false);
    expect(by['was-early']!.change).toBe('new');
  });

  it('nudges by ban rate when configured', () => {
    const config: TierConfig = { ...HOTS_TIERS, banNudge: 0.1 };
    const entries = [
      { id: 'banned', value: 0.52, n: 500, banRate: 0.4 },
      { id: 'open', value: 0.52, n: 500, banRate: 0.0 },
    ];
    const plain = assignTiers(entries);
    expect(plain.map((r) => r.tier)).toEqual(['T2', 'T2']);
    const nudged = assignTiers(entries, config);
    // mean ban 0.2 → ±0.02 → ±2 pp.
    expect(nudged.map((r) => [r.id, r.tier, r.metric])).toEqual([
      ['banned', 'T1', 4],
      ['open', 'T3', 0],
    ]);
  });

  it('treats non-finite values as early data', () => {
    const [r] = assignTiers([{ id: 'x', value: Number.NaN, n: 1000 }]);
    expect(r).toMatchObject({ tier: EARLY, early: true });
  });

  it('is deterministic regardless of input order', () => {
    const entries = Array.from({ length: 30 }, (_, i) => ({ id: `h${i}`, value: 0.47 + (i % 7) * 0.01, n: 150 + i * 10 }));
    expect(assignTiers([...entries].reverse())).toEqual(assignTiers(entries));
  });

  it('exposes band ranks', () => {
    expect(tierRank('T1')).toBe(0);
    expect(tierRank('T5')).toBe(4);
    expect(tierRank(EARLY)).toBeUndefined();
    expect(tierRank(undefined)).toBeUndefined();
  });
});

describe('Pokémon tiers', () => {
  it('uses usage % and only credible win-rate edges', () => {
    expect(pokemonTierValue({ usagePct: 12 })).toBe(12);
    // 6–1 is not enough games to count.
    expect(pokemonTierValue({ usagePct: 12, wins: 6, games: 7 })).toBe(12);
    // 50 % with a wide interval adds nothing.
    expect(pokemonTierValue({ usagePct: 12, wins: 100, games: 200 })).toBe(12);
    const strong = pokemonTierValue({ usagePct: 12, wins: 650, games: 1000 });
    expect(strong).toBeGreaterThan(12 + 0.5 * 11);
    expect(strong).toBeLessThan(12 + 0.5 * 15);
    expect(pokemonTierValue({ usagePct: 12, wins: 350, games: 1000 })).toBeLessThan(12 - 5);
  });

  it('bands on the usage scale', () => {
    const out = assignTiers(
      [
        { id: 'incineroar', value: pokemonTierValue({ usagePct: 41 }), n: 900 },
        { id: 'sneasler', value: pokemonTierValue({ usagePct: 11, wins: 300, games: 520 }), n: 520 },
        { id: 'rare', value: pokemonTierValue({ usagePct: 1.2 }), n: 12 },
        { id: 'niche', value: 2, n: 60 },
      ],
      POKEMON_TIERS,
    );
    expect(out.map((r) => [r.id, r.tier])).toEqual([
      ['incineroar', 'S'],
      ['sneasler', 'A'],
      ['niche', 'C'],
      ['rare', EARLY],
    ]);
  });
});
