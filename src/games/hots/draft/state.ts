/**
 * Shareable draft state in the URL hash (SPEC §7, critique C9), built on src/core/urlstate.ts:
 *
 *   Storm League  #v=1&m=cursed-hollow&fp=b&s=0a--1f0c…   (s = one entry per decision, '--' = missed ban)
 *   Free mode     #v=1&mode=free&m=…&ap=…&bp=…&ab=…&bb=…  (your/enemy picks, your/enemy bans)
 *   ARAM          #v=1&o=…&a=…&e=…&m=…                    (options, allies, enemies)
 *
 * Hero ids are packed as 2-character base36 indices into the *universe*: draftable entities
 * ordered by (releaseDate, id). New heroes are released later than every existing one, so they
 * are appended and old links keep their meaning. Defaults are omitted, so an empty draft is "#v=1".
 *
 * Restoring never throws: unknown values fall back to defaults and an illegal step keeps the
 * longest legal prefix (replaySequential / replayFree).
 */
import {
  applyFree,
  freeTeam,
  replaySequential,
  startFree,
  type FreeConfig,
  type FreeMove,
  type FreeState,
  type Illegal,
  type SequentialConfig,
  type SequentialState,
} from '../../../core/draft.ts';
import { createHashCodec, field, type HashCodec } from '../../../core/urlstate.ts';
import { FREE_MAX_BANS, FREE_TEAM_SIZE, SL_STEPS, type FirstPick } from './rules.ts';

export type DraftMode = 'sl' | 'free';

export const HASH_VERSION = 1;
const MAP_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface RosterEntry {
  id: string;
  /** ISO date; entities without one sort after every dated entity. */
  releaseDate?: string | undefined;
}

/** Stable universe for index packing: (releaseDate, id) ascending, duplicates dropped. */
export function buildUniverse(entities: readonly RosterEntry[]): string[] {
  const seen = new Set<string>();
  const list = entities.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)));
  return list
    .map((e) => ({ id: e.id, key: e.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(e.releaseDate) ? e.releaseDate : '9999-99-99' }))
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
    .map((e) => e.id);
}

function draftFields(universe: readonly string[]) {
  return {
    mode: field.enum('mode', ['sl', 'free'], 'sl'),
    map: field.str('m', '', { maxLength: 48, pattern: MAP_PATTERN }),
    firstPick: field.enum('fp', ['a', 'b'], 'a'),
    steps: field.ids('s', { universe, maxItems: SL_STEPS.length }),
    ourPicks: field.ids('ap', { universe, maxItems: FREE_TEAM_SIZE }),
    enemyPicks: field.ids('bp', { universe, maxItems: FREE_TEAM_SIZE }),
    ourBans: field.ids('ab', { universe, maxItems: FREE_MAX_BANS }),
    enemyBans: field.ids('bb', { universe, maxItems: FREE_MAX_BANS }),
  };
}

export type DraftCodec = HashCodec<{
  mode: DraftMode;
  map: string;
  firstPick: FirstPick;
  steps: (string | null)[];
  ourPicks: (string | null)[];
  enemyPicks: (string | null)[];
  ourBans: (string | null)[];
  enemyBans: (string | null)[];
}>;

export function createDraftCodec(universe: readonly string[]): DraftCodec {
  return createHashCodec({ version: HASH_VERSION, fields: draftFields(universe) }) as DraftCodec;
}

export type DraftHashState = ReturnType<DraftCodec['defaults']>;

/** What the hash holds for a Storm League draft. */
export function slHash(map: string, firstPick: FirstPick, state: SequentialState): Partial<DraftHashState> {
  return { mode: 'sl', map, firstPick, steps: [...state.choices] };
}

/** What the hash holds for a free-mode draft (team lists keep their own order). */
export function freeHash(map: string, state: FreeState): Partial<DraftHashState> {
  const a = freeTeam(state, 'A');
  const b = freeTeam(state, 'B');
  return { mode: 'free', map, ourPicks: a.picks, enemyPicks: b.picks, ourBans: a.bans, enemyBans: b.bans };
}

export interface Restored<S> {
  state: S;
  /** Decisions restored. */
  applied: number;
  /** Decisions the link asked for. */
  requested: number;
  /** Why restoring stopped early, if it did. */
  error?: Illegal;
}

/** Replay hash choices, keeping the longest legal prefix. Unknown ids arrive as null and stop at pick steps. */
export function restoreSequential(config: SequentialConfig, choices: readonly (string | null)[]): Restored<SequentialState> {
  const r = replaySequential(config, choices);
  return { state: r.state, applied: r.applied, requested: choices.length, ...(r.error ? { error: r.error } : {}) };
}

/** Rebuild a free-mode draft from the four lists (picks before bans, yours before the enemy's). */
export function restoreFree(config: FreeConfig, hash: Pick<DraftHashState, 'ourPicks' | 'enemyPicks' | 'ourBans' | 'enemyBans'>): Restored<FreeState> {
  const moves: FreeMove[] = [];
  const push = (team: 'A' | 'B', action: 'pick' | 'ban', ids: readonly (string | null)[]) => {
    for (const id of ids) if (id !== null) moves.push({ team, action, id });
  };
  push('A', 'pick', hash.ourPicks);
  push('B', 'pick', hash.enemyPicks);
  push('A', 'ban', hash.ourBans);
  push('B', 'ban', hash.enemyBans);
  // Free mode has no order to respect, so skip illegal moves instead of stopping at the first.
  let state = startFree(config);
  let applied = 0;
  let error: Illegal | undefined;
  for (const m of moves) {
    const r = applyFree(state, m);
    if (!r.ok) {
      error ??= r;
      continue;
    }
    state = r.state;
    applied++;
  }
  return { state, applied, requested: moves.length, ...(error ? { error } : {}) };
}

// ---- ARAM ------------------------------------------------------------------------------------

export const ARAM_OPTIONS = 3;
export const ARAM_ALLIES = 4;
export const ARAM_ENEMIES = 5;

function aramFields(universe: readonly string[]) {
  return {
    map: field.str('m', '', { maxLength: 48, pattern: MAP_PATTERN }),
    options: field.ids('o', { universe, maxItems: ARAM_OPTIONS }),
    allies: field.ids('a', { universe, maxItems: ARAM_ALLIES }),
    enemies: field.ids('e', { universe, maxItems: ARAM_ENEMIES }),
  };
}

export type AramCodec = HashCodec<{
  map: string;
  options: (string | null)[];
  allies: (string | null)[];
  enemies: (string | null)[];
}>;

export function createAramCodec(universe: readonly string[]): AramCodec {
  return createHashCodec({ version: HASH_VERSION, fields: aramFields(universe) }) as AramCodec;
}

export type AramHashState = ReturnType<AramCodec['defaults']>;
