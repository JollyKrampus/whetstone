import { describe, expect, it } from 'vitest';
import { HIDE_BELOW_N, ShardError, decodeShard, statHero, statMap, statPair, theoryCounter, theorySynergy } from './data.ts';
import { fixtureShard, idOf, statsData, theoryData } from './testkit.ts';

const theory = theoryData();
const stats = statsData();
const index = (name: string) => theory.byId.get(idOf(theory, name))!.index;

describe('decodeShard', () => {
  it('decodes the fixture shard into lookups', () => {
    expect(theory.heroes).toHaveLength(13);
    expect(theory.byId.get('chogall')).toMatchObject({ slots: 2, members: ['CCho', 'Gall'] });
    expect(theory.maps.some((m) => m.kind === 'aram')).toBe(true);
    expect(theory.stats).toBeNull();
    expect(stats.stats?.mode).toBe('sl');
  });

  it('rejects malformed shards with a readable message', () => {
    expect(() => decodeShard(null)).toThrow(ShardError);
    expect(() => decodeShard(null)).toThrow(/not a JSON object/);
    expect(() => decodeShard({ ...fixtureShard(), schema: 2 })).toThrow(/unsupported schema/);
    const bad = fixtureShard();
    bad.heroes.name.pop();
    expect(() => decodeShard(bad)).toThrow(/heroes.name has 12 entries/);
    const outside = fixtureShard();
    outside.theory.counters.b[0] = 999;
    expect(() => decodeShard(outside)).toThrow(/points outside the tables/);
  });

  it('stores synergy edges in both directions and counters in one', () => {
    const a = theory.heroes.find((h) => theory.synergies.get(h.index)?.size)!;
    const [b, link] = [...theory.synergies.get(a.index)!.entries()][0]!;
    expect(theorySynergy(theory, b, a.index)).toBe(link);
    const [ca, row] = [...theory.counters.entries()][0]!;
    const [cb] = [...row.keys()];
    expect(theoryCounter(theory, ca, cb!)).toBeDefined();
    expect(theoryCounter(theory, cb!, ca) === theoryCounter(theory, ca, cb!)).toBe(false);
  });
});

describe('statistics lookups', () => {
  it('return nothing without a statistics block', () => {
    expect(statHero(theory, 0)).toBeNull();
    expect(statPair(theory, 'counters', 0, 1)).toBeNull();
    expect(statMap(theory, 0, 0)).toBeNull();
  });

  it(`hide cells below n = ${HIDE_BELOW_N} and never pair a hero with itself`, () => {
    const s = stats.stats!;
    const H = stats.heroes.length;
    const valla = index('Valla');
    const muradin = index('Muradin');
    expect(statPair(stats, 'counters', valla, valla)).toBeNull();
    const cell = statPair(stats, 'counters', valla, muradin);
    expect(cell?.n).toBeGreaterThanOrEqual(HIDE_BELOW_N);
    // Thin the same cell below the gate: it disappears.
    const thin = decodeShard({ ...fixtureShard(), stats: { ...s, counters: { ...s.counters, n: s.counters.n.map((n, k) => (k === valla * H + muradin ? HIDE_BELOW_N - 1 : n)) } } });
    expect(statPair(thin, 'counters', valla, muradin)).toBeNull();
  });

  it('reads hero rows and hero × map cells', () => {
    const hero = statHero(stats, index('Valla'))!;
    expect(hero.games).toBeGreaterThan(0);
    expect(hero.shrunk).toBeGreaterThan(0);
    const cursed = stats.mapById.get('cursed-hollow')!;
    expect(statMap(stats, index('Valla'), cursed.index)?.n).toBeGreaterThanOrEqual(HIDE_BELOW_N);
  });
});
