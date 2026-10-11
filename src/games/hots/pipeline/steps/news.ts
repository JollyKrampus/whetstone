/**
 * blizzard-news step: patch notes since PATCHES_SINCE from the news feed and article HTML,
 * merged with the game-data diffs (patches.json), and the diffs dated by the notes.
 *
 * Every patch-notes article in the window is fetched each run (about 20, 1.5 s apart): hotfixes
 * are appended to live articles without changing their feed date, so a per-record content hash
 * is what reveals them. When an article cannot be fetched its last-good records are reused;
 * when the feed itself fails, every last-good article record is reused (status 'stale'). Last-good
 * records from before the structured summaries are re-summarised first (migrateLegacyPatches), so
 * Blizzard's sentences are never carried forward.
 */
import { z } from 'zod';
import type { Diff, GameMap, Patch } from '../../schema.ts';
import { PatchesFileSchema } from '../../schema.ts';
import type { PipelineCurated } from '../curated.ts';
import { fetchArticle, fetchFeed, type FeedItem } from '../sources/blizzardNews.ts';
import type { HeroInput } from '../transform/heroes.ts';
import { buildHeroIndex, buildMapIndex, kindFromTitle, migrateLegacyPatches, parseArticle, type ParsedPatch } from '../transform/patches.ts';
import { assemblePatches, diffDates, type BuildDate } from '../transform/patchset.ts';
import { BUILD_RE, compareStrings, errorMessage, warn } from '../util.ts';
import { previousFile, selected, setFallback, setNotSelected, setOk, type RunEnv } from './common.ts';

/** Patch notes older than this are not kept (catch-up covers 2025 onwards). */
export const PATCHES_SINCE = '2025-01-01';
/** Records generated from diffs alone link to the heroes-data2 release, not to an article. */
const SILENT_URL = /^https:\/\/github\.com\/HeroesToolChest\/heroes-data2\//;

/** Last-good patches.json, with records from before the summaries re-summarised on read. */
const LastGoodPatchesSchema = z.preprocess(migrateLegacyPatches, PatchesFileSchema);

export interface NewsResult {
  patches: Patch[];
  diffs: Diff[];
}

/** Last-good article records as parser output (silent diff records are rebuilt, so dropped). */
export function reusableRecords(previous: readonly Patch[], url?: string): ParsedPatch[] {
  return previous
    .filter((p) => !SILENT_URL.test(p.url) && (url === undefined || p.url === url))
    .map((p) => {
      const { id: _id, version: _v, ...rest } = p;
      return rest;
    });
}

/** Build dates known from last-good patches and diffs, for when the releases API is down. */
export function fallbackBuildDates(patches: readonly Patch[], diffs: readonly Diff[]): BuildDate[] {
  const out = new Map<string, string>();
  for (const d of diffs) if (d.date) out.set(d.to, d.date);
  for (const p of patches) if (p.build && !out.has(p.build)) out.set(p.build, p.date);
  return [...out].filter(([b]) => BUILD_RE.test(b.replace(/_ptr$/, ''))).map(([build, date]) => ({ build, date }));
}

export async function runNews(
  env: RunEnv,
  input: { heroes: readonly HeroInput[]; maps: readonly GameMap[]; diffs: readonly Diff[]; buildDates: readonly BuildDate[]; major: string; curated: PipelineCurated },
): Promise<NewsResult> {
  const { ctx } = env;
  const previous = (await previousFile(env, 'patches.json', LastGoodPatchesSchema)) ?? [];
  const builds = input.buildDates.length > 0 ? input.buildDates : fallbackBuildDates(previous, input.diffs);
  const assemble = (parsed: readonly ParsedPatch[]): NewsResult => {
    const patches = assemblePatches(parsed, { builds, diffs: input.diffs, since: PATCHES_SINCE, fallbackMajor: input.major });
    return { patches, diffs: diffDates(input.diffs, patches, builds) };
  };

  if (!selected(env, 'blizzard-news')) {
    setNotSelected(env, 'blizzard-news');
    return assemble(reusableRecords(previous));
  }

  let items: FeedItem[];
  try {
    items = (await fetchFeed(ctx.http, PATCHES_SINCE)).filter((it) => kindFromTitle(it.title) !== null);
  } catch (err) {
    setFallback(env, 'blizzard-news', err, previous.length > 0, 'patch notes');
    return assemble(reusableRecords(previous));
  }

  const heroIndex = buildHeroIndex(input.heroes);
  const heroInfo = new Map(input.heroes.map((h) => [h.id, { name: h.name, role: h.role }]));
  const mapIndex = buildMapIndex(input.maps, input.curated.aliases.maps);
  const parsed: ParsedPatch[] = [];
  const failed: string[] = [];
  const unmatched = new Set<string>();
  const copied: string[] = [];
  // Oldest first so ids are assigned in a stable order; the feed is newest first.
  for (const item of [...items].sort((a, b) => compareStrings(a.published, b.published) || compareStrings(a.newsId, b.newsId))) {
    try {
      const html = await fetchArticle(ctx.http, item);
      parsed.push(...parseArticle(html, { url: item.url, title: item.title, published: item.published }, { heroes: heroIndex, maps: mapIndex, heroInfo, unmatched, onCopied: (t) => copied.push(t) }));
    } catch (err) {
      failed.push(`${item.title}: ${errorMessage(err)}`);
      parsed.push(...reusableRecords(previous, item.url));
    }
  }
  if (unmatched.size > 0) {
    env.issues.push(warn(`blizzard-news: hero-like headings not matched to a hero (lines skipped): ${[...unmatched].sort(compareStrings).slice(0, 10).join(', ')}`, 'blizzard-news'));
  }
  if (copied.length > 0) {
    env.issues.push(warn(`blizzard-news: ${copied.length} summary line(s) repeated the article and were replaced with a template (${copied[0]?.slice(0, 80)})`, 'blizzard-news'));
  }
  if (failed.length > 0) {
    env.issues.push(warn(`blizzard-news: ${failed.length} article(s) could not be fetched; last-good records kept (${failed[0]})`, 'blizzard-news'));
  }
  setOk(env, 'blizzard-news', `${items.length} patch-note articles since ${PATCHES_SINCE}${failed.length ? `, ${failed.length} kept from last-good` : ''}`);
  return assemble(parsed);
}
