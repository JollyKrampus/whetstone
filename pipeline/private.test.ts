import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CustodyClass } from '../src/core/game.ts';
import { buildFileIndex, type FileIndex } from './manifest.ts';
import { isTombstone, packDir, purge, restore, unpackBundle, unpackTo } from './private.ts';
import { listFiles } from './store.ts';

let root: string;
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ws-private-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** private/<game> dir with files of the given custody plus its _files.json. */
function makePrivate(game: string, files: Record<string, CustodyClass>, withIndex = true): string {
  const dir = path.join(root, 'private', game);
  const entries = Object.entries(files).map(([rel, custody]) => {
    const bytes = enc(JSON.stringify({ rel }));
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), bytes);
    return { path: rel, bytes, custody };
  });
  if (withIndex) writeFileSync(path.join(dir, '_files.json'), JSON.stringify(buildFileIndex(entries)));
  return dir;
}

describe('pack / unpack', () => {
  it('without a key ships only class-C files and drops class B', () => {
    const dir = makePrivate('hots', { 'stats.json': 'B', 'public/draft-stats.json': 'B', 'videos.json': 'C' });
    const r = packDir(dir);
    expect(r.encrypted).toBe(false);
    expect(r.included).toEqual(['videos.json']);
    expect(r.dropped).toEqual(['public/draft-stats.json', 'stats.json']);
    const files = unpackBundle(r.bytes);
    expect([...files.keys()]).toEqual(['videos.json', '_files.json']);
    expect((JSON.parse(new TextDecoder().decode(files.get('_files.json'))) as FileIndex).files['videos.json']?.custody).toBe('C');
  });

  it('ships nothing without a key when custody is unknown (an empty tombstone bundle)', () => {
    const dir = makePrivate('hots', { 'stats.json': 'B' }, false);
    const r = packDir(dir);
    expect(r.included).toEqual([]);
    expect(isTombstone(unpackBundle(r.bytes))).toBe(true);
  });

  it('encrypts with a key, round-trips, and rejects a missing or wrong key', () => {
    const dir = makePrivate('hots', { 'stats.json': 'B', 'videos.json': 'C' });
    const r = packDir(dir, 'correct horse battery staple');
    expect(r.encrypted).toBe(true);
    const bundle = r.bytes;
    expect(Buffer.from(bundle).includes(Buffer.from('stats.json'))).toBe(false);
    const target = path.join(root, 'restored', 'hots');
    expect(unpackTo(bundle, target, 'correct horse battery staple')).toEqual(['stats.json', 'videos.json']);
    expect(readFileSync(path.join(target, 'stats.json'), 'utf8')).toBe('{"rel":"stats.json"}');
    expect(() => unpackBundle(bundle)).toThrow(/DATA_ARTIFACT_KEY/);
    expect(() => unpackBundle(bundle, 'wrong')).toThrow();
  });

  it('writes a tombstone for an empty or missing directory, and restoring it clears older private data', () => {
    const r = packDir(path.join(root, 'nothing'));
    expect(r.included).toEqual([]);
    const target = makePrivate('hots', { 'videos.json': 'C' });
    expect(unpackTo(r.bytes, target)).toEqual([]);
    expect(listFiles(path.join(root, 'private'))).toEqual([]);
  });

  it('rejects foreign files', () => {
    expect(() => unpackBundle(enc('PK\u0003\u0004'))).toThrow(/Not a Whetstone/);
  });
});

describe('purge', () => {
  it('removes class-B files, keeps others, and fails closed without an index', () => {
    makePrivate('hots', { 'stats.json': 'B', 'public/draft-stats.json': 'B', 'videos.json': 'C' });
    makePrivate('mtga', { 'x.json': 'B' }, false);
    const removed = purge(path.join(root, 'private'), ['B']);
    expect(removed).toEqual(['hots/public/draft-stats.json', 'hots/stats.json', 'mtga/x.json']);
    expect(listFiles(path.join(root, 'private'))).toEqual(['hots/_files.json', 'hots/videos.json']);
    const index = JSON.parse(readFileSync(path.join(root, 'private', 'hots', '_files.json'), 'utf8')) as FileIndex;
    expect(Object.keys(index.files)).toEqual(['videos.json']);
  });

  it('removes a game directory that only held class-B data', () => {
    const dir = makePrivate('hots', { 'stats.json': 'B' });
    purge(dir, ['B']);
    expect(listFiles(path.join(root, 'private'))).toEqual([]);
  });
});

describe('restore', () => {
  it('uses the newest unexpired artifact from a scheduled data-deploy run of this repository', () => {
    const bundle = packDir(makePrivate('hots', { 'videos.json': 'C' })).bytes;
    const now = new Date('2026-10-09T12:00:00Z');
    const artifacts = {
      artifacts: [
        { id: 4, name: 'private-hots', expired: false, created_at: '2026-10-09T11:00:00Z', workflow_run: { id: 40, repository_id: 1, head_repository_id: 2, head_branch: 'x' } },
        { id: 3, name: 'private-hots', expired: false, created_at: '2026-10-09T10:30:00Z', workflow_run: { id: 30, repository_id: 1, head_repository_id: 1, head_branch: 'main' } },
        { id: 2, name: 'private-hots', expired: false, created_at: '2026-10-09T10:20:00Z', workflow_run: { id: 20, repository_id: 1, head_repository_id: 1, head_branch: 'main' } },
        { id: 1, name: 'private-hots', expired: true, created_at: '2026-10-08T10:20:00Z', workflow_run: { id: 10, repository_id: 1, head_repository_id: 1, head_branch: 'main' } },
      ],
    };
    const calls: string[][] = [];
    const gh = (args: string[]): string => {
      calls.push(args);
      if (args[0] === 'api' && args[1]?.includes('/actions/artifacts')) return JSON.stringify(artifacts);
      if (args[0] === 'api' && args[1]?.endsWith('/runs/30')) return JSON.stringify({ path: '.github/workflows/ci.yml', event: 'push' });
      if (args[0] === 'api' && args[1]?.endsWith('/runs/20')) return JSON.stringify({ path: '.github/workflows/data-deploy.yml', event: 'schedule' });
      if (args[0] === 'run' && args[1] === 'download') {
        const dest = args[args.indexOf('-D') + 1] as string;
        writeFileSync(path.join(dest, 'private-hots.wsb'), bundle);
        return '';
      }
      throw new Error(`unexpected gh ${args.join(' ')}`);
    };
    const r = restore({ repo: 'o/r', games: ['hots', 'mtga'], dir: path.join(root, 'restored'), gh, now, log: () => {} });
    expect(r).toEqual({ hots: 20, mtga: null });
    expect(listFiles(path.join(root, 'restored'))).toEqual(['hots/_files.json', 'hots/videos.json']);
    expect(calls.some((c) => c.includes('40'))).toBe(false);
  });

  it('ignores artifacts older than the retention window', () => {
    const gh = (args: string[]): string => {
      if (args[0] === 'api') {
        return JSON.stringify({ artifacts: [{ id: 1, name: 'private-hots', expired: false, created_at: '2026-10-01T00:00:00Z', workflow_run: { id: 9, repository_id: 1, head_repository_id: 1, head_branch: 'main' } }] });
      }
      throw new Error('should not download');
    };
    expect(restore({ repo: 'o/r', games: ['hots'], dir: root, gh, now: new Date('2026-10-09T00:00:00Z'), log: () => {} })).toEqual({ hots: null });
  });

  /** gh stub serving one scheduled data-deploy artifact per game with the given bundle. */
  function oneArtifact(bundles: Record<string, Uint8Array>) {
    return (args: string[]): string => {
      if (args[0] === 'api' && args[1]?.includes('/actions/artifacts')) {
        const name = /name=([^&]+)/.exec(args[1])?.[1] ?? '';
        const game = name.replace('private-', '');
        const rows = bundles[game] ? [{ id: 1, name, expired: false, created_at: '2026-10-09T11:00:00Z', workflow_run: { id: 77, repository_id: 1, head_repository_id: 1, head_branch: 'main' } }] : [];
        return JSON.stringify({ artifacts: rows });
      }
      if (args[0] === 'api') return JSON.stringify({ path: '.github/workflows/data-deploy.yml', event: 'schedule' });
      if (args[0] === 'run' && args[1] === 'download') {
        const name = args[args.indexOf('-n') + 1] as string;
        const dest = args[args.indexOf('-D') + 1] as string;
        writeFileSync(path.join(dest, `${name}.wsb`), bundles[name.replace('private-', '')] as Uint8Array);
        return '';
      }
      throw new Error(`unexpected gh ${args.join(' ')}`);
    };
  }

  it('restores a tombstone as "no private data" instead of falling back to an older artifact', () => {
    const tombstone = packDir(path.join(root, 'empty')).bytes;
    const dir = path.join(root, 'restored');
    makePrivate('hots', { 'videos.json': 'C' });
    mkdirSync(path.join(dir, 'hots'), { recursive: true });
    writeFileSync(path.join(dir, 'hots', 'stale.json'), '{}');
    const r = restore({ repo: 'o/r', games: ['hots'], dir, gh: oneArtifact({ hots: tombstone }), now: new Date('2026-10-09T12:00:00Z'), log: () => {} });
    expect(r).toEqual({ hots: 77 });
    expect(listFiles(dir)).toEqual([]);
  });

  it('skips an artifact it cannot decrypt for that game only and keeps going', () => {
    const encrypted = packDir(makePrivate('hots', { 'stats.json': 'B' }), 'old key').bytes;
    const plain = packDir(makePrivate('mtga', { 'videos.json': 'C' })).bytes;
    const dir = path.join(root, 'restored');
    const warnings: string[] = [];
    const r = restore({ repo: 'o/r', games: ['hots', 'mtga'], dir, secret: 'new key', gh: oneArtifact({ hots: encrypted, mtga: plain }), now: new Date('2026-10-09T12:00:00Z'), log: () => {}, warn: (w) => warnings.push(w) });
    expect(r).toEqual({ hots: null, mtga: 77 });
    expect(listFiles(dir)).toEqual(['mtga/_files.json', 'mtga/videos.json']);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('private-hots from run 77 could not be restored');
    expect(warnings[0]).toContain('building without B/C data for hots');
  });
});
