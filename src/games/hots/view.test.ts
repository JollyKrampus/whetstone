import { existsSync } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { gameDataDir } from '../../lib/datadir.ts';
import { clearHotsCache, getDraftableEntities, heroEdges } from './load.ts';
import { heroHref, heroPortrait, toMatchupRow } from './view.ts';

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
      const props = toMatchupRow(row, { sourceLabel: 'Heroes Profile' });
      expect(props.n).toBe(row.edge.n);
      expect(props.delta).toBe(row.edge.delta);
      expect(props.lowSample).toBe(row.gate === 'grey');
      expect(props.sourceLabel).toBe('Heroes Profile');
    }
  });
});
