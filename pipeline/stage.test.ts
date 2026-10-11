import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameMeta } from '../src/core/game.ts';
import { shortHash } from './hash.ts';
import type { FileIndex, PublicManifest } from './manifest.ts';
import { resolveDataDirs, stage } from './stage.ts';
import { listFiles } from './store.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ws-stage-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(rel: string, content: string | Uint8Array): void {
  const file = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function meta(game: GameMeta['game'], hash: string): GameMeta {
  return {
    game,
    schema: 1,
    version: { label: game === 'hots' ? '2.57' : 'x' },
    generatedAt: '2026-10-08T10:17:00.000Z',
    dataHash: hash,
    sources: [{ id: 's', fetchedAt: '2026-10-08T10:17:00.000Z', status: 'ok' }],
    counts: { n: 1 },
  };
}

const quiet = { log: () => {} };

describe('stage', () => {
  it('stages hashed shards, images, the stage map and a manifest of documented class-A files', () => {
    const draft = '{"heroes":["Abat"]}\n';
    put('data/current/hots/meta.json', JSON.stringify(meta('hots', 'h1')));
    put('data/current/hots/_files.json', JSON.stringify({ schema: 1, files: { 'public/draft.json': { custody: 'A', bytes: 1, sha256: 'x' }, 'public/pro.json': { custody: 'A-SA', bytes: 1, sha256: 'x' } } } satisfies FileIndex));
    put('data/current/hots/public/draft.json', draft);
    put('data/current/hots/public/pro.json', '{}\n');
    put('data/current/hots/public/_internal.json', '[]\n');
    put('data/current/hots/img/heroes/abathur.webp', new Uint8Array([1, 2, 3]));
    put('data/current/hots/heroes.json', '[]\n');
    put('data/private/hots/public/draft-stats.json', '{"sl":{}}\n');
    put('data/private/hots/stats.json', '{}\n');
    put('fixtures/mtga/meta.json', JSON.stringify(meta('mtga', 'm1')));
    put('fixtures/mtga/public/cards.standard.json', '[1]\n');
    put('public/data/stale.json', 'old');
    put('public/icons/keep.svg', '<svg/>');

    const r = stage({ root, env: {}, ...quiet });

    const h = shortHash(draft);
    expect(r.map).toEqual({
      'hots/_internal': `data/hots/_internal.${shortHash('[]\n')}.json`,
      'hots/draft': `data/hots/draft.${h}.json`,
      'hots/draft-stats': `data/hots/_private/draft-stats.${shortHash('{"sl":{}}\n')}.json`,
      'hots/pro': `data/hots/pro.${shortHash('{}\n')}.json`,
      'mtga/cards.standard': `data/mtga/cards.standard.${shortHash('[1]\n')}.json`,
    });
    expect(readFileSync(path.join(root, 'public', 'data', 'hots', `draft.${h}.json`), 'utf8')).toBe(draft);
    expect(existsSync(path.join(root, 'public', 'data', 'hots', 'img', 'heroes', 'abathur.webp'))).toBe(true);
    expect(existsSync(path.join(root, 'public', 'data', 'stale.json'))).toBe(false);
    expect(existsSync(path.join(root, 'public', 'icons', 'keep.svg'))).toBe(true);
    // Non-public data files are never staged.
    expect(listFiles(path.join(root, 'public', 'data', 'hots')).some((f) => f.includes('heroes.json') || f.includes('stats.json'))).toBe(false);

    const manifest = JSON.parse(readFileSync(path.join(root, 'public', 'data', 'manifest.json'), 'utf8')) as PublicManifest;
    expect(Object.keys(manifest.games)).toEqual(['hots', 'mtga']);
    expect(manifest.games.hots?.files).toEqual({
      draft: { url: `data/hots/draft.${h}.json`, custody: 'A' },
      pro: { url: `data/hots/pro.${shortHash('{}\n')}.json`, custody: 'A-SA' },
    });
    expect(manifest.games.hots).toMatchObject({ dataHash: 'h1', fixtures: false, version: { label: '2.57' } });
    expect(manifest.games.mtga?.fixtures).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain('draft-stats');

    const mapOnDisk = JSON.parse(readFileSync(path.join(root, 'src', 'generated', 'stage-map.json'), 'utf8')) as Record<string, string>;
    expect(mapOnDisk).toEqual(r.map);
  });

  it('honours WHETSTONE_DATA_DIR before data/ and fixtures/', () => {
    put('ci-data/current/pokemon/meta.json', JSON.stringify(meta('pokemon', 'ci')));
    put('data/current/pokemon/meta.json', JSON.stringify(meta('pokemon', 'local')));
    put('fixtures/pokemon/meta.json', JSON.stringify(meta('pokemon', 'fx')));
    put('ci-data/private/pokemon/x.json', '{}');
    const dirs = resolveDataDirs(root, 'pokemon', { WHETSTONE_DATA_DIR: 'ci-data' });
    expect(dirs.dir).toBe(path.join(root, 'ci-data', 'current', 'pokemon'));
    expect(dirs.privateDir).toBe(path.join(root, 'ci-data', 'private', 'pokemon'));
    expect(resolveDataDirs(root, 'pokemon', {}).dir).toBe(path.join(root, 'data', 'current', 'pokemon'));
    expect(stage({ root, env: { WHETSTONE_DATA_DIR: 'ci-data' }, ...quiet }).manifest.games.pokemon?.dataHash).toBe('ci');
  });

  it('skips data/ with WHETSTONE_FIXTURES=1 and never pairs fixtures with data/private', () => {
    put('data/current/pokemon/meta.json', JSON.stringify(meta('pokemon', 'local')));
    put('data/private/pokemon/x.json', '{}');
    put('data/private/hots/public/draft.json', '{"stats":{}}');
    put('fixtures/pokemon/meta.json', JSON.stringify(meta('pokemon', 'fx')));
    put('fixtures/hots/meta.json', JSON.stringify(meta('hots', 'fx')));
    expect(resolveDataDirs(root, 'pokemon', { WHETSTONE_FIXTURES: '1' })).toEqual({ dir: path.join(root, 'fixtures', 'pokemon'), privateDir: null, fixtures: true });
    // data/current/hots is absent, so hots comes from fixtures and must not pick up data/private/hots.
    expect(resolveDataDirs(root, 'hots', {})).toEqual({ dir: path.join(root, 'fixtures', 'hots'), privateDir: null, fixtures: true });
    // An explicit WHETSTONE_DATA_DIR still wins over the pin.
    put('ci-data/current/pokemon/meta.json', JSON.stringify(meta('pokemon', 'ci')));
    expect(resolveDataDirs(root, 'pokemon', { WHETSTONE_FIXTURES: '1', WHETSTONE_DATA_DIR: 'ci-data' }).dir).toBe(path.join(root, 'ci-data', 'current', 'pokemon'));
  });

  it('overlays fixtures/<game>/_private/public/** only with WHETSTONE_FIXTURE_PRIVATE=1', () => {
    const pub = '{"heroes":["Abat"]}\n';
    put('fixtures/hots/meta.json', JSON.stringify(meta('hots', 'fx')));
    put('fixtures/hots/public/draft.json', pub);
    put('fixtures/hots/_private/public/draft.json', '{"stats":{"synthetic":true}}\n');
    put('fixtures/hots/_private/stats.json', '{}\n');
    expect(stage({ root, env: {}, ...quiet }).map['hots/draft']).toBe(`data/hots/draft.${shortHash(pub)}.json`);
    const r = stage({ root, env: { WHETSTONE_FIXTURE_PRIVATE: '1' }, ...quiet });
    const merged = '{"heroes":["Abat"],"stats":{"synthetic":true}}\n';
    // Shards carrying private data live under _private/, which the service worker never caches.
    expect(r.map['hots/draft']).toBe(`data/hots/_private/draft.${shortHash(merged)}.json`);
    expect(r.manifest.games.hots?.files.draft?.url).toBe(`data/hots/draft.${shortHash(pub)}.json`);
    expect(r.manifest.games.hots?.fixtures).toBe(true);
    // Only public/** of the private directory is staged.
    expect(r.files.some((f) => f.includes('stats'))).toBe(false);
  });

  it('merges a private overlay into the shard the site uses, while the manifest keeps the class-A file', () => {
    const pub = '{"heroes":["Abat"],"schema":1}\n';
    put('data/current/hots/meta.json', JSON.stringify(meta('hots', 'h')));
    put('data/current/hots/public/draft.json', pub);
    put('data/private/hots/public/draft.json', '{"stats":{"games":10}}\n');
    const r = stage({ root, env: {}, ...quiet });
    const merged = '{"heroes":["Abat"],"schema":1,"stats":{"games":10}}\n';
    expect(r.map['hots/draft']).toBe(`data/hots/_private/draft.${shortHash(merged)}.json`);
    expect(r.manifest.games.hots?.files.draft?.url).toBe(`data/hots/draft.${shortHash(pub)}.json`);
    expect(readFileSync(path.join(root, 'public', ...(r.map['hots/draft'] as string).split('/')), 'utf8')).toBe(merged);
    expect(readFileSync(path.join(root, 'public', 'data', 'hots', `draft.${shortHash(pub)}.json`), 'utf8')).toBe(pub);
  });

  it('refuses overlays that would replace public keys or are not objects', () => {
    put('data/current/hots/meta.json', JSON.stringify(meta('hots', 'h')));
    put('data/current/hots/public/draft.json', '{"heroes":[]}');
    put('data/private/hots/public/draft.json', '{"heroes":["x"]}');
    expect(() => stage({ root, env: {}, ...quiet })).toThrow(/replace public keys \(heroes\)/);
    put('data/private/hots/public/draft.json', '[1]');
    expect(() => stage({ root, env: {}, ...quiet })).toThrow(/JSON objects/);
  });

  it('works with no data at all', () => {
    const r = stage({ root, env: {}, ...quiet });
    expect(r.files).toEqual([]);
    expect(JSON.parse(readFileSync(path.join(root, 'public', 'data', 'manifest.json'), 'utf8'))).toEqual({ schema: 1, games: {} });
    expect(readFileSync(path.join(root, 'src', 'generated', 'stage-map.json'), 'utf8')).toBe('{}\n');
  });
});
