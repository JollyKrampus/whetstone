/**
 * maps.json: heroes-data2 `mapdata` (names, preview images) × curated/hots/maps.yaml (kind,
 * profile, HP map ref) × the Storm League pool. Pure.
 *
 * Only maps with a curated profile are published (standard and ARAM). Brawls, arenas and
 * sandboxes in mapdata are hidden on purpose (critique D11); any other unknown map is reported
 * so a curator can add its profile.
 *
 * `ranked`: from Heroes Profile map-level Storm League game shares when that data exists in this
 * run (a standard map with share ≥ 1.5 % is in the pool, `rankedSource: 'stats'`), else from
 * curated/hots/ranked-pool.yaml (`rankedSource: 'curated'`).
 */
import type { ValidationIssue } from '../../../../core/game.ts';
import type { CuratedMapsFile, GameMap, RankedPoolFile } from '../../schema.ts';
import { compareStrings, kebabSlug, warn } from '../util.ts';
import { mapImagePath } from './heroes.ts';
import type { ImageRef } from './images.ts';
import type { HdpMap } from './release.ts';

/** SL pool threshold on a map's share of Storm League games (SPEC §5). */
export const RANKED_MIN_SHARE = 0.015;

/** mapdata entries that are brawls, arenas, sandboxes or event modes (never listed). */
const HIDDEN_MAP = /\b(sandbox|arena|brawl|heroic|classic|racing|party|trial grounds|checkpoint|revenge|deadman|escape from)\b/i;

export interface BuiltMaps {
  maps: GameMap[];
  /** Map preview images the published maps reference. */
  images: ImageRef[];
  issues: ValidationIssue[];
}

/** Map slug → share of SL games, from HP map-level stats (absent when HP is off). */
export type MapShares = ReadonlyMap<string, number>;

export function buildMaps(
  mapdata: Readonly<Record<string, HdpMap>>,
  curated: CuratedMapsFile,
  pool: RankedPoolFile,
  shares: MapShares | null,
): BuiltMaps {
  const issues: ValidationIssue[] = [];
  const images: ImageRef[] = [];
  const bySlug = new Map<string, { name: string; map: HdpMap }>();
  for (const [name, map] of Object.entries(mapdata)) {
    const slug = kebabSlug(name);
    if (!bySlug.has(slug)) bySlug.set(slug, { name, map });
  }
  const useStats = shares !== null && shares.size > 0;
  const maps: GameMap[] = [];
  for (const [slug, c] of Object.entries(curated.maps).sort(([a], [b]) => compareStrings(a, b))) {
    const raw = bySlug.get(slug);
    const file = raw?.map.replayPreviewImage ?? raw?.map.loadingScreenImage;
    if (!raw || !file) {
      issues.push(warn(`map ${slug} is curated but not in heroes-data2 mapdata (or has no image); skipped`, 'heroes-data2'));
      continue;
    }
    const image = mapImagePath(file);
    images.push({ out: image, file, folder: 'replaypreviews' });
    const ranked = c.kind === 'standard' && (useStats ? (shares.get(slug) ?? 0) >= RANKED_MIN_SHARE : pool.maps.includes(slug));
    const m: GameMap = {
      id: slug,
      name: c.name,
      kind: c.kind,
      ranked,
      rankedSource: useStats ? 'stats' : 'curated',
      image,
      profile: { size: c.size, lanes: c.lanes, objective: c.objective, tags: [...c.tags] },
    };
    if (c.hp) m.hp = { ...c.hp };
    maps.push(m);
  }
  for (const [slug, { name }] of [...bySlug].sort(([a], [b]) => compareStrings(a, b))) {
    if (curated.maps[slug] || HIDDEN_MAP.test(name)) continue;
    issues.push(warn(`map "${name}" (${slug}) has no profile in curated/hots/maps.yaml; not published`, 'heroes-data2'));
  }
  return { maps, images, issues };
}
