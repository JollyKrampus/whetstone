/**
 * Build-time (Node) prop builders for the draft and ARAM pages. They read HotS data through
 * load.ts, so only .astro frontmatter may import this module, never an island.
 */
import type { SourceRef } from '../../../../core/game.ts';
import { buildUniverse } from '../../draft/state.ts';
import { currentRotation, getDraftableEntities, getMaps } from '../../load.ts';
import type { CreditProp, MapOption, RosterHero } from './props.ts';

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

/** Standard maps for the draft: the Storm League pool first, then the rest; ARAM and brawls excluded. */
export function draftMaps(): MapOption[] {
  const maps = getMaps()
    .filter((m) => m.kind === 'standard')
    .map((m) => ({ id: m.id, name: m.name, ranked: m.ranked }));
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

/** The Heroes Profile credit the islands render inline next to its numbers. */
export function hpCredit(source: SourceRef | undefined): CreditProp {
  return {
    name: source?.name ?? 'Heroes Profile',
    url: source?.url ?? 'https://www.heroesprofile.com',
    attribution: source?.attribution ?? 'Data provided by Heroes Profile',
  };
}
