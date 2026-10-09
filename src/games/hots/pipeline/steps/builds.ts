/**
 * Build detection (SPEC §5 "Sources"): the live and PTR builds from Blizzard's TACT version
 * server, and the newest live build heroes-data2 has published (`.version.json`). Decides which
 * heroes-data2 release to read, and whether hero data is lagging the game (> 48 h ⇒ "data
 * pending", meta.extra.dataPending).
 */
import { fetchTact } from '../sources/tact.ts';
import { fetchVersionInfo, type VersionInfo } from '../sources/heroesData.ts';
import { BUILD_RE, compareBuilds, isPtrBuild, majorOf, warn } from '../util.ts';
import { selected, setFallback, setNotSelected, setOk, setStatus, type RunEnv } from './common.ts';

/** heroes-data2 may trail a live build for this long before the site says "data pending". */
export const DATA_LAG_HOURS = 48;

export interface BuildState {
  /** Live build (TACT us), or the data build when TACT is unknown. */
  live: string;
  ptr: string | null;
  /** heroes-data2 build to read hero data from (newest live build it has). */
  dataBuild: string | null;
  /** heroes-data2 `.version.json` versions (live and PTR), when known. */
  versions: string[];
  /** When this run (or an earlier one) first saw `live`. */
  buildSeenAt: string;
  dataPending: boolean;
}

/** Newest non-PTR build in a version list. */
export function newestLive(versions: readonly string[]): string | null {
  const live = versions.filter((v) => !isPtrBuild(v) && BUILD_RE.test(v)).sort(compareBuilds);
  return live[live.length - 1] ?? null;
}

/** Hours between two ISO timestamps (NaN-safe: 0). */
export function hoursSince(fromIso: string, toIso: string): number {
  const h = (Date.parse(toIso) - Date.parse(fromIso)) / 3_600_000;
  return Number.isFinite(h) ? h : 0;
}

/** Pure decision: when was `live` first seen, and is the data lagging long enough to flag? */
export function lagState(opts: {
  live: string;
  dataBuild: string | null;
  nowIso: string;
  prev: { build?: string; buildSeenAt?: string; generatedAt?: string } | null;
}): { buildSeenAt: string; dataPending: boolean; lagHours: number } {
  const p = opts.prev;
  const buildSeenAt = p && p.build === opts.live ? (p.buildSeenAt ?? p.generatedAt ?? opts.nowIso) : opts.nowIso;
  const behind = opts.dataBuild === null || compareBuilds(opts.live, opts.dataBuild) > 0;
  const lagHours = behind ? hoursSince(buildSeenAt, opts.nowIso) : 0;
  return { buildSeenAt, dataPending: behind && lagHours > DATA_LAG_HOURS, lagHours };
}

export async function detectBuilds(env: RunEnv): Promise<BuildState> {
  const { ctx } = env;
  const prevExtra = env.prevMeta?.extra ?? null;

  // heroes-data2 .version.json (status is finalised by the heroes-data2 step).
  let info: VersionInfo | null = null;
  let versionError: unknown = null;
  if (selected(env, 'heroes-data2')) {
    try {
      info = await fetchVersionInfo(ctx.http);
    } catch (err) {
      versionError = err;
    }
  }
  const dataBuild = (info ? newestLive(info.versions.includes(info.latest) ? info.versions : [...info.versions, info.latest]) : null) ?? prevExtra?.dataBuild ?? null;
  if (!info && versionError) {
    env.issues.push(warn(`heroes-data2: .version.json unavailable (${versionError instanceof Error ? versionError.message : String(versionError)}); ${dataBuild ? `reading build ${dataBuild} again` : 'no known data build'}`, 'heroes-data2'));
  }

  // TACT live and PTR builds.
  let live: string | null = null;
  let ptr: string | null = null;
  if (!selected(env, 'tact')) {
    setNotSelected(env, 'tact');
    live = prevExtra?.build ?? null;
    ptr = prevExtra?.ptrBuild ?? null;
  } else {
    try {
      const t = await fetchTact(ctx.http);
      live = t.live;
      ptr = t.ptr;
      setOk(env, 'tact', t.ptrError ? `PTR versions unavailable: ${t.ptrError}`.slice(0, 300) : undefined);
    } catch (err) {
      live = prevExtra?.build ?? null;
      ptr = prevExtra?.ptrBuild ?? null;
      setFallback(env, 'tact', err, live !== null, 'build numbers');
    }
  }
  if (live === null) {
    live = dataBuild;
    if (live) env.issues.push(warn(`tact: live build unknown; using heroes-data2 build ${live}`, 'tact'));
  }
  if (live === null) {
    // Neither source answered and there is no last-good meta: nothing to build on.
    setStatus(env, 'tact', 'failed', 'no live build known');
    throw new Error('no live build known: TACT and heroes-data2 .version.json both failed and there is no last-good meta.json');
  }
  // A heroes-data2 build newer than TACT (TACT outage) wins: data cannot be ahead of the game.
  if (dataBuild && compareBuilds(dataBuild, live) > 0) live = dataBuild;

  const lag = lagState({ live, dataBuild, nowIso: env.nowIso, prev: prevExtra ? { ...prevExtra, ...(env.prevMeta ? { generatedAt: env.prevMeta.generatedAt } : {}) } : null });
  if (lag.dataPending) {
    env.issues.push(
      warn(
        `heroes-data2 has not published live build ${live} after ${Math.round(lag.lagHours)} h; hero data stays at ${dataBuild ?? 'last-good'} (data pending)`,
        'heroes-data2',
      ),
    );
  }
  return {
    live,
    ptr,
    dataBuild,
    versions: info?.versions ?? [],
    buildSeenAt: lag.buildSeenAt,
    dataPending: lag.dataPending,
  };
}

/** Live builds of `major`, newest first, plus `live` when heroes-data2 does not list it yet. */
export function majorBuilds(versions: readonly string[], live: string): string[] {
  const major = majorOf(live);
  const set = new Set(versions.filter((v) => !isPtrBuild(v) && majorOf(v) === major));
  set.add(live);
  return [...set].sort((a, b) => compareBuilds(b, a));
}
