/**
 * heroes-data2 step: reads the release zip of the current data build into hero records and
 * game-data models, and computes build-to-build diffs (diffs.json).
 *
 * Diffs need the previous build's full data, so its release is downloaded too, only when the
 * data build changed (one extra zip per new build). Intermediate live builds listed in
 * `.version.json` are chained so each diff matches one patch or hotfix. On the very first run
 * (no last-good diffs) the chain starts at the last live build of the previous major, so the
 * catch-up page covers the current major from day one.
 *
 * Fallback: when the release cannot be read, last-good heroes.json / maps.json / diffs.json stay
 * (status 'stale'); with no last-good heroes at all the run fails (heroes.json is required).
 */
import type { ValidationIssue } from '../../../../core/game.ts';
import { DiffsFileSchema, HeroesFileSchema, MapsFileSchema, type Diff, type GameMap, type Hero } from '../../schema.ts';
import type { PipelineCurated } from '../curated.ts';
import { fetchRelease, fetchReleaseDates } from '../sources/heroesData.ts';
import { diffModels, lastChangedBuilds, mergeDiffs } from '../transform/diffs.ts';
import { buildHeroes, type HeroInput, type HeroModel } from '../transform/heroes.ts';
import type { ImageRef } from '../transform/images.ts';
import type { BuildDate } from '../transform/patchset.ts';
import type { HdpMap, RawRelease } from '../transform/release.ts';
import { BUILD_RE, compareBuilds, error, errorMessage, isPtrBuild, majorOf, warn } from '../util.ts';
import type { BuildState } from './builds.ts';
import { previousFile, selected, setFallback, setNotSelected, setOk, type RunEnv } from './common.ts';

/** At most this many releases are downloaded for one diff chain (each is ~9 MB). */
export const MAX_CHAIN = 6;

export interface HeroesDataResult {
  /** Hero records without mechanics, sorted by slug (members and composites). */
  heroes: HeroInput[];
  /** heroes-data2 mapdata (empty in fallback: maps then come from last-good maps.json). */
  mapdata: Record<string, HdpMap> | null;
  /** Last-good maps when mapdata is unavailable. */
  previousMaps: GameMap[] | null;
  /** Images the hero records reference. */
  images: ImageRef[];
  diffs: Diff[];
  /** heroes-data2 release dates (for patch ↔ build matching). */
  buildDates: BuildDate[];
  /** Build the hero records come from. */
  dataBuild: string;
  /** True when the records are last-good (no release read in this run). */
  fallback: boolean;
}

/**
 * Builds whose releases a diff chain needs, oldest first: from `from` through every live build
 * listed between them to `to`. Falls back to [from, to] when the list is longer than MAX_CHAIN.
 */
export function diffChain(versions: readonly string[], from: string, to: string): string[] {
  const between = versions
    .filter((v) => !isPtrBuild(v) && BUILD_RE.test(v) && compareBuilds(v, from) > 0 && compareBuilds(v, to) < 0)
    .sort(compareBuilds);
  const chain = [from, ...new Set(between), to];
  return chain.length > MAX_CHAIN ? [from, to] : chain;
}

/** First-run baseline: the newest live build of an older major, else the oldest live build listed. */
export function firstRunBaseline(versions: readonly string[], dataBuild: string): string | null {
  const live = versions.filter((v) => !isPtrBuild(v) && BUILD_RE.test(v) && compareBuilds(v, dataBuild) < 0).sort(compareBuilds);
  const major = majorOf(dataBuild);
  const older = live.filter((v) => majorOf(v) !== major);
  return older[older.length - 1] ?? live[0] ?? null;
}

/** First-run chain: baseline, then every live build of the current major up to `to`. */
export function firstRunChain(versions: readonly string[], to: string): string[] {
  const base = firstRunBaseline(versions, to);
  if (!base) return [];
  const major = majorOf(to);
  const current = versions.filter((v) => !isPtrBuild(v) && BUILD_RE.test(v) && majorOf(v) === major && compareBuilds(v, to) < 0 && compareBuilds(v, base) > 0).sort(compareBuilds);
  const chain = [base, ...new Set(current), to];
  return chain.length > MAX_CHAIN ? [base, to] : chain;
}

/** Strip mechanics from last-good records (the theory hook adds them again). */
export function toInputs(heroes: readonly Hero[]): HeroInput[] {
  return heroes.map((h) => {
    const { mechanics: _m, ...rest } = h;
    return rest;
  });
}

function modelsOf(release: RawRelease, curated: PipelineCurated, now: Date): Record<string, HeroModel> {
  return buildHeroes(release, { aliases: curated.aliases, now }).models;
}

export async function runHeroesData(env: RunEnv, builds: BuildState, curated: PipelineCurated): Promise<HeroesDataResult> {
  const { ctx } = env;
  const prevHeroes = await previousFile(env, 'heroes.json', HeroesFileSchema);
  const prevMaps = await previousFile(env, 'maps.json', MapsFileSchema);
  const prevDiffs = (await previousFile(env, 'diffs.json', DiffsFileSchema)) ?? [];
  const prevDataBuild = env.prevMeta?.extra.dataBuild ?? env.prevMeta?.extra.build ?? null;

  const lastGood = (): HeroesDataResult => ({
    heroes: toInputs(prevHeroes ?? []),
    mapdata: null,
    previousMaps: prevMaps,
    images: [],
    diffs: prevDiffs,
    buildDates: [],
    dataBuild: prevDataBuild ?? builds.live,
    fallback: true,
  });
  const fallback = (err: unknown): HeroesDataResult => {
    setFallback(env, 'heroes-data2', err, prevHeroes !== null, 'heroes.json, maps.json and diffs.json');
    if (!prevHeroes) env.issues.push(error(`heroes-data2: ${errorMessage(err)}; there is no last-good heroes.json to fall back to`, 'heroes-data2'));
    return lastGood();
  };

  if (!selected(env, 'heroes-data2')) {
    setNotSelected(env, 'heroes-data2');
    if (!prevHeroes) env.issues.push(error('heroes-data2 was not selected (--only) and there is no last-good heroes.json', 'heroes-data2'));
    return lastGood();
  }
  if (!builds.dataBuild) return fallback(new Error('no heroes-data2 build known'));

  const dataBuild = builds.dataBuild;
  let release: RawRelease;
  try {
    release = await fetchRelease(ctx.http, dataBuild, { locales: true });
  } catch (err) {
    return fallback(err);
  }
  if (release.build !== dataBuild && release.build.replace(/_ptr$/, '') !== dataBuild) {
    env.issues.push(warn(`heroes-data2: release ${dataBuild} reports build ${release.build}`, 'heroes-data2'));
  }

  const built = buildHeroes(release, { aliases: curated.aliases, now: env.now });
  env.issues.push(...built.issues);

  // Release dates are optional (patch ↔ build matching); one unauthenticated API call.
  let buildDates: BuildDate[] = [];
  try {
    buildDates = await fetchReleaseDates(ctx.http);
  } catch (err) {
    env.issues.push(warn(`heroes-data2: release dates unavailable (${errorMessage(err)}); patch notes are matched to builds less precisely`, 'heroes-data2'));
  }

  // Diffs.
  const diffIssues: ValidationIssue[] = [];
  let chain: string[] = [];
  if (prevDiffs.length > 0 && prevDataBuild && compareBuilds(dataBuild, prevDataBuild) > 0) chain = diffChain(builds.versions, prevDataBuild, dataBuild);
  else if (prevDiffs.length === 0) chain = firstRunChain(builds.versions, dataBuild);
  const models = new Map<string, Record<string, HeroModel>>([[dataBuild, built.models]]);
  for (const b of chain) {
    if (models.has(b)) continue;
    try {
      models.set(b, modelsOf(await fetchRelease(ctx.http, b, { locales: false }), curated, env.now));
    } catch (err) {
      diffIssues.push(warn(`heroes-data2: release ${b} unavailable for the diff (${errorMessage(err)}); diffing around it`, 'heroes-data2'));
    }
  }
  const usable = chain.filter((b) => models.has(b));
  const added: Diff[] = [];
  for (let i = 1; i < usable.length; i++) {
    const from = usable[i - 1] as string;
    const to = usable[i] as string;
    added.push(diffModels(from, to, models.get(from) ?? {}, models.get(to) ?? {}));
  }
  env.issues.push(...diffIssues);
  const diffs = mergeDiffs(prevDiffs, added);

  // lastChangedBuild: newest diff touching the hero; composites take their members' newest.
  const changed = lastChangedBuilds(diffs);
  const heroes = built.heroes.map((h) => ({ ...h }));
  for (const h of heroes) {
    const ids = h.members ? [...h.members] : [h.id];
    const builds = ids.map((id) => changed.get(id)).filter((b): b is string => Boolean(b)).sort(compareBuilds);
    const last = builds[builds.length - 1];
    if (last) h.lastChangedBuild = last;
    else delete h.lastChangedBuild;
  }

  setOk(env, 'heroes-data2', builds.dataPending ? `data pending: live build ${builds.live}, hero data from ${dataBuild}` : undefined);
  return { heroes, mapdata: release.maps, previousMaps: prevMaps, images: built.images, diffs, buildDates, dataBuild, fallback: false };
}
