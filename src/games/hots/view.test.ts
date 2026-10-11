import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gameDataDir } from '../../lib/datadir.ts';
import { clearHotsCache, getDraftableEntities, getMaps, heroEdges, heroesForMap, heroMapFit } from './load.ts';
import { displayReasons, heroFitRow, heroHref, heroPortrait, mapFitRow, mapHref, mapImage, patchHref, toMatchupRow } from './view.ts';

afterEach(() => {
  delete process.env.WHETSTONE_FIXTURE_PRIVATE;
  clearHotsCache();
});

describe('hots view adapters', () => {
  it('links every draftable entity to its hero page and a portrait that the stage step will publish', () => {
    const dataDir = gameDataDir('hots');
    for (const hero of getDraftableEntities()) {
      expect(heroHref(hero)).toBe(`/whetstone/hots/hero/${hero.slug}/`);
      expect(heroPortrait(hero)).toBe(`/whetstone/data/hots/${hero.portrait}`);
      expect(existsSync(path.join(dataDir, ...hero.portrait.split('/'))), hero.portrait).toBe(true);
    }
  });

  it('maps theory rows to MatchupList props', () => {
    const edges = heroEdges('abathur');
    expect(edges?.primary).toBe('theory');
    const row = edges?.strong[0] ?? edges?.weak[0] ?? edges?.synergy[0];
    expect(row).toBeDefined();
    if (!row) return;
    const props = toMatchupRow(row);
    expect(props).toMatchObject({ id: row.hero.id, name: row.hero.name, score: row.score, source: 'theory', lowSample: false });
    expect(props.reasons?.length).toBeGreaterThan(0);
    expect(props).not.toHaveProperty('sourceLabel');
  });

  it('carries n, delta and the grey gate for stats rows', () => {
    process.env.WHETSTONE_FIXTURE_PRIVATE = '1';
    clearHotsCache();
    const edges = heroEdges('abathur');
    expect(edges?.primary).toBe('stats');
    const rows = [...(edges?.strong ?? []), ...(edges?.weak ?? []), ...(edges?.synergy ?? [])];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const props = toMatchupRow(row, { sourceLabel: 'Some Statistics Source' });
      expect(props.n).toBe(row.edge.n);
      expect(props.delta).toBe(row.edge.delta);
      expect(props.lowSample).toBe(row.gate === 'grey');
      expect(props.sourceLabel).toBe('Some Statistics Source');
    }
  });
});

describe('reason conditions', () => {
  it('folds the conditions of a curated reason into its text as "Only when …", like generated reasons', () => {
    const out = displayReasons([
      { kind: 'curated', text: 'Nanomachine Coating cuts attack speed for anyone in oil.', evidence: ['Nanomachine Coating'], conditions: ['Blaze takes Nanomachine Coating (level 7)'] },
      { kind: 'curated', text: 'Holds with the base kit.' },
      { kind: 'theory', text: 'Two picks needed.', conditions: ['A takes X', 'B takes Y'] },
    ]);
    expect(out).toEqual([
      { kind: 'curated', text: 'Nanomachine Coating cuts attack speed for anyone in oil. Only when Blaze takes Nanomachine Coating (level 7).', evidence: ['Nanomachine Coating'] },
      { kind: 'curated', text: 'Holds with the base kit.' },
      { kind: 'theory', text: 'Two picks needed. Only when A takes X, and B takes Y.' },
    ]);
  });

  it('shows the conditions on every matchup row a page renders', () => {
    for (const hero of getDraftableEntities()) {
      const edges = heroEdges(hero.id);
      for (const row of [...(edges?.strong ?? []), ...(edges?.weak ?? []), ...(edges?.synergy ?? [])]) {
        const props = toMatchupRow(row);
        expect(props.reasons?.some((r) => r.conditions !== undefined), hero.slug).toBe(false);
        row.reasons.forEach((r, i) => {
          if (r.conditions?.length) expect(props.reasons?.[i]?.text).toContain(' Only when ');
        });
      }
    }
  });
});

describe('hots map and patch adapters', () => {
  it('links maps, map art and patches under the site base', () => {
    for (const map of getMaps()) {
      expect(mapHref(map)).toBe(`/whetstone/hots/map/${map.id}/`);
      expect(mapImage(map)).toBe(`/whetstone/data/hots/${map.image}`);
    }
    expect(patchHref({ id: '2026-09-28-patch' })).toBe('/whetstone/hots/patches/2026-09-28-patch/');
  });

  it('maps theory map fit to MatchupList rows, with or without art', () => {
    const fit = heroMapFit('abathur')[0];
    expect(fit).toBeDefined();
    if (!fit) return;
    const row = mapFitRow(fit);
    expect(row).toMatchObject({ id: fit.map.id, name: fit.map.name, href: mapHref(fit.map), image: mapImage(fit.map), score: fit.score, source: 'theory', lowSample: false });
    expect(row).not.toHaveProperty('n');
    expect(mapFitRow(fit, { image: null })).not.toHaveProperty('image');
    expect(mapFitRow(fit, { image: '/x.webp' }).image).toBe('/x.webp');
  });

  it('carries n and delta for stats map rows', () => {
    process.env.WHETSTONE_FIXTURE_PRIVATE = '1';
    clearHotsCache();
    const map = getMaps().find((m) => m.kind === 'standard');
    const best = map ? heroesForMap(map.id) : [];
    expect(best.length).toBeGreaterThan(0);
    for (const { hero, fit } of best) {
      const row = heroFitRow(hero, fit);
      expect(row).toMatchObject({ id: hero.id, href: heroHref(hero), image: heroPortrait(hero), source: 'stats', n: fit.n, delta: fit.delta });
      expect(row.lowSample).toBe(fit.gate === 'grey');
    }
  });
});
