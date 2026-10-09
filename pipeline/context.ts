/**
 * Builds the PipelineContext handed to each game's DataPipeline.run().
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { GameId, GameMeta, Http, PipelineContext } from '../src/core/game.ts';
import { META_FILE } from './manifest.ts';
import { readJson, resolveRel } from './store.ts';

/** Environment variables exposed to games as `ctx.secrets`. Anything else stays invisible to them. */
export const SECRET_NAMES = ['HP_API_KEY', 'HP_MODE', 'YT_API_KEY', 'TWITCH_CLIENT_ID', 'TWITCH_CLIENT_SECRET', 'LIQUIPEDIA_UA_CONTACT'] as const;

/**
 * GitHub passes unset secrets as empty strings; normalise those to undefined. HP_MODE is the
 * Heroes Profile kill switch and is 'off' unless explicitly 'on' (SPEC §1.2).
 */
export function secretsFromEnv(env: Readonly<Record<string, string | undefined>>): Readonly<Record<string, string | undefined>> {
  const out: Record<string, string | undefined> = {};
  for (const name of SECRET_NAMES) {
    const v = env[name]?.trim();
    out[name] = v ? v : undefined;
  }
  out.HP_MODE = out.HP_MODE?.toLowerCase() === 'on' ? 'on' : 'off';
  return Object.freeze(out);
}

export function hpEnabled(secrets: Readonly<Record<string, string | undefined>>): boolean {
  return secrets.HP_MODE === 'on';
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
    secrets: secretsFromEnv(o.env),
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
