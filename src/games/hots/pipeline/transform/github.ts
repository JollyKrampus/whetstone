/**
 * GitHub / jsDelivr listings of HeroesToolChest releases and tags. Pure.
 *
 * The GitHub REST API is the primary source, but unauthenticated calls share a 60-per-hour
 * budget per IP, which GitHub-hosted runners often exhaust. The fallbacks need no API quota:
 * the repository's releases Atom feed (latest 10 releases with dates) and jsDelivr's package
 * listing (every tag, with the leading `v` removed).
 */
import type { BuildDate } from './patchset.ts';
import { BUILD_RE, decodeEntities, isRecord } from '../util.ts';

/** `v2.57.0.98348`, `2.55.17.97449_ptr`, `v2.55.16.97039_2` → the build (`_n` re-release suffix dropped). */
export function buildOfTag(tag: string): string | null {
  const build = tag.trim().replace(/^v/, '').replace(/_\d+$/, '');
  return BUILD_RE.test(build.replace(/_ptr$/, '')) ? build : null;
}

/** GitHub releases API list → build publish dates. */
export function parseReleasesApi(raw: unknown): BuildDate[] {
  if (!Array.isArray(raw)) throw new Error('GitHub releases API did not return a list');
  const out: BuildDate[] = [];
  for (const r of raw) {
    if (!isRecord(r) || typeof r.tag_name !== 'string' || typeof r.published_at !== 'string') continue;
    const build = buildOfTag(r.tag_name);
    if (build) out.push({ build, date: r.published_at.slice(0, 10) });
  }
  return out;
}

/** GitHub releases Atom feed → build publish dates (entry `updated` = publish time). */
export function parseReleasesAtom(xml: string): BuildDate[] {
  const out: BuildDate[] = [];
  for (const m of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const body = m[1] ?? '';
    const href = /<link[^>]*href="[^"]*\/releases\/tag\/([^"]+)"/.exec(body)?.[1];
    const title = /<title>([^<]*)<\/title>/.exec(body)?.[1];
    const updated = /<updated>(\d{4}-\d{2}-\d{2})T/.exec(body)?.[1];
    const build = buildOfTag(decodeEntities(decodeURIComponent(href ?? title ?? '')));
    if (build && updated) out.push({ build, date: updated });
  }
  if (out.length === 0) throw new Error('releases feed lists no build releases');
  return out;
}

/** GitHub tags API list → tag names. */
export function parseTagsApi(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new Error('GitHub tags API did not return a list');
  return raw.filter(isRecord).map((t) => t.name).filter((n): n is string => typeof n === 'string');
}

/** jsDelivr package listing → git tag names (jsDelivr drops the leading `v` of version tags). */
export function parseJsdelivrVersions(raw: unknown): string[] {
  if (!isRecord(raw) || !Array.isArray(raw.versions)) throw new Error('jsDelivr listing has no versions');
  const tags = raw.versions
    .filter(isRecord)
    .map((v) => v.version)
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((v) => (/^\d/.test(v) ? `v${v}` : v));
  if (tags.length === 0) throw new Error('jsDelivr listing has no versions');
  return tags;
}
