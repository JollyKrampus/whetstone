/**
 * Build-time (Node) resolution of where game data lives. Only src/games/<game>/load.ts and
 * site-wide build code should import this; never import it from an island.
 *
 * Order per game:
 *   1. $WHETSTONE_DATA_DIR/current/<game>  (CI sets WHETSTONE_DATA_DIR=data)
 *   2. data/current/<game>                  (local pipeline run or `npm run data:pull`)
 *   3. fixtures/<game>                      (committed snapshot; dev and PR CI work offline)
 * Private (class B/C) files come from $WHETSTONE_DATA_DIR/private/<game> or data/private/<game>, if present.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameId, GameMeta } from '../core/game.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function repoRoot(): string {
  return ROOT;
}

function candidates(game: GameId): string[] {
  const env = process.env.WHETSTONE_DATA_DIR;
  const list: string[] = [];
  if (env) list.push(path.resolve(ROOT, env, 'current', game));
  list.push(path.join(ROOT, 'data', 'current', game));
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

/** Directory holding class B/C files for a game, or null if none were produced. */
export function gamePrivateDir(game: GameId): string | null {
  const env = process.env.WHETSTONE_DATA_DIR;
  const list = [
    ...(env ? [path.resolve(ROOT, env, 'private', game)] : []),
    path.join(ROOT, 'data', 'private', game),
  ];
  return list.find((d) => existsSync(d)) ?? null;
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
