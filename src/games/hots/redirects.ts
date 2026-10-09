/**
 * Slugs that only redirect to a HotS hero or map page (Node-only: reads data through load.ts).
 *
 * - Composite members: /hots/hero/cho/ and /hots/hero/gall/ → chogall.
 * - URL-style hero aliases (hyphenated, as heroescounters.com and players write them):
 *   /hots/hero/li-ming/ → liming, /hots/hero/the-butcher/ → thebutcher.
 * - Compact map slugs (heroescounters.com strips spaces: /map/cursedhollow) and aliases that
 *   start one (hanamura): /hots/map/cursedhollow/ → cursed-hollow.
 *
 * Each redirect page is a noindex meta refresh with a canonical link (hero and map routes), and
 * astro.config.mjs keeps every path from redirectPaths() out of the sitemap. A real slug always
 * wins over an alias, and an alias that would point at two targets is dropped.
 */
import { getDraftableEntities, getHeroById, getHeroes, getMapAliases, getMaps } from './load.ts';

export interface SlugRedirect {
  from: string;
  to: string;
}

const URL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function unique(candidates: SlugRedirect[], taken: ReadonlySet<string>): SlugRedirect[] {
  const targets = new Map<string, Set<string>>();
  for (const c of candidates) {
    if (taken.has(c.from) || c.from === c.to) continue;
    const set = targets.get(c.from) ?? new Set<string>();
    set.add(c.to);
    targets.set(c.from, set);
  }
  return [...targets]
    .filter(([, to]) => to.size === 1)
    .map(([from, to]) => ({ from, to: [...to][0] as string }))
    .sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
}

/** Hero slugs that redirect: members of a composite, then hyphenated aliases. */
export function heroSlugRedirects(): SlugRedirect[] {
  const entities = getDraftableEntities();
  const taken = new Set(entities.map((h) => h.slug));
  const candidates: SlugRedirect[] = [];
  for (const h of getHeroes()) {
    if (!h.memberOf) continue;
    const composite = getHeroById(h.memberOf);
    if (composite) candidates.push({ from: h.slug, to: composite.slug });
  }
  for (const h of entities) {
    for (const alias of h.aliases) if (alias.includes('-') && URL_SLUG.test(alias)) candidates.push({ from: alias, to: h.slug });
  }
  return unique(candidates, taken);
}

/** Map slugs that redirect: the compact form (no hyphens) and aliases it starts with (6+ letters). */
export function mapSlugRedirects(): SlugRedirect[] {
  const maps = getMaps();
  const aliases = getMapAliases();
  const taken = new Set(maps.map((m) => m.id));
  const candidates: SlugRedirect[] = [];
  for (const m of maps) {
    const compact = m.id.replaceAll('-', '');
    candidates.push({ from: compact, to: m.id });
    for (const alias of aliases.get(m.id) ?? []) {
      if (URL_SLUG.test(alias) && alias.length >= 6 && compact.startsWith(alias.replaceAll('-', ''))) candidates.push({ from: alias, to: m.id });
    }
  }
  return unique(candidates, taken);
}

/** Every redirect page's path under the site base, for the sitemap filter. */
export function redirectPaths(base: string): string[] {
  const b = base.replace(/\/+$/, '');
  return [...heroSlugRedirects().map((r) => `${b}/hots/hero/${r.from}/`), ...mapSlugRedirects().map((r) => `${b}/hots/map/${r.from}/`)];
}

/** The redirect page: an instant meta refresh plus a link, kept out of search. */
export function redirectHtml(to: string, canonical: string, label: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>Redirecting…</title><meta name="robots" content="noindex"><link rel="canonical" href="${canonical}"><meta http-equiv="refresh" content="0;url=${to}"></head><body><p><a href="${to}">${label}</a></p></body></html>`;
}
