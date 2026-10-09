import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseCatFileBatch, parseLsTree } from '../scripts/data-pull.ts';
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
