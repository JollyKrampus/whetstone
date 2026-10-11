/**
 * Heroes of the Storm data pipeline (SPEC §5, §10; docs/DATA.md). Loaded lazily by
 * pipeline/run.ts as `pipeline`.
 *
 * Layout: sources/*.ts talk to the network (through ctx.http, with fixture names for --offline),
 * transform/*.ts are pure and unit-tested, steps/*.ts run one source each with its last-good
 * fallback and status, validate.ts checks the outputs. Order:
 *
 *   builds (TACT + heroes-data2 .version.json)
 *   → heroes-data2 (heroes, models, diffs) → maps (ranked pool from curated/hots/ranked-pool.yaml)
 *   → blizzard-news (patch summaries, diff dates, major start)
 *   → theory hook (mechanics, theory.json)        → heroes-images (img/** when the set changed)
 *   → nexus-compendium (rotation) → liquipedia (pro.json A-SA, hero pages) → links
 *   → youtube (gated, class C) → twitch (disabled) → draft shard (class A) → meta + validation.
 *
 * Every output is first-party or openly licensed data plus our own analysis: there is no licensed
 * (class B) source, so the pipeline writes no stats.json and no draft-shard stats overlay.
 *
 * Every source can fail on its own: its last-good files are re-emitted from ctx.previous() and
 * its status becomes 'stale' with a warning. Only a missing heroes.json (no release and no
 * last-good copy) is an error, which makes pipeline/run.ts keep the whole game's last-good data.
 */
import type { DataPipeline, OutputFile, PipelineContext, PipelineResult } from '../../../core/game.ts';
import { HeroesFileSchema, TheorySchema, type GameMap, type Hero, type HotsMeta } from '../schema.ts';
import { loadPipelineCurated, type PipelineCurated } from './curated.ts';
import { detectBuilds, majorBuilds } from './steps/builds.ts';
import { createEnv, orderedStatuses, previousFile, setStatus, type RunEnv } from './steps/common.ts';
import { runHeroesData } from './steps/heroesData.ts';
import { runImages } from './steps/images.ts';
import { runLiquipedia } from './steps/liquipedia.ts';
import { runNews } from './steps/news.ts';
import { runRotation } from './steps/rotation.ts';
import { runYoutube } from './steps/youtube.ts';
import { runTheory, type TheoryLoader } from './theoryHook.ts';
import { buildDraftShard } from './transform/draft.ts';
import { buildLinks } from './transform/links.ts';
import { buildMaps, withCuratedPool } from './transform/maps.ts';
import { hotsCounts, majorSince } from './transform/meta.ts';
import { crossCheck, validateHots, validateMeta } from './validate.ts';
import { error, errorMessage, majorOf } from './util.ts';

export interface HotsPipelineDeps {
  /** Theory engine loader (tests inject a stub; default imports ../theory/index.ts). */
  theory?: TheoryLoader;
  /** Curated inputs (tests); default reads curated/hots/*.yaml under ctx.root. */
  curated?: PipelineCurated;
}

const SCHEMA_VERSION = 1;

function file(path: string, data: unknown, custody: OutputFile['custody'] = 'A'): OutputFile {
  return { path, data, custody };
}

function emptyResult(env: RunEnv, build: string): PipelineResult {
  return {
    meta: { game: 'hots', schema: SCHEMA_VERSION, version: { label: majorOf(build) || 'unknown', build }, sources: orderedStatuses(env), counts: {} },
    files: [],
    issues: env.issues,
  };
}

export async function runHots(ctx: PipelineContext, deps: HotsPipelineDeps = {}): Promise<PipelineResult> {
  const env = createEnv(ctx);
  let curated: PipelineCurated;
  try {
    curated = deps.curated ?? loadPipelineCurated(ctx.root);
  } catch (err) {
    env.issues.push(error(errorMessage(err)));
    return emptyResult(env, env.prevMeta?.extra.build ?? '0.0.0.0');
  }

  let builds;
  try {
    builds = await detectBuilds(env);
  } catch (err) {
    env.issues.push(error(errorMessage(err), 'tact'));
    return emptyResult(env, '0.0.0.0');
  }

  // Hero data and diffs.
  const hd = await runHeroesData(env, builds, curated);
  if (hd.heroes.length === 0) {
    env.issues.push(error('no hero records: neither heroes-data2 nor last-good heroes.json is available', 'heroes-data2'));
    return emptyResult(env, builds.live);
  }
  const major = majorOf(builds.live);

  // Maps with the curated Storm League pool; last-good maps (pool re-applied) in fallback.
  const baseMaps = hd.mapdata ? buildMaps(hd.mapdata, curated.maps, curated.rankedPool) : null;
  if (baseMaps) env.issues.push(...baseMaps.issues);
  const maps: GameMap[] = baseMaps?.maps ?? withCuratedPool(hd.previousMaps ?? [], curated.rankedPool);

  // Patch notes (+ diffs dated by them).
  const news = await runNews(env, { heroes: hd.heroes, maps, diffs: hd.diffs, buildDates: hd.buildDates, major, curated });
  const since = majorSince({
    major,
    patches: news.patches,
    buildDates: hd.buildDates,
    previous: env.prevMeta ? { major: env.prevMeta.extra.major, majorSince: env.prevMeta.extra.majorSince } : null,
    today: env.today,
  });
  // Without .version.json (heroes-data2 down or not selected) the major's builds come from last-good.
  const liveBuilds = majorBuilds(builds.versions.length > 0 ? builds.versions : (env.prevMeta?.extra.builds ?? []), builds.live);

  // Theory: mechanics for every hero record, theory.json for draftable entities.
  const prevHeroes = await previousFile(env, 'heroes.json', HeroesFileSchema);
  const prevTheory = await previousFile(env, 'theory.json', TheorySchema);
  const theory = await runTheory({
    heroes: hd.heroes,
    maps,
    root: ctx.root,
    previousHeroes: prevHeroes,
    previousTheory: prevTheory,
    ...(deps.theory ? { load: deps.theory } : {}),
  });
  env.issues.push(...theory.issues);
  const heroes: Hero[] = theory.heroes;

  // Images (only re-emitted when the pinned tag or the referenced set changed).
  const images = await runImages(env, hd.fallback ? [] : [...hd.images, ...(baseMaps?.images ?? [])], hd.dataBuild);

  const rotation = await runRotation(env, hd.heroes);
  const lp = await runLiquipedia(env, hd.heroes);
  const links = buildLinks(heroes, lp.heroPages);
  const videos = await runYoutube(env, { heroes: hd.heroes, maps, curated });
  setStatus(env, 'twitch', 'disabled', 'live streams are linked out in v0.1; no Twitch data is fetched');

  // Draft shard (class A).
  const shard = buildDraftShard({ build: builds.live, major, heroes, maps, theory: theory.theory });

  const files: OutputFile[] = [
    file('heroes.json', heroes),
    file('maps.json', maps),
    file('patches.json', news.patches),
    file('diffs.json', news.diffs),
    file('theory.json', theory.theory),
    file('links.json', links),
    file('public/draft.json', shard),
    ...images.files,
  ];
  if (rotation) files.push(file('rotation.json', rotation));
  if (lp.pro) files.push(file('pro.json', lp.pro, 'A-SA'));
  if (videos) files.push(file('videos.json', videos, 'C'));

  const counts = hotsCounts({ heroes, mapCount: maps.length, patches: news.patches, pro: lp.pro, theory: theory.theory });
  const extra: HotsMeta['extra'] = {
    build: builds.live,
    dataBuild: hd.dataBuild,
    major,
    majorSince: since,
    builds: liveBuilds,
    buildSeenAt: builds.buildSeenAt,
  };
  if (builds.ptr) extra.ptrBuild = builds.ptr;
  const assetsTag = images.tag ?? env.prevMeta?.extra.assetsTag;
  if (assetsTag) extra.assetsTag = assetsTag;
  if (builds.dataPending) extra.dataPending = true;

  env.issues.push(...crossCheck({ heroes, maps, theory: theory.theory, links, rotation }));
  env.issues.push(...validateHots({ files, offline: ctx.offline, previousCounts: env.prevMeta?.counts ?? null, counts }));

  const meta: PipelineResult['meta'] = {
    game: 'hots',
    schema: SCHEMA_VERSION,
    version: { label: major, build: builds.live, since },
    sources: orderedStatuses(env),
    counts,
    extra,
  };
  env.issues.push(...validateMeta(meta, env.nowIso));
  return { meta, files, issues: env.issues };
}

export const pipeline: DataPipeline = {
  run: (ctx) => runHots(ctx),
};

export default pipeline;
