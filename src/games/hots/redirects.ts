/**
 * Paths that only redirect to a HotS page (Node-only wrappers read data through load.ts; the
 * computations themselves are pure and exported for tests).
 *
 * - Composite members: /hots/hero/cho/ and /hots/hero/gall/ → chogall.
 * - URL-style hero aliases (hyphenated, as heroescounters.com and players write them):
 *   /hots/hero/li-ming/ → liming, /hots/hero/the-butcher/ → thebutcher.
 * - Compact map slugs (heroescounters.com strips spaces and apostrophes: /map/cursedhollow), aliases
 *   that start one (hanamura), and the compact form of multi-word aliases (lost caverns →
 *   /hots/map/lostcaverns/): /hots/map/cursedhollow/ → cursed-hollow.
 * - heroescounters.com section paths: /hots/teampicker/ → draft/, /hots/map/ → maps/,
 *   /hots/watch/live/ → live/, /hots/hero/ → the hero grid.
 *
 * Each redirect page is a noindex meta refresh with a canonical link, and astro.config.mjs keeps
 * every path from redirectPaths() out of the sitemap. A real slug always wins over an alias, and
 * an alias that would point at two targets is dropped.
 */
import { navHref } from '../registry.ts';
import { getDraftableEntities, getHeroById, getHeroes, getMapAliases, getMaps } from './load.ts';

export interface SlugRedirect {
  from: string;
  to: string;
}

const URL_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Letters and digits only: how heroescounters.com wrote multi-word names ("lostcaverns"). */
export function compactSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

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

/** Pure: hero slugs that redirect, from the draftable entities and composite members. */
export function heroRedirectsFor(
  entities: readonly { slug: string; aliases: readonly string[] }[],
  members: readonly { slug: string; composite: string }[],
): SlugRedirect[] {
  const taken = new Set(entities.map((h) => h.slug));
  const candidates: SlugRedirect[] = members.map((m) => ({ from: m.slug, to: m.composite }));
  for (const h of entities) {
    for (const alias of h.aliases) if (alias.includes('-') && URL_SLUG.test(alias)) candidates.push({ from: alias, to: h.slug });
  }
  return unique(candidates, taken);
}

/**
 * Pure: map slugs that redirect: the compact form of each map slug, aliases (6+ letters) that
 * start it, and the compact form (6+ letters) of aliases written with spaces or punctuation.
 */
export function mapRedirectsFor(maps: readonly { id: string }[], aliases: ReadonlyMap<string, readonly string[]>): SlugRedirect[] {
  const taken = new Set(maps.map((m) => m.id));
  const candidates: SlugRedirect[] = [];
  for (const m of maps) {
    const compact = m.id.replaceAll('-', '');
    candidates.push({ from: compact, to: m.id });
    for (const alias of aliases.get(m.id) ?? []) {
      if (URL_SLUG.test(alias) && alias.length >= 6 && compact.startsWith(alias.replaceAll('-', ''))) candidates.push({ from: alias, to: m.id });
      const joined = compactSlug(alias);
      if (joined !== alias && joined.length >= 6) candidates.push({ from: joined, to: m.id });
    }
  }
  return unique(candidates, taken);
}

/** Hero slugs that redirect: members of a composite, then hyphenated aliases. */
export function heroSlugRedirects(): SlugRedirect[] {
  const members = getHeroes().flatMap((h) => {
    const composite = h.memberOf ? getHeroById(h.memberOf) : undefined;
    return composite ? [{ slug: h.slug, composite: composite.slug }] : [];
  });
  return heroRedirectsFor(getDraftableEntities(), members);
}

/** Map slugs that redirect (see mapRedirectsFor). */
export function mapSlugRedirects(): SlugRedirect[] {
  return mapRedirectsFor(getMaps(), getMapAliases());
}

/**
 * heroescounters.com section paths with a Whetstone equivalent, relative to /hots/ (`to` is a
 * nav path: '' is the hero grid). /tierlist already exists under the same name.
 */
export const SECTION_REDIRECTS: readonly SlugRedirect[] = Object.freeze([
  { from: 'hero', to: '' },
  { from: 'map', to: 'maps/' },
  { from: 'teampicker', to: 'draft/' },
  { from: 'watch/live', to: 'live/' },
]);

/** Every redirect page's path under the site base, for the sitemap filter. */
export function redirectPaths(base: string): string[] {
  const b = base.replace(/\/+$/, '');
  return [
    ...heroSlugRedirects().map((r) => `${b}/hots/hero/${r.from}/`),
    ...mapSlugRedirects().map((r) => `${b}/hots/map/${r.from}/`),
    ...SECTION_REDIRECTS.map((r) => `${b}/hots/${r.from}/`),
  ];
}

const SECTION_LABEL: Readonly<Record<string, string>> = {
  '': 'Continue to the heroes',
  'maps/': 'Continue to the maps',
  'draft/': 'Continue to the draft tool',
  'live/': 'Continue to the live page',
};

/** The redirect page for one heroescounters.com section path (`from` as in SECTION_REDIRECTS). */
export function sectionRedirectResponse(from: string, site: URL | undefined): Response {
  const r = SECTION_REDIRECTS.find((x) => x.from === from);
  if (!r) throw new Error(`No section redirect for /hots/${from}/`);
  const to = navHref('hots', r.to);
  return new Response(redirectHtml(to, new URL(to, site).href, SECTION_LABEL[r.to] ?? 'Continue'), {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

/** The redirect page: an instant meta refresh plus a link, kept out of search. */
export function redirectHtml(to: string, canonical: string, label: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="dark light"><title>Redirecting…</title><meta name="robots" content="noindex"><link rel="canonical" href="${canonical}"><meta http-equiv="refresh" content="0;url=${to}"></head><body><p><a href="${to}">${label}</a></p></body></html>`;
}
