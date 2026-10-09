/**
 * Heroes Profile v1 adapter: endpoint paths, query parameters and response shapes, mapped into
 * our neutral rows (transform/stats.ts HpWindowData). This is the ONLY file that knows HP's
 * wire format, and almost none of it is confirmed:
 *
 *   TODO(owner-verify): Heroes Profile's v1 documentation (https://www.heroesprofile.com/Api/Docs)
 *   is not publicly readable without a browser session (Cloudflare challenge, checked
 *   2026-10-08), and their terms forbid deriving it from their source code. Every path,
 *   parameter name and field name below is a placeholder chosen from common REST conventions.
 *   Once the owner has docs access (or fixture mode, which uses no quota), check each
 *   TODO(owner-verify) item, record a response with WHETSTONE_RECORD=1 into a local, uncommitted
 *   folder, and adjust this file only. The transforms and their tests work on our own row shapes
 *   and need no change.
 *
 * Parsing is deliberately tolerant (several candidate field names, list or `{ data: [...] }`
 * bodies) and strict about required numbers: a response without them raises an error naming
 * this file, so a wrong guess fails loudly instead of producing empty stats.
 */
import type { GameMode } from '../../schema.ts';
import type { HpBuildRow, HpHeroRow, HpMapRow, HpPairRow, HpWindowData } from '../transform/stats.ts';
import { asNumber, asString, isRecord } from '../util.ts';
import { HpBudgetError, type HpClient } from './heroesprofile.ts';

/** TODO(owner-verify): endpoint paths relative to https://www.heroesprofile.com/api/external/v1. */
export const HP_PATHS = {
  heroStats: 'heroes/stats',
  matchups: 'heroes/matchups',
  builds: 'heroes/talents/builds/all',
} as const;

/** TODO(owner-verify): game-type parameter values. */
const MODE_PARAM: Record<GameMode, string> = { sl: 'Storm League', qm: 'Quick Match', aram: 'ARAM' };

export interface HpWindowQuery {
  mode: GameMode;
  /** Game builds covered by the window. */
  builds: readonly string[];
}

/** TODO(owner-verify): parameter names for mode and build filters. */
export function windowParams(q: HpWindowQuery): Record<string, string> {
  return { game_type: MODE_PARAM[q.mode], game_version: [...q.builds].join(',') };
}

const ADAPTER = 'sources/heroesprofileAdapter.ts';

/** The list inside a response: the body itself, `data`, `results`, or an object keyed by name. */
export function rowsOf(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) return body.filter(isRecord);
  if (!isRecord(body)) return [];
  for (const key of ['data', 'results', 'rows', 'items']) {
    const v = body[key];
    if (Array.isArray(v)) return v.filter(isRecord);
    if (isRecord(v)) return rowsOf(v);
  }
  // `{ "Abathur": { … }, … }`: keep the key as the row's name.
  return Object.entries(body)
    .filter(([, v]) => isRecord(v))
    .map(([k, v]) => ({ name: k, ...(v as Record<string, unknown>) }));
}

function pickString(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const k of keys) {
    const v = asString(row[k]);
    if (v && v.trim()) return v.trim();
  }
  return undefined;
}

function pickNumber(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const k of keys) {
    const v = asNumber(row[k]);
    if (v !== undefined) return v;
  }
  return undefined;
}

// TODO(owner-verify): field names.
const HERO = ['hero', 'name', 'hero_name', 'heroName'];
const MAP = ['map', 'map_name', 'mapName', 'game_map'];
const OTHER = ['other', 'other_hero', 'versus', 'vs', 'ally', 'enemy', 'name'];
const GAMES = ['games', 'games_played', 'gamesPlayed', 'total_games', 'games_total'];
const WINS = ['wins', 'win', 'games_won'];
const LOSSES = ['losses', 'loss', 'games_lost'];
const BANS = ['bans', 'ban', 'banned', 'games_banned'];
const TALENTS = ['talents', 'build', 'talent_names'];

function wl(row: Record<string, unknown>): { games: number; wins: number } | null {
  const wins = pickNumber(row, WINS);
  const losses = pickNumber(row, LOSSES);
  let games = pickNumber(row, GAMES);
  if (games === undefined && wins !== undefined && losses !== undefined) games = wins + losses;
  if (games === undefined || wins === undefined || !(games >= 0) || !(wins >= 0)) return null;
  return { games: Math.round(games), wins: Math.round(Math.min(wins, games)) };
}

function assertParsed(rows: readonly unknown[], parsed: readonly unknown[], what: string): void {
  if (rows.length > 0 && parsed.length === 0) {
    throw new Error(`Heroes Profile ${what} response not recognised (no row had a hero name, games and wins); update ${ADAPTER} (TODO(owner-verify))`);
  }
}

export function parseHeroRows(body: unknown): HpHeroRow[] {
  const rows = rowsOf(body);
  const out: HpHeroRow[] = [];
  for (const r of rows) {
    const hero = pickString(r, HERO);
    const c = wl(r);
    if (!hero || !c) continue;
    const bans = pickNumber(r, BANS);
    out.push({ hero, ...c, ...(bans !== undefined ? { bans: Math.round(bans) } : {}) });
  }
  assertParsed(rows, out, 'hero stats');
  return out;
}

export function parseMapRows(body: unknown): HpMapRow[] {
  const out: HpMapRow[] = [];
  const rows = rowsOf(body);
  for (const r of rows) {
    // Either flat rows with a map field, or a hero row with nested per-map rows.
    const hero = pickString(r, HERO);
    const map = pickString(r, MAP);
    const c = wl(r);
    if (hero && map && c) {
      out.push({ hero, map, ...c });
      continue;
    }
    const nested = rowsOf(r.maps ?? r.by_map ?? null);
    for (const n of nested) {
      const m = pickString(n, [...MAP, 'name']);
      const nc = wl(n);
      if (hero && m && nc) out.push({ hero, map: m, ...nc });
    }
  }
  assertParsed(rows, out, 'hero-by-map stats');
  return out;
}

/** Matchup rows for one hero: allies and enemies, from `{ ally: [...], enemy: [...] }`-like bodies. */
export function parseMatchupRows(hero: string, body: unknown): { allies: HpPairRow[]; enemies: HpPairRow[] } {
  const scope = isRecord(body) && isRecord(body.data) ? body.data : body;
  const side = (keys: readonly string[]): HpPairRow[] => {
    if (!isRecord(scope)) return [];
    for (const k of keys) {
      if (scope[k] === undefined) continue;
      const rows = rowsOf(scope[k]);
      const out: HpPairRow[] = [];
      for (const r of rows) {
        const other = pickString(r, OTHER);
        const c = wl(r);
        if (other && c) out.push({ hero, other, ...c });
      }
      assertParsed(rows, out, `matchups (${k})`);
      return out;
    }
    return [];
  };
  const allies = side(['ally', 'allies', 'with']);
  const enemies = side(['enemy', 'enemies', 'against', 'vs']);
  if (allies.length === 0 && enemies.length === 0 && isRecord(scope) && Object.keys(scope).length > 0) {
    throw new Error(`Heroes Profile matchups response for ${hero} not recognised; update ${ADAPTER} (TODO(owner-verify))`);
  }
  return { allies, enemies };
}

export function parseBuildRows(body: unknown): HpBuildRow[] {
  const rows = rowsOf(body);
  const out: HpBuildRow[] = [];
  for (const r of rows) {
    const hero = pickString(r, HERO);
    const c = wl(r);
    let talents: string[] = [];
    for (const k of TALENTS) {
      const v = r[k];
      if (Array.isArray(v)) talents = v.filter((x): x is string => typeof x === 'string' && x.length > 0);
      else if (typeof v === 'string') talents = v.split(/[,|]/).map((x) => x.trim()).filter(Boolean);
      if (talents.length > 0) break;
    }
    if (talents.length === 0) {
      // `level_one` … `level_twenty` style columns.
      talents = ['level_one', 'level_four', 'level_seven', 'level_ten', 'level_thirteen', 'level_sixteen', 'level_twenty']
        .map((k) => asString(r[k]))
        .filter((x): x is string => Boolean(x));
    }
    if (hero && c && talents.length > 0 && talents.length <= 7) out.push({ hero, talents, ...c });
  }
  assertParsed(rows, out, 'talent builds');
  return out;
}

export interface FetchWindowResult {
  data: HpWindowData;
  /** Heroes whose matchups were skipped because the call budget ran out. */
  skippedMatchups: string[];
}

/**
 * One stats window: hero stats, hero×map stats, matchups per hero (one call each, budget
 * permitting) and talent builds.
 */
export async function fetchWindow(client: HpClient, q: HpWindowQuery, heroNames: readonly string[]): Promise<FetchWindowResult> {
  const params = windowParams(q);
  const heroes = parseHeroRows(await client.get(HP_PATHS.heroStats, params));
  // TODO(owner-verify): the per-map grouping parameter.
  const maps = parseMapRows(await client.get(HP_PATHS.heroStats, { ...params, group_by_map: 'true' }));
  let builds: HpBuildRow[] = [];
  try {
    builds = parseBuildRows(await client.get(HP_PATHS.builds, params));
  } catch (err) {
    if (!(err instanceof HpBudgetError)) throw err;
  }
  const allies: HpPairRow[] = [];
  const enemies: HpPairRow[] = [];
  const skippedMatchups: string[] = [];
  for (const name of heroNames) {
    if (client.calls >= client.budget) {
      skippedMatchups.push(name);
      continue;
    }
    // TODO(owner-verify): the hero parameter name.
    const m = parseMatchupRows(name, await client.get(HP_PATHS.matchups, { ...params, hero: name }));
    allies.push(...m.allies);
    enemies.push(...m.enemies);
  }
  return { data: { heroes, maps, enemies, allies, builds }, skippedMatchups };
}
