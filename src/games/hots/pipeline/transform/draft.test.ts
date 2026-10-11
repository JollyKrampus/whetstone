import { describe, expect, it } from 'vitest';
import { DraftShardSchema, type GameMap, type Hero, type Theory } from '../../schema.ts';
import { FIXTURE_NOW, fixtureRelease, testCurated } from '../test-helpers.ts';
import { buildDraftShard, entityOrder } from './draft.ts';
import { buildHeroes } from './heroes.ts';
import { buildMaps } from './maps.ts';

const heroes: Hero[] = buildHeroes(fixtureRelease('2.57.0.98348'), { aliases: testCurated().aliases, now: FIXTURE_NOW }).heroes.map((h) => ({
  ...h,
  mechanics: h.id === 'HXAL' ? [{ tag: 'reveal', evidence: [{ kind: 'ability', name: 'Shadow Mark', snippet: 'Revealed' }] }] : [],
}));
const maps: GameMap[] = buildMaps(fixtureRelease('2.57.0.98348').maps, testCurated().maps, testCurated().rankedPool).maps;
const theory: Theory = {
  rulesVersion: 'test',
  counters: [
    { a: 'HXAL', b: 'Abat', score: 70, source: 'theory', reasons: [{ kind: 'theory', text: 'Reveal finds a stealthy hero' }] },
    { a: 'Abat', b: 'nobody', score: 40, source: 'theory', reasons: [] },
  ],
  synergies: [{ a: 'Abat', b: 'chogall', score: 60, source: 'curated', reasons: [{ kind: 'curated', text: 'Reveal finds a stealthy hero' }] }],
  mapFit: [{ hero: 'HXAL', map: 'cursed-hollow', score: 55, reasons: [{ kind: 'map', text: 'Good on large maps' }] }],
};

describe('entityOrder', () => {
  it('sorts by release date then id, so a newly released hero is appended', () => {
    const list = [
      { id: 'B', releaseDate: '2020-01-01' },
      { id: 'A', releaseDate: '2020-01-01' },
      { id: 'NEW', releaseDate: '2026-09-28' },
      { id: 'OLD', releaseDate: '2014-03-13' },
      { id: 'NODATE' },
    ];
    expect(entityOrder(list).map((e) => e.id)).toEqual(['OLD', 'A', 'B', 'NEW', 'NODATE']);
    const before = entityOrder(list.filter((e) => e.id !== 'NEW' && e.id !== 'NODATE')).map((e) => e.id);
    expect(entityOrder(list).map((e) => e.id).slice(0, before.length)).toEqual(before);
  });
});

describe('buildDraftShard', () => {
  const shard = buildDraftShard({ build: '2.57.0.98348', major: '2.57', heroes, maps, theory });

  it('is a valid columnar shard of draftable entities', () => {
    expect(DraftShardSchema.safeParse(shard).success).toBe(true);
    expect(shard.heroes.id).not.toContain('CCho');
    expect(shard.heroes.id).toContain('chogall');
    const i = shard.heroes.id.indexOf('chogall');
    expect(shard.heroes.slots[i]).toBe(2);
    expect(shard.heroes.members[i]).toEqual(['CCho', 'Gall']);
    expect(shard.heroes.id[shard.heroes.id.length - 1]).toBe('HXAL');
    expect(shard.heroes.tags[shard.heroes.id.indexOf('HXAL')]).toEqual(['reveal']);
  });

  it('indexes edges and map fit, deduplicates reasons and drops unknown entities', () => {
    expect(shard.reasons).toEqual(['Reveal finds a stealthy hero', 'Good on large maps']);
    expect(shard.theory.counters.a).toHaveLength(1);
    expect(shard.heroes.id[shard.theory.counters.a[0] ?? -1]).toBe('HXAL');
    expect(shard.theory.synergies.r).toEqual([[0]]);
    expect(shard.maps.id[shard.theory.mapFit.map[0] ?? -1]).toBe('cursed-hollow');
    // No reason has conditions: no cond tables at all (the shard stays byte-identical).
    expect('cond' in shard.theory.counters || 'cond' in shard.theory.synergies || 'cond' in shard.theory.mapFit).toBe(false);
  });
});

describe('reason conditions in the shard', () => {
  const withConditions: Theory = {
    ...theory,
    counters: [
      {
        a: 'Abat',
        b: 'HXAL',
        score: 66,
        source: 'curated',
        reasons: [
          { kind: 'curated', text: "Abathur's nests spot Xal'atath early", conditions: ["Xal'atath plays a lane alone", 'Abathur takes Prolific Dispersal'] },
          { kind: 'theory', text: 'Reveal finds a stealthy hero' },
        ],
      },
    ],
    mapFit: [{ hero: 'HXAL', map: 'cursed-hollow', score: 55, reasons: [{ kind: 'map', text: 'Good on large maps', conditions: ['Cursed Hollow tributes split the teams'] }] }],
  };
  const shard = buildDraftShard({ build: '2.57.0.98348', major: '2.57', heroes, maps, theory: withConditions });
  const fill = (t: string, a: string, b: string) => t.split('{a}').join(a).split('{b}').join(b).split('{m}').join(b);

  it('lists them in an optional cond table, templated like the reason lines', () => {
    expect(DraftShardSchema.safeParse(shard).success).toBe(true);
    const cond = shard.theory.counters.cond;
    expect(cond?.e).toEqual([0]);
    expect(cond?.k).toEqual([0]);
    expect(cond?.c[0]?.map((i) => shard.reasons[i])).toEqual(['{b} plays a lane alone', '{a} takes Prolific Dispersal']);
    // `r` is unchanged, so a reader that ignores `cond` still decodes every reason line.
    expect(shard.theory.counters.r[0]?.map((x) => (typeof x === 'number' ? shard.reasons[x] : null))).toEqual(["{a}'s nests spot {b} early", 'Reveal finds a stealthy hero']);
    expect(shard.theory.synergies.cond).toBeUndefined();
  });

  it('decodes back to the reasons and conditions of theory.json', () => {
    const ids = shard.heroes.id;
    const names = shard.heroes.name;
    const t = shard.theory.counters;
    const row = 0;
    const [a, b] = [names[t.a[row] ?? -1] ?? '', names[t.b[row] ?? -1] ?? ''];
    expect([ids[t.a[row] ?? -1], ids[t.b[row] ?? -1]]).toEqual(['Abat', 'HXAL']);
    const conditions = (t.cond?.c[0] ?? []).map((i) => fill(shard.reasons[i] ?? '', a, b));
    expect(conditions).toEqual(withConditions.counters[0]?.reasons[0]?.conditions);
    const fit = shard.theory.mapFit;
    expect((fit.cond?.c[0] ?? []).map((i) => fill(shard.reasons[i] ?? '', names[fit.hero[0] ?? -1] ?? '', shard.maps.name[fit.map[0] ?? -1] ?? ''))).toEqual(['Cursed Hollow tributes split the teams']);
  });

  it('rejects a cond table that points outside its rows or reasons', () => {
    const broken = { ...shard, theory: { ...shard.theory, counters: { ...shard.theory.counters, cond: { e: [5], k: [0], c: [[0]] } } } };
    expect(DraftShardSchema.safeParse(broken).success).toBe(false);
  });
});
