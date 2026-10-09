/**
 * Shared helpers for the HotS pipeline unit tests: the recorded raw fixtures
 * (src/games/hots/fixtures/raw/) and the curated inputs. Node only; used by *.test.ts files.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { loadPipelineCurated, type PipelineCurated } from './curated.ts';
import { readRelease, wantedEntry, type RawRelease } from './transform/release.ts';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
export const RAW_DIR = path.join(REPO_ROOT, 'src', 'games', 'hots', 'fixtures', 'raw');

/** Builds with a recorded (trimmed) heroes-data2 release fixture. */
export const FIXTURE_BUILDS = ['2.55.17.98025', '2.57.0.98285', '2.57.0.98348'] as const;
/** Heroes in the trimmed release fixtures (heroes-data2 keys). */
export const FIXTURE_HEROES = ['Abathur', 'Alexstrasza', 'Cho', 'Gall', 'Xalatath'] as const;
/** Fixed "now" used by fixture-based tests (Xal'atath, released 2026-09-28, is new). */
export const FIXTURE_NOW = new Date('2026-10-08T10:17:00Z');

export function rawFixture(rel: string): Buffer {
  return readFileSync(path.join(RAW_DIR, rel));
}

export function rawText(rel: string): string {
  return rawFixture(rel).toString('utf8');
}

export function rawJson<T = unknown>(rel: string): T {
  return JSON.parse(rawText(rel)) as T;
}

const releases = new Map<string, RawRelease>();

/** A trimmed heroes-data2 release from the fixtures (memoised). */
export function fixtureRelease(build: (typeof FIXTURE_BUILDS)[number], locales = true): RawRelease {
  const key = `${build}|${locales}`;
  let r = releases.get(key);
  if (!r) {
    const bytes = new Uint8Array(rawFixture(`heroes-data2/heroes-data-no-maps-${build}.bin`));
    r = readRelease(unzipSync(bytes, { filter: (f) => wantedEntry(f.name, { locales }) }));
    releases.set(key, r);
  }
  return r;
}

let curated: PipelineCurated | null = null;

export function testCurated(): PipelineCurated {
  curated ??= loadPipelineCurated(REPO_ROOT);
  return curated;
}
