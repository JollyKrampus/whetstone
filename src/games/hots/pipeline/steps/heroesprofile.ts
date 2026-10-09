/**
 * heroesprofile step (class B, gated): Storm League statistics from the Heroes Profile v1 API,
 * only when HP_MODE=on AND HP_API_KEY is set (SPEC §1.2, §10). Never the keyless openApi.
 * Without both, the source is 'disabled'. Class-B data is fetched fresh each run and never
 * carried over: on failure there are simply no stats (status 'failed', warning).
 *
 * Window: the current major's builds; during the first 14 days of a major the previous major is
 * pooled in at weight 0.5 (SPEC §5).
 */
import { HP_PATHS, fetchWindow, type FetchWindowResult } from '../sources/heroesprofileAdapter.ts';
import { createHpClient, httpTransport, type HpClient, type HpTransport } from '../sources/heroesprofile.ts';
import type { GameMap, Stats, StatsWindow } from '../../schema.ts';
import type { HeroInput } from '../transform/heroes.ts';
import { buildStats, buildStatsWindow, mapShares, poolWindows } from '../transform/stats.ts';
import { compareBuilds, daysBetween, errorMessage, isPtrBuild, majorOf, status, warn } from '../util.ts';
import { setStatus, type RunEnv } from './common.ts';

export const POOL_DAYS = 14;
export const POOL_WEIGHT = 0.5;
/** Billable calls per run: 3 window calls + one matchup call per hero, twice while pooling. */
export const HP_CALL_BUDGET = 200;

export interface HeroesProfileResult {
  stats: Stats | null;
  /** Map slug → share of Storm League games (ranked pool), when stats exist. */
  shares: Map<string, number> | null;
}

export interface HeroesProfileDeps {
  transport?: HpTransport;
  sleep?: (ms: number) => Promise<void>;
}

export function hpGate(secrets: Readonly<Record<string, string | undefined>>, offline: boolean): string | null {
  if (secrets.HP_MODE !== 'on') return 'HP_MODE=off';
  if (!secrets.HP_API_KEY) return 'HP_API_KEY not set';
  if (offline) return 'offline run (Heroes Profile data is never recorded)';
  return null;
}

/** Live builds of a major, oldest first. */
function buildsOf(versions: readonly string[], major: string): string[] {
  return versions.filter((v) => !isPtrBuild(v) && majorOf(v) === major).sort(compareBuilds);
}

/** The previous major in a version list (e.g. 2.55 before 2.57), or null. */
export function previousMajor(versions: readonly string[], major: string): string | null {
  const majors = [...new Set(versions.filter((v) => !isPtrBuild(v)).map(majorOf))].sort((a, b) => compareBuilds(`${a}.0.0`, `${b}.0.0`));
  const i = majors.indexOf(major);
  return i > 0 ? (majors[i - 1] ?? null) : null;
}

export async function runHeroesProfile(
  env: RunEnv,
  input: { heroes: readonly HeroInput[]; maps: readonly GameMap[]; major: string; majorSince: string; versions: readonly string[]; liveBuilds: string[] },
  deps: HeroesProfileDeps = {},
): Promise<HeroesProfileResult> {
  // An injected transport (tests) never touches the network, so offline does not disable it.
  const gate = hpGate(env.ctx.secrets, env.ctx.offline && !deps.transport);
  if (gate) {
    setStatus(env, 'heroesprofile', 'disabled', gate);
    return { stats: null, shares: null };
  }
  const client: HpClient = createHpClient({
    key: env.ctx.secrets.HP_API_KEY as string,
    budget: HP_CALL_BUDGET,
    transport: deps.transport ?? httpTransport(env.ctx.http),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    log: (m) => env.ctx.log(m),
  });
  // HP names are the game's English names; Cho and Gall are separate rows.
  const heroNames = input.heroes.filter((h) => !h.members).map((h) => h.name).sort();
  try {
    const current = await fetchWindow(client, { mode: 'sl', builds: input.liveBuilds }, heroNames);
    let data = current.data;
    let pooled: StatsWindow['pooled'];
    const prevMajor = previousMajor(input.versions, input.major);
    let previous: FetchWindowResult | null = null;
    if (prevMajor && daysBetween(input.majorSince, env.today) < POOL_DAYS) {
      const prevBuilds = buildsOf(input.versions, prevMajor);
      if (prevBuilds.length > 0) {
        previous = await fetchWindow(client, { mode: 'sl', builds: prevBuilds }, heroNames);
        data = poolWindows(current.data, previous.data, POOL_WEIGHT);
        pooled = { major: prevMajor, weight: POOL_WEIGHT };
      }
    }
    const skipped = [...current.skippedMatchups, ...(previous?.skippedMatchups ?? [])];
    if (skipped.length > 0) env.issues.push(warn(`heroesprofile: call budget reached; matchups skipped for ${skipped.length} hero(es)`, 'heroesprofile'));
    const label = `Storm League, patch ${input.major}${pooled ? ` (pooled with ${pooled.major})` : ''}`;
    const { window, issues } = buildStatsWindow(data, {
      entities: input.heroes,
      maps: input.maps,
      label,
      major: input.major,
      patchBuilds: [...input.liveBuilds].sort((a, b) => compareBuilds(b, a)),
      ...(pooled ? { pooled } : {}),
    });
    env.issues.push(...issues);
    const stats = buildStats({ fetchedAt: env.nowIso, major: input.major, builds: window.patchBuilds, sl: window });
    setStatus(env, 'heroesprofile', 'ok', `${window.games} Storm League games, ${client.calls} API calls (${HP_PATHS.heroStats} …)`);
    return { stats, shares: mapShares(current.data, input.maps) };
  } catch (err) {
    env.issues.push(warn(`heroesprofile: ${errorMessage(err)}; no statistics this run`, 'heroesprofile'));
    // Class B is never carried over, so there is no last-good fetch to point at.
    env.statuses.set('heroesprofile', status('heroesprofile', 'failed', null, errorMessage(err).slice(0, 300)));
    return { stats: null, shares: null };
  }
}
