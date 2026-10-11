import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// Imported through the package.json "imports" alias on purpose: proves Vitest resolves #games/*.
import {
  BASE,
  SITE,
  accentStylesheet,
  allNavRoutes,
  gameById,
  gameFromPath,
  games,
  listNames,
  navHref,
  rightsHolders,
  searchHref,
  sourceCopyright,
  sourcesFor,
  versionText,
  withBase,
} from '#games/registry.ts';
import { GAME_IDS } from '#core/game.ts';
import { plan, planOutputs } from '../../scripts/plan.ts';

describe('registry', () => {
  it('lists every game of GAME_IDS once, in that order, and every one is live (no beta, SPEC §13)', () => {
    expect(games.map((g) => g.id)).toEqual([...GAME_IDS]);
    for (const g of games) expect(g.status).toBe('live');
  });

  it('resolves the presentation every shared page needs for every game', () => {
    for (const g of games) {
      expect(g.legalNotice.heading.length, g.id).toBeGreaterThan(0);
      expect(g.legalNotice.body.length, g.id).toBeGreaterThan(0);
      expect(g.legalNotice.owners.length, g.id).toBeGreaterThan(0);
      expect(g.accentColors.dark, g.id).toMatch(/^#[0-9a-f]{6}$/i);
      expect(g.accentColors.light, g.id).toMatch(/^#[0-9a-f]{6}$/i);
      expect(g.storage.length, g.id).toBeGreaterThan(0);
      for (const row of g.storage) expect(row.key.startsWith('whetstone'), row.key).toBe(true);
      expect(g.pipeline.timeoutMinutes, g.id).toBeGreaterThan(0);
      expect(g.searchPath === '#search' || g.searchPath.endsWith('/'), g.id).toBe(true);
    }
    expect(rightsHolders()).toContain('Blizzard Entertainment');
    expect(listNames(['A', 'B', 'C'], 'or')).toBe('A, B or C');
    for (const g of games) expect(SITE.description).toContain(g.name);
  });

  it('emits each game accent for both themes and scopes --accent by data-game', () => {
    const css = accentStylesheet();
    for (const g of games) {
      expect(css).toContain(`${g.accent}: ${g.accentColors.dark};`);
      expect(css).toContain(`${g.accent}: ${g.accentColors.light};`);
      expect(css).toContain(`[data-game='${g.id}'] {`);
    }
    expect(css).toContain(":root[data-theme='light']");
    expect(css).toContain('@media (prefers-color-scheme: light)');
    expect(() => accentStylesheet([{ ...gameById('hots'), accentColors: { dark: 'red;}body{', light: '#000' } }])).toThrow(/hex colour/);
  });

  it('builds the daily data matrix from the registry', () => {
    const all = plan('schedule', undefined);
    expect(all.games).toEqual([...GAME_IDS]);
    expect(all.matrix.include).toEqual(games.map((g) => ({ game: g.id, timeout: g.pipeline.timeoutMinutes })));
    expect(plan('push', 'all').games).toEqual([]);
    expect(plan('workflow_dispatch', 'none').games).toEqual([]);
    expect(plan('workflow_dispatch', 'pokemon, hots').games).toEqual(['hots', 'pokemon']);
    expect(() => plan('workflow_dispatch', 'hots,nope')).toThrow(/Unknown game 'nope'/);
    expect(planOutputs(plan('workflow_dispatch', 'mtga'))).toEqual([
      `matrix={"include":[{"game":"mtga","timeout":${gameById('mtga').pipeline.timeoutMinutes}}]}`,
      'games=mtga',
      'run_data=true',
      'pokemon=false',
    ]);
  });

  it('keeps the data workflow generic: the matrix comes from scripts/plan.ts, secrets are scoped per game', () => {
    const yml = readFileSync(new URL('../../.github/workflows/data-deploy.yml', import.meta.url), 'utf8');
    expect(yml).toContain('node scripts/plan.ts');
    expect(yml).toContain('matrix: ${{ fromJSON(needs.plan.outputs.matrix) }}');
    // No hard-coded game list, no Heroes Profile or Twitch secrets, one game per secret.
    expect(yml).not.toMatch(/hots mtga pokemon|"hots":90/);
    expect(yml).not.toMatch(/HP_API_KEY|HP_MODE|TWITCH_/);
    for (const line of yml.split('\n').filter((l) => /secrets\.(?!DATA_ARTIFACT_KEY)/.test(l))) {
      expect(line, 'secret without a per-game condition').toMatch(/matrix\.game == '[a-z]+' && secrets\./);
    }
    // Every action pinned to a full commit SHA.
    for (const line of yml.split('\n').filter((l) => l.includes('uses:'))) expect(line).toMatch(/@[0-9a-f]{40} # v\d/);
  });

  it('knows the copyright lines of the MIT sources it redistributes', () => {
    expect(sourceCopyright(sourcesFor('pokemon', ['showdown'])[0]!)).toMatch(/Guangcong Luo/);
    expect(sourceCopyright({ id: 'x', name: 'x', url: 'https://x', attribution: 'x', rule: 'footer', custody: 'A', copyright: 'Copyright (c) X' })).toBe('Copyright (c) X');
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
    const hp = sourcesFor('hots', ['heroesprofile'])[0];
    expect(hp).toMatchObject({ rule: 'inline', custody: 'B', attribution: 'Data provided by Heroes Profile' });
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
