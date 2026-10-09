import { describe, expect, it } from 'vitest';
import { DraftShardSchema, StatsSchema, StatsWindowSchema, type GameMap, type Hero } from '../../schema.ts';
import { FIXTURE_NOW, fixtureRelease, testCurated } from '../test-helpers.ts';
import { buildDraftShard } from './draft.ts';
import { buildHeroes } from './heroes.ts';
import { buildMaps } from './maps.ts';
import { buildDraftStatsBlock, buildStats, buildStatsWindow, entityResolver, mapShares, poolWindows, type HpWindowData } from './stats.ts';

const heroes: Hero[] = buildHeroes(fixtureRelease('2.57.0.98348'), { aliases: testCurated().aliases, now: FIXTURE_NOW }).heroes.map((h) => ({ ...h, mechanics: [] }));
const maps: GameMap[] = buildMaps(fixtureRelease('2.57.0.98348').maps, testCurated().maps, testCurated().rankedPool, null).maps;

/** Synthetic Heroes Profile numbers in OUR row shape (never real HP data). */
function synthetic(scale = 1): HpWindowData {
  const names = ['Abathur', 'Alexstrasza', 'Cho', 'Gall', "Xal'atath"];
  const wr: Record<string, number> = { Abathur: 0.47, Alexstrasza: 0.53, Cho: 0.5, Gall: 0.5, "Xal'atath": 0.56 };
  const heroRows = names.map((hero) => ({ hero, games: 1000 * scale, wins: Math.round(1000 * scale * (wr[hero] ?? 0.5)), bans: 100 * scale }));
  const enemies = [];
  const allies = [];
  for (const a of names) {
    for (const b of names) {
      if (a === b) continue;
      enemies.push({ hero: a, other: b, games: 200 * scale, wins: Math.round(200 * scale * (a === "Xal'atath" ? 0.6 : 0.5)) });
      allies.push({ hero: a, other: b, games: 150 * scale, wins: Math.round(150 * scale * 0.52) });
    }
  }
  return {
    heroes: heroRows,
    maps: names.flatMap((hero) => [
      { hero, map: 'Cursed Hollow', games: 300 * scale, wins: 160 * scale },
      { hero, map: 'Sky Temple', games: 10 * scale, wins: 6 * scale },
    ]),
    enemies,
    allies,
    builds: [
      { hero: "Xal'atath", talents: ['A', 'B', 'C', 'D', 'E', 'F', 'G'], games: 400 * scale, wins: 240 * scale },
      { hero: "Xal'atath", talents: ['A', 'B', 'C', 'D', 'E', 'F', 'H'], games: 12 * scale, wins: 11 * scale },
    ],
  };
}

const opts = { entities: heroes, maps, label: 'Storm League, patch 2.57', major: '2.57', patchBuilds: ['2.57.0.98348', '2.57.0.98285'] };

describe('buildStatsWindow', () => {
  const { window, issues } = buildStatsWindow(synthetic(), opts);

  it('produces a schema-valid window keyed by draftable entity ids', () => {
    expect(StatsWindowSchema.safeParse(window).success).toBe(true);
    expect(Object.keys(window.heroes).sort()).toEqual(['Abat', 'Alex', 'HXAL', 'chogall']);
    expect(issues).toEqual([]);
  });

  it('averages composite members instead of double counting', () => {
    expect(window.heroes.chogall?.games).toBe(1000);
    expect(window.games).toBe(Math.round((4 * 1000) / 10));
  });

  it('shrinks win rates toward the mean and assigns tiers with enough games', () => {
    const x = window.heroes.HXAL;
    expect(x?.wr).toBe(0.56);
    expect(x?.shrunk).toBeLessThanOrEqual(0.56);
    expect(x?.shrunk).toBeGreaterThan(0.5);
    expect(x?.tier).toBeDefined();
  });

  it('antisymmetrises counters and stores synergies with a < b', () => {
    const d = new Map(window.counters.map((e) => [`${e.a}>${e.b}`, e.delta ?? 0]));
    expect(d.get('HXAL>Abat')).toBeCloseTo(-(d.get('Abat>HXAL') ?? 0), 6);
    expect(window.counters.every((e) => e.source === 'stats' && e.reasons[0]?.source === 'heroesprofile')).toBe(true);
    expect(window.synergies.every((e) => e.a < e.b)).toBe(true);
    expect(window.counters.some((e) => e.a === 'chogall' || e.b === 'chogall')).toBe(true);
  });

  it('shrinks hero × map rates toward the hero and ranks builds by a lower bound', () => {
    expect(window.maps.HXAL?.['cursed-hollow']?.games).toBe(300);
    expect(window.maps.HXAL?.['sky-temple']?.delta).toBeDefined();
    expect(window.builds.HXAL?.[0]?.talents.at(-1)).toBe('G');
  });

  it('reports unknown hero and map names', () => {
    const data = synthetic();
    data.heroes.push({ hero: 'Nobody', games: 10, wins: 5 });
    data.maps.push({ hero: 'Abathur', map: 'Moon Base', games: 10, wins: 5 });
    const r = buildStatsWindow(data, opts);
    expect(r.issues.map((i) => i.message).join(' ')).toMatch(/Nobody.*|Moon Base/);
    expect(r.issues).toHaveLength(2);
  });
});

describe('pooling, shares and the draft overlay', () => {
  it('sums pooled rows of the same hero (weighted) instead of averaging them', () => {
    const pooled = poolWindows(synthetic(), synthetic(), 0.5);
    const { window } = buildStatsWindow(pooled, { ...opts, pooled: { major: '2.55', weight: 0.5 } });
    expect(window.heroes.Abat?.games).toBe(1500);
    expect(window.pooled).toEqual({ major: '2.55', weight: 0.5 });
  });

  it('computes map shares of the window', () => {
    const shares = mapShares(synthetic(), maps);
    expect([...shares.values()].reduce((s, v) => s + v, 0)).toBeCloseTo(1, 9);
    expect(shares.get('cursed-hollow')).toBeCloseTo(300 / 310, 6);
  });

  it('builds a stats.json and a dense overlay that validate against the shard', () => {
    const { window } = buildStatsWindow(synthetic(), opts);
    expect(StatsSchema.safeParse(buildStats({ fetchedAt: '2026-10-08T10:00:00.000Z', major: '2.57', builds: opts.patchBuilds, sl: window })).success).toBe(true);
    const shard = buildDraftShard({ build: '2.57.0.98348', major: '2.57', heroes, maps, theory: { rulesVersion: 'x', counters: [], synergies: [], mapFit: [] } });
    const block = buildDraftStatsBlock(shard, window);
    const H = shard.heroes.id.length;
    expect(block.counters.score).toHaveLength(H * H);
    expect(DraftShardSchema.safeParse({ ...shard, stats: block }).success).toBe(true);
    const sky = shard.maps.id.indexOf('sky-temple');
    const xi = shard.heroes.id.indexOf('HXAL');
    expect(block.maps.n[xi * shard.maps.id.length + sky]).toBe(10);
    expect(block.maps.delta[xi * shard.maps.id.length + sky]).toBeNull();
    // Synergy matrices are symmetric.
    const ai = shard.heroes.id.indexOf('Abat');
    expect(block.synergies.score[ai * H + xi]).toBe(block.synergies.score[xi * H + ai]);
  });

  it('resolves HP names, slugs and ids to entities', () => {
    const r = entityResolver(heroes);
    expect([r('Cho'), r('Gall'), r("Xal'atath"), r('xalatath'), r('??')]).toEqual(['chogall', 'chogall', 'HXAL', 'HXAL', null]);
  });
});
