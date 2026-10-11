/**
 * Builds the PipelineContext handed to each game's DataPipeline.run().
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { GameId, GameMeta, Http, PipelineContext } from '../src/core/game.ts';
import { gameById, games } from '../src/games/registry.ts';
import { META_FILE } from './manifest.ts';
import { readJson, resolveRel } from './store.ts';

/**
 * Environment variables a game's pipeline may read through `ctx.secrets`: only the ones its
 * registry entry lists (GamePresentation.pipeline.env in src/games/registry.ts), so a credential
 * meant for one game never reaches another game's code. GITHUB_TOKEN (the workflow's own token in
 * CI) is never exposed to games: the Http client sends it to api.github.com only, so GitHub API
 * calls get 1,000 requests/hour instead of 60 per runner IP.
 */
export function gameEnvNames(game: GameId): readonly string[] {
  return [...(gameById(game).pipeline.env ?? []), ...(LEGACY_ENV[game] ?? [])];
}

/**
 * Transitional: the Heroes Profile step under src/games/hots/pipeline still reads these until the
 * HotS pipeline drops it (Heroes Profile is removed, SPEC §13). No workflow passes them any more,
 * so in CI they are always unset and that step stays disabled. Delete this with the step.
 */
const LEGACY_ENV: Partial<Record<GameId, readonly string[]>> = { hots: ['HP_API_KEY', 'HP_MODE'] };

/** Every variable any game may read (for tooling that has no game context). */
export function allGameEnvNames(): string[] {
  return [...new Set(games.flatMap((g) => gameEnvNames(g.id)))].sort();
}

/** Hosts that receive a bearer token from the environment (pipeline/http.ts `bearer`). */
export function bearerTokens(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const token = env.GITHUB_TOKEN?.trim();
  return token ? { 'api.github.com': token } : {};
}

/**
 * The variables one game may read, from the environment. GitHub passes unset secrets as empty
 * strings; those become undefined. Without a game, every game's variables are included.
 */
export function secretsFromEnv(env: Readonly<Record<string, string | undefined>>, game?: GameId): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const name of game ? gameEnvNames(game) : allGameEnvNames()) {
    const v = env[name]?.trim();
    out[name] = v ? v : undefined;
  }
  return Object.freeze(out);
}

export interface ContextOptions {
  game: GameId;
  root: string;
  /** Absolute data output directory (contains current/, private/). */
  out: string;
  http: Http;
  env: Readonly<Record<string, string | undefined>>;
  now: Date;
  offline: boolean;
  /** Source ids requested with --only, or null for all. */
  only: readonly string[] | null;
  log: (msg: string, extra?: unknown) => void;
}

const selections = new WeakMap<PipelineContext, readonly string[] | null>();

/**
 * Whether a source should be fetched in this run (`--only` filter). Games that honour --only
 * should re-emit last-good files (via ctx.previous) for sources that are not selected.
 */
export function isSelected(ctx: PipelineContext, sourceId: string): boolean {
  const only = selections.get(ctx);
  return !only || only.includes(sourceId);
}

export function gameDirs(out: string, game: GameId): { current: string; private: string } {
  return { current: path.join(out, 'current', game), private: path.join(out, 'private', game) };
}

export function createContext(o: ContextOptions): PipelineContext {
  const dirs = gameDirs(o.out, o.game);
  const previousMeta = readJson<GameMeta>(path.join(dirs.current, META_FILE));
  const ctx: PipelineContext = {
    game: o.game,
    http: o.http,
    secrets: secretsFromEnv(o.env, o.game),
    previousMeta,
    now: o.now,
    offline: o.offline,
    root: o.root,
    log: o.log,
    async previous(rel: string): Promise<unknown | null> {
      for (const base of [dirs.current, dirs.private]) {
        const file = resolveRel(base, rel);
        if (!existsSync(file)) continue;
        if (rel.endsWith('.json')) return readJson(file);
        return new Uint8Array(readFileSync(file));
      }
      return null;
    },
  };
  selections.set(ctx, o.only);
  return ctx;
}
