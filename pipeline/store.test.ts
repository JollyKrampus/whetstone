import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  gzipDeterministic,
  isSafeRelPath,
  listFiles,
  pruneEmptyDirs,
  resolveRel,
  serializeOutput,
  syncTree,
  utcParts,
} from './store.ts';

let dir: string;
const enc = (s: string) => new TextEncoder().encode(s);

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ws-store-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('isSafeRelPath', () => {
  it.each(['heroes.json', 'public/draft.json', 'img/heroes/abathur.webp', 'a.b.c'])('accepts %s', (p) => {
    expect(isSafeRelPath(p)).toBe(true);
  });
  it.each(['', '/abs.json', '../x.json', 'a/../b', 'a//b', './a', 'a\\b', 'C:/x', 'a/', 'a/./b'])('rejects %j', (p) => {
    expect(isSafeRelPath(p)).toBe(false);
  });
  it('resolveRel refuses unsafe paths', () => {
    expect(() => resolveRel(dir, '../escape')).toThrow(/Unsafe/);
  });
});

describe('listFiles', () => {
  it('returns sorted POSIX paths and [] for a missing dir', () => {
    mkdirSync(path.join(dir, 'b', 'c'), { recursive: true });
    writeFileSync(path.join(dir, 'b', 'c', 'z.json'), '1');
    writeFileSync(path.join(dir, 'a.json'), '1');
    writeFileSync(path.join(dir, 'b', 'y.json'), '1');
    expect(listFiles(dir)).toEqual(['a.json', 'b/c/z.json', 'b/y.json']);
    expect(listFiles(path.join(dir, 'missing'))).toEqual([]);
  });
});

describe('syncTree', () => {
  it('writes new files, removes stale ones, keeps protected ones and leaves unchanged files alone', () => {
    const target = path.join(dir, 'game');
    syncTree(target, new Map([
      ['a.json', enc('A')],
      ['old/x.json', enc('X')],
      ['img/p.webp', enc('P')],
    ]));
    const aPath = path.join(target, 'a.json');
    const past = new Date('2020-01-01T00:00:00Z');
    utimesSync(aPath, past, past);

    const r = syncTree(target, new Map([
      ['a.json', enc('A')],
      ['b.json', enc('B')],
    ]), (rel) => rel.startsWith('img/'));
    expect(r.written).toEqual(['b.json']);
    expect(r.unchanged).toEqual(['a.json']);
    expect(r.removed).toEqual(['old/x.json']);
    expect(listFiles(target)).toEqual(['a.json', 'b.json', 'img/p.webp']);
    expect(statSync(aPath).mtime.getTime()).toBe(past.getTime());
  });

  it('prunes directories left empty', () => {
    mkdirSync(path.join(dir, 'x', 'y'), { recursive: true });
    pruneEmptyDirs(dir);
    expect(listFiles(dir)).toEqual([]);
    expect(() => statSync(path.join(dir, 'x'))).toThrow();
  });
});

describe('serializeOutput', () => {
  it('pretty-prints data files, compacts public shards and passes bytes through', () => {
    const text = (u: Uint8Array) => new TextDecoder().decode(u);
    expect(text(serializeOutput({ path: 'heroes.json', data: { b: 1, a: 2 } }))).toBe('{\n  "a": 2,\n  "b": 1\n}\n');
    expect(text(serializeOutput({ path: 'public/draft.json', data: { b: 1, a: 2 } }))).toBe('{"a":2,"b":1}\n');
    const bytes = enc('raw');
    expect(serializeOutput({ path: 'img/x.webp', data: null, bytes })).toBe(bytes);
  });
});

describe('gzipDeterministic', () => {
  it('stamps the Unix OS byte, round-trips and is repeatable', () => {
    const input = enc('{"hello":"world"}\n'.repeat(50));
    const a = gzipDeterministic(input);
    const b = gzipDeterministic(input);
    expect(a[9]).toBe(3);
    expect(Buffer.compare(a, b)).toBe(0);
    expect(gunzipSync(a).toString('utf8')).toBe(new TextDecoder().decode(input));
    writeFileSync(path.join(dir, 'x.gz'), a);
    expect(readFileSync(path.join(dir, 'x.gz')).byteLength).toBe(a.byteLength);
  });
});

describe('utcParts', () => {
  it('uses the UTC calendar day', () => {
    expect(utcParts(new Date('2026-10-08T23:59:59-06:00'))).toEqual({ yyyy: '2026', mm: '10', dd: '09' });
  });
});
