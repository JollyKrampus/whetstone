/**
 * Plan job of data-deploy.yml: which games refresh in this run, and the data-job matrix.
 *
 *   node scripts/plan.ts --event <github.event_name> [--games all|none|a,b]
 *
 * The matrix comes from the registry (src/games/registry.ts): one entry per selected game with
 * its data-job timeout (GamePresentation.pipeline.timeoutMinutes), so adding a game to GAME_IDS
 * adds it to the daily run with no workflow edit. Writes to $GITHUB_OUTPUT:
 *   matrix    {"include":[{"game":"hots","timeout":90},…]}
 *   games     comma list of the selected games ('' when none)
 *   run_data  true when any game runs
 *   pokemon   true when the Pokémon data job runs (the isolated showdown-export job feeds it)
 * Push events and games=none select nothing (rebuild from the data branch).
 *
 * Runs before `npm ci`: it imports only the registry, which needs no dependencies.
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { GameId } from '../src/core/game.ts';
import { games, isGameId } from '../src/games/registry.ts';

export interface Plan {
  games: GameId[];
  matrix: { include: { game: GameId; timeout: number }[] };
}

/** Selected games for an event and the `games` dispatch input. Throws on an unknown id. */
export function plan(event: string, input: string | undefined): Plan {
  const all = games.map((g) => g.id);
  let selected: GameId[];
  const value = (input ?? '').trim();
  if (event === 'push' || value === 'none') selected = [];
  else if (value === '' || value === 'all') selected = all;
  else {
    const asked = value.split(/[\s,]+/).filter(Boolean);
    const unknown = asked.filter((g) => !isGameId(g));
    if (unknown.length > 0) throw new Error(`Unknown game ${unknown.map((g) => `'${g}'`).join(', ')} (expected ${all.join(', ')}, all or none)`);
    // Registry order, each once.
    selected = all.filter((id) => asked.includes(id));
  }
  return {
    games: selected,
    matrix: { include: selected.map((id) => ({ game: id, timeout: games.find((g) => g.id === id)?.pipeline.timeoutMinutes ?? 60 })) },
  };
}

/** $GITHUB_OUTPUT lines for a plan. */
export function planOutputs(p: Plan): string[] {
  return [
    `matrix=${JSON.stringify(p.matrix)}`,
    `games=${p.games.join(',')}`,
    `run_data=${p.games.length > 0}`,
    `pokemon=${p.games.includes('pokemon')}`,
  ];
}

function main(argv: string[], env: NodeJS.ProcessEnv): number {
  const { values } = parseArgs({ args: argv, options: { event: { type: 'string', default: '' }, games: { type: 'string', default: '' } }, strict: true });
  let p: Plan;
  try {
    p = plan(values.event, values.games);
  } catch (err) {
    console.log(`::error::${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const lines = planOutputs(p);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, lines.join('\n') + '\n');
  console.log(`games: ${p.games.join(', ') || 'none'}`);
  for (const line of lines) console.log(line);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2), process.env);
}
