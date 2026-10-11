/**
 * Build-time (Node) prop builders for the draft and ARAM pages. They read HotS data through
 * load.ts, so only .astro frontmatter may import this module, never an island.
 */
import type { SourceRef } from '../../../../core/game.ts';
import { sourcesFor } from '../../../registry.ts';
import type { ProPrior } from '../../draft/providers.ts';
import { buildUniverse } from '../../draft/state.ts';
import { currentRotation, getDraftableEntities, getMaps, getPro, hasAsset } from '../../load.ts';
import type { CreditMap, CreditProp, MapOption, RosterHero } from './props.ts';

/** Draftable entities in universe order (release date, id), with what the islands display. */
export function draftRoster(): RosterHero[] {
  const entities = getDraftableEntities();
  const byId = new Map(entities.map((h) => [h.id, h]));
  return buildUniverse(entities.map((h) => ({ id: h.id, releaseDate: h.releaseDate }))).map((id) => {
    const h = byId.get(id)!;
    return {
      id: h.id,
      slug: h.slug,
      name: h.name,
      role: h.role,
      roleAlt: h.roleAlt ?? null,
      type: h.type,
      portrait: h.portrait,
      slots: h.members ? 2 : 1,
      members: h.members ? [...h.members] : null,
      aliases: [...h.aliases],
      isNew: h.isNew,
    };
  });
}

const byName = (a: MapOption, b: MapOption) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** Standard maps for the draft: the Storm League pool first, then the rest; ARAM and brawls excluded. Art only when staged. */
export function draftMaps(): MapOption[] {
  const maps = getMaps()
    .filter((m) => m.kind === 'standard')
    .map((m): MapOption => ({ id: m.id, name: m.name, ranked: m.ranked, ...(hasAsset(m.image) ? { image: m.image } : {}) }));
  return [...maps.filter((m) => m.ranked).sort(byName), ...maps.filter((m) => !m.ranked).sort(byName)];
}

/** ARAM maps for the ARAM helper. */
export function aramMaps(): MapOption[] {
  return getMaps()
    .filter((m) => m.kind === 'aram')
    .map((m) => ({ id: m.id, name: m.name, ranked: false }))
    .sort(byName);
}

/** Entity ids in this week's free rotation (a composite is free when any member is); none while it is stale. */
export function freeRotation(roster: readonly RosterHero[]): { ids: string[]; window: { start: string; end: string } | null } {
  const rotation = currentRotation();
  if (!rotation) return { ids: [], window: null };
  const free = new Set(rotation.heroes);
  const ids = roster.filter((h) => rotation.allFree || free.has(h.id) || (h.members ?? []).some((m) => free.has(m))).map((h) => h.id);
  return { ids, window: { start: rotation.start, end: rotation.end } };
}

const LICENSE_URLS: Readonly<Record<string, string>> = {
  'CC-BY-SA 3.0': 'https://creativecommons.org/licenses/by-sa/3.0/',
  'CC BY-SA 3.0': 'https://creativecommons.org/licenses/by-sa/3.0/',
  'CC BY 4.0': 'https://creativecommons.org/licenses/by/4.0/',
};

/** The inline credit of one SourceRef (share-alike sources also link their licence). */
export function creditOf(source: SourceRef): CreditProp {
  const credit: CreditProp = { id: source.id, name: source.name, url: source.url, attribution: source.attribution };
  const licenseUrl = source.license ? LICENSE_URLS[source.license] : undefined;
  if (source.license && licenseUrl && source.custody === 'A-SA') {
    credit.license = source.license;
    credit.licenseUrl = licenseUrl;
  }
  return credit;
}

/**
 * Credits for every HotS source, by id. The islands credit whichever source backs the numbers
 * they show (the statistics block names its own source; pro ban rates name theirs), so no
 * provider is hard-coded in the UI.
 */
export function sourceCredits(): CreditMap {
  return Object.fromEntries(sourcesFor('hots').map((s) => [s.id, creditOf(s)]));
}

/**
 * Pro ban rates for the draft's theory-mode ban prior (pro.json, class A-SA), keyed by the
 * draftable entities of the roster; null without pro data.
 */
export function proPrior(roster: readonly RosterHero[]): ProPrior | null {
  const pro = getPro();
  if (!pro || pro.totals.maps <= 0) return null;
  const known = new Set(roster.map((h) => h.id));
  const bans: Record<string, number> = {};
  for (const h of pro.heroes) if (known.has(h.hero) && h.bans > 0) bans[h.hero] = h.bans;
  const prior: ProPrior = { source: pro.attribution.source, label: pro.window.label, maps: pro.totals.maps, bans };
  if (pro.synthetic) prior.synthetic = true;
  return prior;
}
