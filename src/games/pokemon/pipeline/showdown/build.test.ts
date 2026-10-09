import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fakeHttp } from '../test-support.ts';
import { extractSources, isNeededSource, latestSha, parseRefAdvertisement, sourceZipUrl, transpileTree } from './build.ts';

const SHA = '7332b60e22b9e8194bb53549549eba241d73cc9a';
const OTHER = '1111111111111111111111111111111111111111';

describe('commit lookup', () => {
  it('parses the git smart-HTTP ref advertisement', () => {
    const text = `001e# service=git-upload-pack\n0000015${OTHER} HEAD\0multi_ack side-band-64k\n003f${SHA} refs/heads/master\n003f${OTHER} refs/heads/other\n0000`;
    expect(parseRefAdvertisement(text, 'refs/heads/master')).toBe(SHA);
    expect(parseRefAdvertisement(text, 'refs/heads/missing')).toBeNull();
  });

  it('uses the GitHub API and falls back to the ref advertisement', async () => {
    const api = fakeHttp({ 'https://api.github.com/repos/smogon/pokemon-showdown/commits/master': `${SHA}\n` });
    expect(await latestSha(api)).toBe(SHA);
    expect(api.inits[0]?.headers?.accept).toBe('application/vnd.github.sha');

    const limited = fakeHttp({
      'https://api.github.com/': new Error('GET -> 403 (rate limited)'),
      'https://github.com/smogon/pokemon-showdown.git/info/refs?service=git-upload-pack': `003f${SHA} refs/heads/master\n`,
    });
    const logs: string[] = [];
    expect(await latestSha(limited, (m) => logs.push(m))).toBe(SHA);
    expect(logs[0]).toMatch(/rate limited/);

    const garbage = fakeHttp({ 'https://api.github.com/': '<html>', 'https://github.com/': 'nothing here' });
    await expect(latestSha(garbage)).rejects.toThrow(/refs\/heads\/master/);
  });

  it('downloads the source of exactly that commit', () => {
    expect(sourceZipUrl(SHA)).toBe(`https://codeload.github.com/smogon/pokemon-showdown/zip/${SHA}`);
  });
});

describe('source extraction', () => {
  it('keeps sim/, lib/, data/ and config/formats.ts, minus random battles and type declarations', () => {
    expect(isNeededSource('sim/dex.ts')).toBe(true);
    expect(isNeededSource('data/mods/champions/learnsets.ts')).toBe(true);
    expect(isNeededSource('data/aliases.ts')).toBe(true);
    expect(isNeededSource('config/formats.ts')).toBe(true);
    expect(isNeededSource('lib/fs.ts')).toBe(true);
    expect(isNeededSource('data/random-battles/gen9/teams.ts')).toBe(false);
    expect(isNeededSource('sim/tools/exhaustive-runner.ts')).toBe(false);
    expect(isNeededSource('server/chat.ts')).toBe(false);
    expect(isNeededSource('config/config-example.js')).toBe(false);
    expect(isNeededSource('sim/global-types.d.ts')).toBe(false);
    expect(isNeededSource('README.md')).toBe(false);
  });

  it('strips the zip top folder and insists on the files the exporter needs', () => {
    const top = `pokemon-showdown-${SHA}`;
    const zip = zipSync({
      [`${top}/sim/dex.ts`]: strToU8('export const x = 1;'),
      [`${top}/config/formats.ts`]: strToU8('export const Formats = [];'),
      [`${top}/server/index.ts`]: strToU8('nope'),
    });
    const files = extractSources(zip);
    expect([...files.keys()].sort()).toEqual(['config/formats.ts', 'sim/dex.ts']);
    expect(() => extractSources(zipSync({ [`${top}/sim/battle.ts`]: strToU8('') }))).toThrow(/sim\/dex.ts/);
  });
});

describe('transpileTree', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'ws-sd-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes CommonJS in its own package scope, plus the PRNG stub', async () => {
    const files = new Map<string, Uint8Array>([
      ['sim/dex.ts', strToU8("import { helper } from '../lib/util';\nexport const Dex = { name: helper('dex') as string };\n")],
      ['lib/util.ts', strToU8('export function helper(s: string): string { return s.toUpperCase(); }\n')],
      ['data/table.json', strToU8('{"a":1}')],
    ]);
    expect(await transpileTree(files, dir)).toBe(2);
    // The repo's package.json says "type": "module"; the tree must not inherit that.
    expect(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))).toEqual({ type: 'commonjs' });
    const req = createRequire(path.join(dir, 'sim', 'index.js'));
    expect((req('./dex.js') as { Dex: { name: string } }).Dex.name).toBe('DEX');
    expect(readFileSync(path.join(dir, 'data', 'table.json'), 'utf8')).toBe('{"a":1}');
    const stub = req('ts-chacha20') as { Chacha20: new () => unknown };
    expect(() => new stub.Chacha20()).toThrow(/not available/);
  });
});
