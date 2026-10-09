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
const maps: GameMap[] = buildMaps(fixtureRelease('2.57.0.98348').maps, testCurated().maps, testCurated().rankedPool, null).maps;
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
  });
});
