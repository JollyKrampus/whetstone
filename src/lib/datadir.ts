/**
 * Build-time (Node) resolution of where game data lives. Only src/games/<game>/load.ts and
 * site-wide build code should import this; never import it from an island.
 *
 * Order per game:
 *   1. $WHETSTONE_DATA_DIR/current/<game>  (CI sets WHETSTONE_DATA_DIR=data)
 *   2. data/current/<game>                  (local pipeline run or `npm run data:pull`)
 *   3. fixtures/<game>                      (committed snapshot; dev and PR CI work offline)
 * WHETSTONE_FIXTURES=1 skips step 2, so a local data/ dir cannot change the result (Vitest sets
 * it; `WHETSTONE_FIXTURES=1 npm run build` gives a CI-parity build next to a live data/ dir).
 *
 * Private (class B/C) files sit next to the chosen data: <root>/private/<game> for steps 1 and 2,
 * and for fixtures fixtures/<game>/_private, only when WHETSTONE_FIXTURE_PRIVATE=1 (synthetic
 * samples). pipeline/stage.ts (resolveDataDirs) applies the same rules.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameId, GameMeta } from '../core/game.ts';

const PACKAGE_NAME = 'whetstone';

/** Nearest ancestor of `start` (inclusive) holding this repo's package.json, or null. */
function findRepoRoot(start: string): string | null {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const pkg = path.join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        if ((JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }).name === PACKAGE_NAME) return dir;
      } catch {
        // Unreadable or foreign package.json: keep walking up.
      }
    }
    if (path.dirname(dir) === dir) return null;
  }
}

// Astro bundles this module for prerendering, so import.meta.url may point at a chunk under
// .astro/ or the build output rather than src/lib/. Walking up to the package.json works from
// both; cwd covers an output directory outside the repo (WHETSTONE_OUT_DIR), where astro runs
// from the repo root anyway.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = findRepoRoot(HERE) ?? findRepoRoot(process.cwd()) ?? path.resolve(HERE, '../..');

export function repoRoot(): string {
  return ROOT;
}

/** True when WHETSTONE_FIXTURES=1 pins every game to an explicit WHETSTONE_DATA_DIR or fixtures/. */
export function fixturesPinned(): boolean {
  return process.env.WHETSTONE_FIXTURES === '1';
}

function candidates(game: GameId): string[] {
  const env = process.env.WHETSTONE_DATA_DIR;
  const list: string[] = [];
  if (env) list.push(path.resolve(ROOT, env, 'current', game));
  if (!fixturesPinned()) list.push(path.join(ROOT, 'data', 'current', game));
  list.push(path.join(ROOT, 'fixtures', game));
  return list;
}

const resolved = new Map<GameId, string>();

/** Directory holding the class A/A-SA files for a game. */
export function gameDataDir(game: GameId): string {
  const hit = resolved.get(game);
  if (hit) return hit;
  const dir = candidates(game).find((d) => existsSync(path.join(d, 'meta.json')));
  if (!dir) {
    throw new Error(
      `No data for "${game}": expected meta.json in one of ${candidates(game).join(', ')}. ` +
        'Run `npm run data:pull`, `npm run data`, or restore fixtures/.',
    );
  }
  resolved.set(game, dir);
  return dir;
}

/**
 * Directory holding class B/C files for a game, or null if none were produced. It always pairs
 * with gameDataDir: <root>/current/<game> → <root>/private/<game>; fixtures/<game> →
 * fixtures/<game>/_private when WHETSTONE_FIXTURE_PRIVATE=1.
 */
export function gamePrivateDir(game: GameId): string | null {
  const dir = gameDataDir(game);
  const candidate = usingFixtures(game)
    ? process.env.WHETSTONE_FIXTURE_PRIVATE === '1'
      ? path.join(dir, '_private')
      : null
    : path.join(path.dirname(path.dirname(dir)), 'private', game);
  return candidate && existsSync(candidate) ? candidate : null;
}

/** True when the game's data is coming from committed fixtures rather than a pipeline run. */
export function usingFixtures(game: GameId): boolean {
  return gameDataDir(game).startsWith(path.join(ROOT, 'fixtures'));
}

const cache = new Map<string, unknown>();

/** Read and parse a JSON file relative to the game's data dir. Throws if missing unless `optional`. */
export function readGameJson<T = unknown>(game: GameId, file: string, opts: { optional?: boolean; private?: boolean } = {}): T | null {
  const base = opts.private ? gamePrivateDir(game) : gameDataDir(game);
  if (!base) return null;
  const full = path.join(base, file);
  if (cache.has(full)) return cache.get(full) as T;
  if (!existsSync(full)) {
    if (opts.optional) return null;
    throw new Error(`Missing data file ${full}`);
  }
  const value = JSON.parse(readFileSync(full, 'utf8')) as T;
  cache.set(full, value);
  return value;
}

export function readGameMeta(game: GameId): GameMeta {
  return readGameJson<GameMeta>(game, 'meta.json') as GameMeta;
}
