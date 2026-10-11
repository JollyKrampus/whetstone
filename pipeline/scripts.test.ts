import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCatFileBatch, parseLsTree } from '../scripts/data-pull.ts';
import { buildServiceWorker, DATA_ROUTE, WORKER_ROUTE } from '../scripts/sw.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'ws-scripts-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('data-pull git parsing', () => {
  it('parses ls-tree -z records, including paths with spaces', () => {
    const out = Buffer.from(['100644 blob aaa\tcurrent/hots/meta.json', '100644 blob bbb\tcurrent/hots/a b.json', ''].join('\u0000'));
    expect(parseLsTree(out)).toEqual([
      { mode: '100644', type: 'blob', sha: 'aaa', path: 'current/hots/meta.json' },
      { mode: '100644', type: 'blob', sha: 'bbb', path: 'current/hots/a b.json' },
    ]);
  });

  it('parses cat-file --batch output with binary content', () => {
    const bin = Buffer.from([0x00, 0x0a, 0xff]);
    const out = Buffer.concat([Buffer.from('aaa blob 3\n'), bin, Buffer.from('\nbbb blob 2\n{}\n')]);
    const blobs = parseCatFileBatch(out);
    expect(blobs.get('aaa')?.equals(bin)).toBe(true);
    expect(blobs.get('bbb')?.toString()).toBe('{}');
    expect(() => parseCatFileBatch(Buffer.from('ccc missing\n'))).toThrow(/unexpected header/);
  });
});

describe('service worker', () => {
  it('routes data shards but leaves internal "_" shards to their own cache', () => {
    const at = (p: string) => DATA_ROUTE.test(`https://jollykrampus.github.io${p}`);
    expect(at('/whetstone/data/hots/draft.1a2b3c4d.json')).toBe(true);
    expect(at('/whetstone/data/pokemon/dex.1a2b3c4d.json')).toBe(true);
    expect(at('/whetstone/data/manifest.json')).toBe(true);
    expect(at('/whetstone/data/mtga/_cards.arena.1a2b3c4d.json')).toBe(false);
    expect(at('/whetstone/data/mtga/_cards.standard.1a2b3c4d.json')).toBe(false);
    expect(at('/whetstone/data/hots/img/heroes/abathur.webp')).toBe(false);
    expect(WORKER_ROUTE.test('https://jollykrampus.github.io/whetstone/_astro/calc.worker-DHzYGrRf.js')).toBe(true);
    expect(WORKER_ROUTE.test('https://jollykrampus.github.io/whetstone/_astro/DraftTool.CpQEU60N.js')).toBe(false);
  });

  it('precaches island chunks but not worker chunks or data', async () => {
    const put = (rel: string, body: string) => {
      const file = path.join(dir, ...rel.split('/'));
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, body);
    };
    put('index.html', '<!doctype html>');
    put('_astro/client.abc123.js', 'export {}');
    put('_astro/calc.worker-DHzYGrRf.js', 'self.onmessage = () => {}');
    put('_astro/Base.abc123.css', 'body{}');
    put('data/hots/draft.1a2b3c4d.json', '{}');
    const r = await buildServiceWorker(dir, { quiet: true });
    const sw = readFileSync(r.swDest, 'utf8');
    expect(r.count).toBe(2);
    expect(sw).toContain('/whetstone/_astro/client.abc123.js');
    expect(sw).not.toContain('calc.worker-DHzYGrRf.js');
    expect(sw).not.toContain('draft.1a2b3c4d.json');
    expect(sw).toContain('whetstone-workers');
  });
});
