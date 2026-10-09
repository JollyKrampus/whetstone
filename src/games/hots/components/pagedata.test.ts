import { afterEach, describe, expect, it } from 'vitest';
import { HOTS_TIERS } from '../../../core/tiers.ts';
import { clearHotsCache, getDraftableEntities, getHeroBySlug, getMapBySlug, getMaps, getPatches, getStatsWindow, heroEdges } from '../load.ts';
import { catchUp } from './catchup.ts';
import {
  allPeriods,
  catchUpData,
  featuredChannels,
  heroVideos,
  latestLivePatch,
  patchMomentum,
  splitByGate,
  statsModes,
  theoryHeroesForMap,
  theoryMapFit,
  theoryMatchups,
  tierById,
  tierResults,
} from './pagedata.ts';

function statsOn(): void {
  process.env.WHETSTONE_FIXTURE_PRIVATE = '1';
  clearHotsCache();
}

afterEach(() => {
  delete process.env.WHETSTONE_FIXTURE_PRIVATE;
  clearHotsCache();
});

describe('data mode', () => {
  it('offers no stats modes in a theory-only build', () => {
    expect(statsModes()).toEqual([]);
    expect(tierResults('sl', 'current')).toBeNull();
    expect(tierById().size).toBe(0);
  });

  it('offers each mode that has a window, previous patch only where it exists', () => {
    statsOn();
    const modes = statsModes();
    expect(modes.map((m) => m.id)).toEqual(['sl', 'aram']);
    expect(modes[0]?.periods.map((p) => p.id)).toEqual(['current', 'previous']);
    expect(modes[1]?.periods.map((p) => p.id)).toEqual(['current']);
    expect(modes[0]?.periods[0]?.note).toMatch(/2\.57/);
    expect(allPeriods(modes).map((p) => p.id)).toEqual(['current', 'previous']);
    expect(allPeriods([])).toEqual([]);
  });
});

describe('tiers', () => {
  it('bands every hero in the window by shrunk win rate, early data below the n gate', () => {
    statsOn();
    const w = getStatsWindow('sl', 'current');
    const results = tierResults('sl', 'current') ?? [];
    expect(results.map((r) => r.id).sort()).toEqual(Object.keys(w?.heroes ?? {}).sort());
    for (const r of results) {
      const n = w?.heroes[r.id]?.games ?? 0;
      expect(r.early, r.id).toBe(n < HOTS_TIERS.minN);
      if (!r.early) expect(HOTS_TIERS.bands.map((b) => b.id)).toContain(r.tier);
    }
    // The current window compares with the previous one; the previous window has nothing to compare with.
    expect(results.some((r) => r.deltaPrevious !== undefined)).toBe(true);
    expect((tierResults('sl', 'previous') ?? []).every((r) => r.deltaPrevious === undefined)).toBe(true);
    expect(tierResults('qm', 'current')).toBeNull();
  });

  it('is deterministic', () => {
    statsOn();
    expect(tierResults('sl', 'current')).toEqual(tierResults('sl', 'current'));
  });
});

describe('matchups', () => {
  it('returns the same theory lists heroEdges gives without stats', () => {
    const edges = heroEdges('abathur');
    const theory = theoryMatchups('abathur');
    expect(theory?.strong.map((r) => r.hero.id)).toEqual(edges?.strong.map((r) => r.hero.id));
    expect(theory?.weak.map((r) => r.hero.id)).toEqual(edges?.weak.map((r) => r.hero.id));
    expect(theory?.synergy.map((r) => r.hero.id)).toEqual(edges?.synergy.map((r) => r.hero.id));
    expect(theoryMatchups('nobody')).toBeNull();
  });

  it('keeps theory lists available on a stats build', () => {
    statsOn();
    expect(heroEdges('abathur')?.primary).toBe('stats');
    const theory = theoryMatchups('abathur');
    const rows = [...(theory?.strong ?? []), ...(theory?.weak ?? []), ...(theory?.synergy ?? [])];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source === 'theory' || r.source === 'curated')).toBe(true);
  });

  it('splits stats rows at the listing gate', () => {
    const { listed, other } = splitByGate([{ gate: 'listed' }, { gate: 'grey' }, { gate: 'shown' }, { gate: 'listed' }]);
    expect(listed).toHaveLength(2);
    expect(other.map((r) => r.gate)).toEqual(['grey', 'shown']);
  });

  it('collapses Cho and Gall into the composite everywhere', () => {
    const chogall = getHeroBySlug('chogall');
    expect(chogall).toBeDefined();
    const theory = theoryMatchups('cho');
    expect(theory).toEqual(theoryMatchups('chogall'));
    for (const r of [...(theory?.strong ?? []), ...(theory?.weak ?? []), ...(theory?.synergy ?? [])]) {
      expect(['CCho', 'Gall']).not.toContain(r.hero.id);
    }
  });
});

describe('map fit', () => {
  it('ranks maps for a hero and heroes for a map, best first', () => {
    const hero = getHeroBySlug('abathur');
    expect(hero).toBeDefined();
    if (!hero) return;
    const maps = theoryMapFit(hero, getMaps());
    expect(maps.length).toBeGreaterThan(0);
    expect(maps.map((m) => m.score)).toEqual([...maps.map((m) => m.score)].sort((a, b) => b - a));
    const map = getMapBySlug(maps[0]?.map.id ?? '');
    expect(map).toBeDefined();
    if (!map) return;
    const heroes = theoryHeroesForMap(map);
    expect(heroes.some((h) => h.hero.id === hero.id)).toBe(true);
    expect(heroes.every((h) => getDraftableEntities().includes(h.hero))).toBe(true);
  });
});

describe('patches', () => {
  it('finds the newest live patch and the heroes the major touched', () => {
    expect(latestLivePatch()?.id).toBe(getPatches().find((p) => p.kind !== 'ptr')?.id);
    const { patches, rows } = patchMomentum('2.57');
    expect(patches.every((p) => p.version === '2.57')).toBe(true);
    expect(rows.find((r) => r.hero.id === 'HXAL')?.verdict).toBe('new');
    const abathur = rows.find((r) => r.hero.slug === 'abathur');
    expect(abathur?.verdict).toBe('rework');
    expect(abathur?.lines).toBeGreaterThan(0);
    // An unknown major falls back to the newest notes rather than showing nothing.
    expect(patchMomentum('1.0').rows.length).toBeGreaterThan(0);
  });

  it('serialises every hero and patch for the catch-up island, linking members to the composite page', () => {
    const data = catchUpData();
    expect(data.heroes['CCho']?.href).toBe('/whetstone/hots/hero/chogall/');
    expect(data.heroes['Gall']?.href).toBe('/whetstone/hots/hero/chogall/');
    expect(data.patches.map((p) => p.id)).toEqual(getPatches().map((p) => p.id));
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
    const view = catchUp(data, '2026-09-27');
    expect(view.groups.length).toBeGreaterThan(0);
    expect(view.newHeroes.map((h) => h.id)).toContain('HXAL');
  });
});

describe('class C helpers', () => {
  it('returns hero videos only when the optional source exists', () => {
    const hero = getHeroBySlug('xalatath');
    expect(hero).toBeDefined();
    if (!hero) return;
    expect(heroVideos(hero)).toBeNull();
    statsOn();
    const v = heroVideos(hero);
    expect(v?.videos.length).toBeGreaterThan(0);
    expect(v?.videos.every((x) => x.heroes.includes(hero.id))).toBe(true);
  });

  it('lists featured Twitch channels from the curated creators file', () => {
    const channels = featuredChannels();
    expect(channels.length).toBeGreaterThan(0);
    for (const c of channels) expect(c.login).toMatch(/^[a-z0-9_]{2,25}$/);
  });
});
