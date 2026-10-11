/**
 * Adapters from the HotS loader's rows (load.ts) to the shared component props
 * (src/components/types.ts), so every HotS page links heroes and portraits the same way.
 * Browser-safe (type-only imports from load.ts); normally called in .astro frontmatter.
 */
import type { Reason } from '../../core/game.ts';
import type { MatchupRow } from '../../components/types.ts';
import { assetHref, navHref } from '../registry.ts';
import type { HeroMatchupRow, MapFitRow } from './load.ts';
import { withConditions } from './theory/conditions.ts';

/**
 * Reasons as the shared ReasonList shows them: a reason's `conditions` (curated matchups that
 * hold only with a talent, a Heroic or a situation) become " Only when …." at the end of its
 * text, the same wording generated theory reasons use, so no list ever shows a conditional
 * claim as part of the base kit. The field is dropped once folded in, so nothing renders it twice.
 */
export function displayReasons(reasons: readonly Reason[]): Reason[] {
  return reasons.map((r) => {
    if (!r.conditions || r.conditions.length === 0) return r;
    const { conditions, ...rest } = r;
    return { ...rest, text: withConditions({ text: r.text, conditions }) };
  });
}

/** Hero page URL (SPEC §8 /hots/hero/[slug]/). Composite entities use their own slug (chogall). */
export function heroHref(hero: { slug: string }): string {
  return navHref('hots', `hero/${hero.slug}/`);
}

/** Portrait URL from Hero.portrait ('img/heroes/….webp', staged unchanged by pipeline/stage.ts). */
export function heroPortrait(hero: { portrait: string }): string {
  return assetHref('hots', hero.portrait);
}

/**
 * MatchupList row for one loader row. `delta`/`n` come from the primary edge, so on a "weak
 * against" list the Δ is the other hero's edge over this one. Low-sample styling follows the
 * loader's gate rather than being re-derived from n.
 */
export function toMatchupRow(row: HeroMatchupRow, opts: { sourceLabel?: string } = {}): MatchupRow {
  return {
    id: row.hero.id,
    name: row.hero.name,
    href: heroHref(row.hero),
    image: heroPortrait(row.hero),
    score: row.score,
    source: row.source,
    reasons: displayReasons(row.reasons),
    lowSample: row.gate === 'grey',
    ...(row.edge.delta === undefined ? {} : { delta: row.edge.delta }),
    ...(row.edge.n === undefined ? {} : { n: row.edge.n }),
    ...(opts.sourceLabel === undefined ? {} : { sourceLabel: opts.sourceLabel }),
  };
}

/** Map page URL (SPEC §8 /hots/map/[slug]/). */
export function mapHref(map: { id: string }): string {
  return navHref('hots', `map/${map.id}/`);
}

/** Map art URL from GameMap.image (staged unchanged, like portraits). */
export function mapImage(map: { image: string }): string {
  return assetHref('hots', map.image);
}

/** Patch notes page URL (SPEC §8 /hots/patches/[id]/). */
export function patchHref(patch: { id: string }): string {
  return navHref('hots', `patches/${patch.id}/`);
}

/** MatchupList row for a hero's fit on one map (hero page "Best maps"). */
export function mapFitRow(fit: MapFitRow, opts: { image?: string | null } = {}): MatchupRow {
  const image = opts.image === undefined ? mapImage(fit.map) : opts.image;
  return {
    id: fit.map.id,
    name: fit.map.name,
    href: mapHref(fit.map),
    ...(image ? { image } : {}),
    score: fit.score,
    source: fit.source,
    reasons: displayReasons(fit.reasons),
    lowSample: fit.gate === 'grey',
    ...(fit.delta === undefined ? {} : { delta: fit.delta }),
    ...(fit.n === undefined ? {} : { n: fit.n }),
  };
}

/** MatchupList row for one hero on a map (map page "Best heroes"). */
export function heroFitRow(hero: { id: string; name: string; slug: string; portrait: string }, fit: MapFitRow): MatchupRow {
  return {
    id: hero.id,
    name: hero.name,
    href: heroHref(hero),
    image: heroPortrait(hero),
    score: fit.score,
    source: fit.source,
    reasons: displayReasons(fit.reasons),
    lowSample: fit.gate === 'grey',
    ...(fit.delta === undefined ? {} : { delta: fit.delta }),
    ...(fit.n === undefined ? {} : { n: fit.n }),
  };
}
