/**
 * Build-time (Node-only) access to a game's meta.json for the shell. Never throws: a game whose
 * data is missing or half-written (fixtures still being produced, a failed pipeline) renders
 * with a "no data yet" badge instead of failing the whole build.
 */
import type { GameId, GameMeta, SourceState, SourceStatus } from '../core/game.ts';
import { readGameMeta, usingFixtures } from '../lib/datadir.ts';

export interface GameMetaInfo {
  meta: GameMeta | null;
  /** True when the numbers come from committed fixtures rather than a pipeline run. */
  fixtures: boolean;
}

const STATES: readonly SourceState[] = ['ok', 'stale', 'failed', 'disabled'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toStatus(value: unknown): SourceStatus | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const status = STATES.find((s) => s === value.status) ?? 'ok';
  const fetchedAt = typeof value.fetchedAt === 'string' ? value.fetchedAt : null;
  return {
    id: value.id,
    fetchedAt,
    status,
    ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
  };
}

function normalize(game: GameId, raw: unknown): GameMeta | null {
  if (!isRecord(raw)) return null;
  const version = isRecord(raw.version) ? raw.version : {};
  const counts: Record<string, number> = {};
  if (isRecord(raw.counts)) {
    for (const [k, v] of Object.entries(raw.counts)) if (typeof v === 'number') counts[k] = v;
  }
  return {
    game,
    schema: typeof raw.schema === 'number' ? raw.schema : 0,
    version: {
      label: typeof version.label === 'string' ? version.label : '',
      ...(typeof version.build === 'string' ? { build: version.build } : {}),
      ...(typeof version.since === 'string' ? { since: version.since } : {}),
    },
    generatedAt: typeof raw.generatedAt === 'string' ? raw.generatedAt : '',
    dataHash: typeof raw.dataHash === 'string' ? raw.dataHash : '',
    sources: Array.isArray(raw.sources) ? raw.sources.map(toStatus).filter((s): s is SourceStatus => s !== null) : [],
    counts,
    ...(isRecord(raw.extra) ? { extra: raw.extra } : {}),
  };
}

const memo = new Map<GameId, GameMetaInfo>();

export function loadGameMeta(game: GameId): GameMetaInfo {
  const hit = memo.get(game);
  if (hit) return hit;
  let info: GameMetaInfo;
  try {
    const meta = normalize(game, readGameMeta(game));
    let fixtures = false;
    try {
      fixtures = usingFixtures(game);
    } catch {
      fixtures = false;
    }
    info = { meta, fixtures };
  } catch {
    info = { meta: null, fixtures: false };
  }
  memo.set(game, info);
  return info;
}
