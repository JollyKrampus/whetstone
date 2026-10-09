import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { GameModule } from '../core/game.ts';
import { games } from '../games/registry.ts';
import { fixturesPinned, gameDataDir, gamePrivateDir, repoRoot, usingFixtures } from './datadir.ts';
import { hasPage, pendingSections } from './routes.ts';
import { lookupStaged, readStageMap, stagedUrl, stagedUrlOrNull } from './stagemap.ts';

const temps: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'whetstone-lib-'));
  temps.push(dir);
  return dir;
}
function touch(root: string, rel: string, body = ''): void {
  const file = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('datadir', () => {
  it('finds the repo root by its package.json, independent of where the module is bundled', () => {
    const pkg = JSON.parse(readFileSync(path.join(repoRoot(), 'package.json'), 'utf8')) as { name: string };
    expect(pkg.name).toBe('whetstone');
  });

  it('resolves every game to a directory with a meta.json', () => {
    for (const g of games) expect(gameDataDir(g.id)).toMatch(new RegExp(`[\\\\/]${g.id}$`));
  });

  it('is pinned to the committed fixtures under Vitest, whatever data/ holds', () => {
    expect(fixturesPinned()).toBe(true);
    for (const g of games) {
      expect(usingFixtures(g.id)).toBe(true);
      expect(gameDataDir(g.id)).toBe(path.join(repoRoot(), 'fixtures', g.id));
      // Private samples only with WHETSTONE_FIXTURE_PRIVATE=1, and never from data/private.
      expect(gamePrivateDir(g.id)).toBeNull();
    }
  });
});

describe('pendingSections', () => {
  const game: GameModule = {
    id: 'hots',
    name: 'Test',
    short: 'T',
    tagline: '',
    status: 'beta',
    accent: '--accent-hots',
    sources: [],
    nav: [
      { label: 'Home', path: '' },
      { label: 'Maps', path: 'maps/' },
      { label: 'Draft', path: 'draft/' },
      { label: 'Deep', path: 'limited/sets/' },
      { label: 'About', path: 'about/' },
    ],
  };

  it('lists nav sections without a page file and skips the game home', () => {
    const root = tempRoot();
    expect(pendingSections(root, [game]).map((s) => s.section)).toEqual(['maps', 'draft', 'limited/sets', 'about']);
  });

  it('drops a section once <section>.astro or <section>/index.* exists', () => {
    const root = tempRoot();
    touch(root, 'src/pages/hots/maps.astro');
    touch(root, 'src/pages/hots/draft/index.astro');
    touch(root, 'src/pages/hots/limited/sets/index.md');
    expect(hasPage(root, 'hots', 'maps')).toBe(true);
    expect(pendingSections(root, [game])).toEqual([{ game: 'hots', section: 'about', label: 'About' }]);
  });

  it('never offers a placeholder for a page that exists in this repo', () => {
    for (const s of pendingSections()) expect(hasPage(repoRoot(), s.game, s.section)).toBe(false);
  });
});

describe('stage map', () => {
  const map = { 'hots/draft': 'data/hots/draft.1a2b3c4d.json', 'mtga/_cards.arena': 'data/mtga/_cards.arena.00ff00ff.json' };

  it('returns base-prefixed URLs for staged shards', () => {
    expect(lookupStaged(map, 'hots', 'draft')).toBe('data/hots/draft.1a2b3c4d.json');
    expect(stagedUrl('hots', 'draft', map)).toBe('/whetstone/data/hots/draft.1a2b3c4d.json');
    expect(stagedUrlOrNull('mtga', '_cards.arena', map)).toBe('/whetstone/data/mtga/_cards.arena.00ff00ff.json');
  });

  it('is null or a helpful error when a shard is missing', () => {
    expect(stagedUrlOrNull('pokemon', 'dex', map)).toBeNull();
    expect(() => stagedUrl('hots', 'stats', map)).toThrow(/hots\/stats.*staged for hots: draft/);
  });

  it('explains how to generate a missing map', () => {
    expect(() => readStageMap(tempRoot())).toThrow(/node pipeline\/stage\.ts/);
    const root = tempRoot();
    touch(root, 'src/generated/stage-map.json', JSON.stringify(map));
    expect(readStageMap(root)).toEqual(map);
  });
});
