/**
 * YouTube uploads of curated creators → videos.json (class C, artifact only). Pure.
 *
 * - Shorts are dropped by duration (≤ SHORTS_MAX_SEC; YouTube exposes no Shorts flag).
 * - A creator's `excludeTitles` regexes drop off-topic uploads.
 * - Heroes and maps are matched in the title (then the first part of the description when the
 *   title names none) with word boundaries, longest alias first, so "Ana" never matches inside
 *   "banana" and "Li Ming" wins over "Ming". Cho and Gall resolve to the composite `chogall`.
 * - `kind` is a keyword heuristic of our own; YouTube's view counts are passed through
 *   unchanged (no derived metrics, YouTube API policy III.E.4.h).
 */
import type { CreatorsFile, Video, Videos } from '../../schema.ts';
import type { RawVideo } from '../sources/youtube.ts';
import { compareStrings, deaccent } from '../util.ts';

export const SHORTS_MAX_SEC = 180;
const DESCRIPTION_CHARS = 300;

export interface MatchTarget {
  id: string;
  names: readonly string[];
}

/** Lowercase, accents and possessives removed, punctuation to spaces (letters of any script kept). */
export function normalizeTitle(text: string): string {
  return deaccent(text)
    .replace(/(\p{L})['’]s\b/gu, '$1')
    .toLowerCase()
    .replace(/['’.`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export interface Matcher {
  match(text: string): string[];
}

/** Alias table matcher: whole-word matches, longest alias first, each span used once. */
export function createMatcher(targets: readonly MatchTarget[], minLength = 2): Matcher {
  const entries: { alias: string; id: string }[] = [];
  const owner = new Map<string, string | null>();
  for (const t of targets) {
    for (const n of t.names) {
      const alias = normalizeTitle(n);
      if (alias.length < minLength) continue;
      const prev = owner.get(alias);
      // An alias two targets share is ambiguous: drop it.
      owner.set(alias, prev === undefined || prev === t.id ? t.id : null);
    }
  }
  for (const [alias, id] of owner) if (id) entries.push({ alias, id });
  entries.sort((a, b) => b.alias.length - a.alias.length || compareStrings(a.alias, b.alias));
  return {
    match(text) {
      let hay = ` ${normalizeTitle(text)} `;
      const found = new Set<string>();
      for (const e of entries) {
        const needle = ` ${e.alias} `;
        if (!hay.includes(needle)) continue;
        found.add(e.id);
        hay = hay.split(needle).join(' | ');
      }
      return [...found].sort(compareStrings);
    },
  };
}

export function videoKind(title: string): Video['kind'] {
  const t = title.toLowerCase();
  if (/\b(guide|talents?|builds?|tips|how to|tutorial|explained|tier list|beginner)\b/.test(t)) return 'guide';
  if (/\b(patch|nerfs?|buffs?|hotfix|ptr|rework)\b/.test(t)) return 'patch';
  if (/\b(cup|clash|finals?|division|tournament|playoffs?|grand final|showmatch|league)\b|\bvs\.?\b/.test(t)) return 'tournament';
  return 'gameplay';
}

export interface VideoBuildInput {
  raw: readonly RawVideo[];
  creators: CreatorsFile;
  heroes: readonly MatchTarget[];
  maps: readonly MatchTarget[];
  fetchedAt: string;
}

export function buildVideos(input: VideoBuildInput): Videos {
  const heroMatcher = createMatcher(input.heroes);
  const mapMatcher = createMatcher(input.maps, 4);
  const byChannel = new Map(input.creators.creators.filter((c) => c.youtube).map((c) => [c.youtube?.channelId as string, c]));
  const seen = new Set<string>();
  const videos: Video[] = [];
  for (const v of input.raw) {
    const creator = byChannel.get(v.channelId);
    if (!creator || seen.has(v.id)) continue;
    if (!/^[A-Za-z0-9_-]{11}$/.test(v.id) || !/^UC[A-Za-z0-9_-]{22}$/.test(v.channelId)) continue;
    if (v.durationSec !== undefined && v.durationSec <= SHORTS_MAX_SEC) continue;
    if ((creator.excludeTitles ?? []).some((re) => new RegExp(re, 'i').test(v.title))) continue;
    seen.add(v.id);
    const desc = v.description.slice(0, DESCRIPTION_CHARS);
    let heroes = heroMatcher.match(v.title);
    if (heroes.length === 0) heroes = heroMatcher.match(desc);
    const maps = mapMatcher.match(v.title);
    const video: Video = {
      id: v.id,
      channelId: v.channelId,
      channel: v.channel || creator.name,
      title: v.title,
      published: new Date(v.published).toISOString(),
      heroes,
      maps,
      kind: videoKind(v.title),
    };
    if (v.durationSec !== undefined) video.durationSec = v.durationSec;
    if (v.views !== undefined) video.views = v.views;
    const lang = v.lang ?? (creator.lang !== 'und' ? creator.lang : undefined);
    if (lang && lang.length >= 2) video.lang = lang;
    videos.push(video);
  }
  videos.sort((a, b) => compareStrings(b.published, a.published) || compareStrings(a.id, b.id));
  return { source: 'youtube', fetchedAt: input.fetchedAt, videos };
}
