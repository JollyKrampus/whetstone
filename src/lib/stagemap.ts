/**
 * Build-time (Node) lookup of browser-fetched shards staged by pipeline/stage.ts (SPEC §3).
 * Call it in .astro frontmatter and hand the URL to an island as a prop; islands never import
 * this module or src/generated/stage-map.json themselves.
 *
 *   const draftUrl = stagedUrl('hots', 'draft');   // '/whetstone/data/hots/draft.1a2b3c4d.json'
 *
 * The map is read from disk on every call (it is tiny) so `astro dev` picks up a re-stage
 * without a restart. `npm run build` and `npm run dev` stage first; for anything else run
 * `node pipeline/stage.ts` once.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { GameId } from '../core/game.ts';
import { withBase } from '../games/registry.ts';
import { repoRoot } from './datadir.ts';

export type StageMap = Readonly<Record<string, string>>;

export const STAGE_MAP_FILE = 'src/generated/stage-map.json';

/** Parsed stage map; throws with a fix-it hint when the file has not been generated yet. */
export function readStageMap(root: string = repoRoot()): StageMap {
  const file = path.join(root, STAGE_MAP_FILE);
  if (!existsSync(file)) {
    throw new Error(`${STAGE_MAP_FILE} is missing. Run \`node pipeline/stage.ts\` (npm run build and npm run dev do this first).`);
  }
  return JSON.parse(readFileSync(file, 'utf8')) as StageMap;
}

/**
 * Site-relative path ('data/<game>/<name>.<hash8>.<ext>') of a staged shard, or null when the
 * game's data has no such shard. `name` is the path under public/ without its extension,
 * e.g. 'draft' or '_cards.standard'.
 */
export function lookupStaged(map: StageMap, game: GameId, name: string): string | null {
  return map[`${game}/${name}`] ?? null;
}

/** Base-prefixed URL of a staged shard. Throws when it is missing, listing what the game has. */
export function stagedUrl(game: GameId, name: string, map: StageMap = readStageMap()): string {
  const rel = lookupStaged(map, game, name);
  if (rel === null) {
    const known = Object.keys(map)
      .filter((k) => k.startsWith(`${game}/`))
      .map((k) => k.slice(game.length + 1));
    throw new Error(
      `No staged shard "${game}/${name}" in ${STAGE_MAP_FILE} (staged for ${game}: ${known.join(', ') || 'none'}). ` +
        `Emit it under public/ from the ${game} pipeline (or fixtures/${game}/public/) and re-run \`node pipeline/stage.ts\`.`,
    );
  }
  return withBase(rel);
}

/** Like stagedUrl, but null when the shard is absent (optional data such as a class-B overlay). */
export function stagedUrlOrNull(game: GameId, name: string, map: StageMap = readStageMap()): string | null {
  const rel = lookupStaged(map, game, name);
  return rel === null ? null : withBase(rel);
}
