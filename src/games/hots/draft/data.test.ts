import { describe, expect, it } from 'vitest';
import { HIDE_BELOW_N, ShardError, conditionText, decodeShard, statHero, statMap, statPair, theoryCounter, theorySynergy } from './data.ts';
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
    expect(theory.statsSource).toBeNull();
    expect(stats.stats?.mode).toBe('sl');
    expect(stats.statsSource).toBe(stats.stats?.source);
  });

  it('rejects malformed shards with a readable message', () => {
    expect(() => decodeShard(null)).toThrow(ShardError);
    expect(() => decodeShard(null)).toThrow(/not a JSON object/);
    expect(() => decodeShard({ ...fixtureShard(), schema: 1 })).toThrow(/unsupported schema/);
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

describe('reason lines and conditions', () => {
  it('splits each reason into its line, its shared template and its conditions', () => {
    const link = theoryCounter(theory, index('Malfurion'), index('Li-Ming'))!;
    const line = link.lines.find((l) => l.text.includes('interrupt channels'))!;
    expect(line.template).toBe('{a} can interrupt channels with silence (Twilight Dream, Astral Communion), and {b} relies on channelled abilities.');
    expect(line.conditions).toEqual(['Malfurion takes Twilight Dream.', 'Li-Ming must also take Disintegrate.']);
    // The full lines stay exactly as theory.json words them.
    expect(link.reasons).toContain(`${line.text} Only when Malfurion takes Twilight Dream. Li-Ming must also take Disintegrate.`);
    expect(link.lines).toHaveLength(link.reasons.length);
  });

  it('splits inline engine conditions and keeps curated conditions as written', () => {
    const shard = fixtureShard();
    const at = shard.reasons.length;
    shard.reasons.push('{a} pins {b} down. Only when {a} takes Big Net.', 'Only the line.', 'Both teams play a lane-soak game.');
    shard.theory.counters.r[0] = [at, [at + 1, at + 2]];
    const d = decodeShard(shard);
    const link = theoryCounter(d, shard.theory.counters.a[0]!, shard.theory.counters.b[0]!)!;
    const [a, b] = [d.heroes[shard.theory.counters.a[0]!]!.name, d.heroes[shard.theory.counters.b[0]!]!.name];
    expect(link.lines[0]).toEqual({ text: `${a} pins ${b} down.`, template: '{a} pins {b} down.', conditions: [`${a} takes Big Net.`] });
    expect(link.lines[1]).toEqual({ text: 'Only the line.', template: 'Only the line.', conditions: ['Both teams play a lane-soak game.'] });
    expect(conditionText(' Only when X takes Y. ')).toBe('X takes Y.');
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
