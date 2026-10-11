import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// Imported through the package.json "imports" alias on purpose: proves Vitest resolves #games/*.
import {
  BASE,
  allNavRoutes,
  gameById,
  gameFromPath,
  games,
  navHref,
  searchHref,
  sourcesFor,
  versionText,
  withBase,
} from '#games/registry.ts';

describe('registry', () => {
  it('lists every game once with the SPEC statuses', () => {
    expect(games.map((g) => [g.id, g.status])).toEqual([
      ['hots', 'live'],
      ['mtga', 'beta'],
      ['pokemon', 'beta'],
    ]);
  });

  it('gives every game a CSS accent token, a home nav entry and unique, slash-terminated paths', () => {
    for (const g of games) {
      expect(g.accent).toBe(`--accent-${g.id}`);
      expect(g.nav[0]?.path).toBe('');
      const paths = g.nav.map((n) => n.path);
      expect(new Set(paths).size).toBe(paths.length);
      for (const p of paths) expect(p === '' || p.endsWith('/')).toBe(true);
    }
  });

  it('declares attribution the way each source requires', () => {
    // Heroes Profile was removed as a source (2026-10-10).
    expect(sourcesFor('hots', ['heroesprofile'])).toEqual([]);
    expect(sourcesFor('hots', ['liquipedia'])[0]).toMatchObject({ custody: 'A-SA', license: 'CC-BY-SA 3.0' });
    expect(sourcesFor('mtga', ['17lands'])[0]).toMatchObject({ rule: 'top', license: 'CC BY 4.0' });
    expect(sourcesFor('mtga', ['scryfall'])[0]?.attribution).toBe('Card data and images courtesy of Scryfall');
    for (const g of games) {
      const ids = g.sources.map((s) => s.id);
      expect(new Set(ids).size).toBe(ids.length);
      for (const s of g.sources) expect(s.url).toMatch(/^https:\/\//);
    }
  });

  it('has a SourceRef for every source the committed fixtures report, so banners can name them', () => {
    for (const g of games) {
      const file = new URL(`../../fixtures/${g.id}/meta.json`, import.meta.url);
      if (!existsSync(file)) continue;
      const meta = JSON.parse(readFileSync(file, 'utf8')) as { sources?: { id: string }[] };
      const known = new Set(g.sources.map((s) => s.id));
      const unknown = (meta.sources ?? []).map((s) => s.id).filter((id) => !known.has(id));
      expect(unknown, `${g.id} sources without a SourceRef`).toEqual([]);
    }
  });

  it('builds base-prefixed URLs (falls back to /whetstone/ outside Vite)', () => {
    expect(BASE).toBe('/whetstone/');
    expect(withBase()).toBe('/whetstone/');
    expect(withBase('/about/')).toBe('/whetstone/about/');
    expect(navHref('hots')).toBe('/whetstone/hots/');
    expect(navHref(gameById('mtga'), 'deck/')).toBe('/whetstone/mtga/deck/');
    expect(searchHref('hots')).toBe('/whetstone/hots/#search');
    expect(searchHref('mtga')).toBe('/whetstone/mtga/search/');
  });

  it('lists every global and nav route for the smoke test', () => {
    const routes = allNavRoutes();
    expect(routes).toContain('');
    expect(routes).toContain('privacy/');
    expect(routes).toContain('hots/draft/');
    expect(routes).toContain('pokemon/calc/');
    expect(new Set(routes).size).toBe(routes.length);
  });

  it('maps paths back to games and labels versions', () => {
    expect(gameFromPath('/whetstone/hots/hero/abathur/')).toBe('hots');
    expect(gameFromPath('/whetstone/about/')).toBeNull();
    expect(gameFromPath('pokemon/calc/')).toBe('pokemon');
    expect(versionText('hots', '2.57')).toBe('Patch 2.57');
    expect(versionText('hots', 'Patch 2.57')).toBe('Patch 2.57');
    expect(versionText('pokemon', 'Reg M-C')).toBe('Reg M-C');
    expect(versionText('mtga', 'EOE')).toBe('Set EOE');
  });
});
