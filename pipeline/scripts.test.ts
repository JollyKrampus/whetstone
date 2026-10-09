import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCatFileBatch, parseLsTree } from '../scripts/data-pull.ts';
import { buildServiceWorker, DATA_ROUTE, WORKER_ROUTE } from '../scripts/sw.ts';
import { collectDistFiles, relativeImports, staleCoreInputs } from '../scripts/sync-grindstone.ts';

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

describe('sync-grindstone', () => {
  it('finds relative static, dynamic and re-export imports', () => {
    const src = `import { z } from "zod";\nimport { a } from "./chunk-ABC.js";\nexport * from './other.js';\nconst m = import("./lazy.js");\nimport "./side.js";`;
    expect(relativeImports(src)).toEqual(['./chunk-ABC.js', './lazy.js', './other.js', './side.js']);
  });

  it('collects chunk files reachable from the entries and maps .d.ts imports', () => {
    writeFileSync(path.join(dir, 'core.js'), 'import { x } from "./chunk-1.js"; export { x };');
    writeFileSync(path.join(dir, 'chunk-1.js'), 'export const x = 1;');
    writeFileSync(path.join(dir, 'core.d.ts'), "export * from './types.js';");
    writeFileSync(path.join(dir, 'types.d.ts'), 'export type T = 1;');
    expect(collectDistFiles(dir, ['core.js', 'core.d.ts'])).toEqual(['chunk-1.js', 'core.d.ts', 'core.js', 'types.d.ts']);
    writeFileSync(path.join(dir, 'core.js'), 'import "./missing.js";');
    expect(() => collectDistFiles(dir, ['core.js'])).toThrow(/missing\.js/);
  });

  it('flags sources whose content differs from the bundled sourcesContent', () => {
    const dist = path.join(dir, 'dist');
    mkdirSync(path.join(dir, 'src'), { recursive: true });
    mkdirSync(dist);
    writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\r\n');
    writeFileSync(path.join(dir, 'src', 'b.ts'), 'export const b = 2;\n');
    writeFileSync(path.join(dist, 'core.js.map'), JSON.stringify({ sources: ['../src/a.ts', '../src/b.ts', '../src/gone.ts'], sourcesContent: ['export const a = 1;\n', 'export const b = 1;\n', 'x'] }));
    expect(staleCoreInputs(dir, dist)).toEqual(['src/b.ts']);
  });

  it('resolves the vendored core through the #vendor import alias', async () => {
    const core = (await import('#vendor/grindstone/core.js')) as Record<string, unknown>;
    expect(Object.keys(core).length).toBeGreaterThan(50);
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
