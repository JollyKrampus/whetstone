/**
 * Talent helpers for hero pages: resolve a stats build (talent ids in level order) against a
 * hero's talent tiers, and write the in-game build string `[T{7 digits},{HeroToken}]`.
 * Browser-safe and pure.
 *
 * Build string (beta, research hots-roadmap §6.4): digit i is the 1-based position of the chosen
 * talent at tiers 1/4/7/10/13/16/20, `0` for a tier left open. The hero token is Heroes
 * Profile's `build_copy_name`, which is the English name reduced to letters and digits except
 * for the quirks listed in TOKEN_OVERRIDES. The format still needs one in-game check (critique U8),
 * so the UI labels it beta.
 */
import type { Hero, Talent, TalentTier } from '../schema.ts';

export const TIERS: readonly TalentTier[] = ['1', '4', '7', '10', '13', '16', '20'];

/**
 * build_copy_name values that are not simply the alphanumeric name (keyed by attributeId):
 * Cho's builds carry the pair's token, and The Lost Vikings drop the article.
 */
const TOKEN_OVERRIDES: Readonly<Record<string, string>> = { CCho: 'Chogall', Lost: 'LostVikings' };

/** In-game hero token for build strings, e.g. "Li-Ming" -> "LiMing", "Lúcio" -> "Lucio". */
export function buildToken(hero: Pick<Hero, 'id' | 'name'>): string {
  const override = TOKEN_OVERRIDES[hero.id];
  if (override) return override;
  return hero.name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9]/g, '');
}

export interface PickedTalent extends Talent {
  tier: TalentTier;
}

export interface ResolvedBuild {
  /** The hero whose talents the build uses (a member for composites). */
  owner: Pick<Hero, 'id' | 'name' | 'talents'>;
  /** One entry per tier, null when the build leaves it open. */
  picks: (PickedTalent | null)[];
  /** `[T1234567,Hero]`, or null when a talent id is unknown. */
  code: string | null;
}

/** Where a talent id sits: tier and 1-based position. */
function locate(talents: Hero['talents'], id: string): PickedTalent | null {
  for (const tier of TIERS) {
    const hit = talents[tier].find((t) => t.id === id);
    if (hit) return { ...hit, tier };
  }
  return null;
}

/**
 * Resolve talent ids against the first candidate hero that knows all of them (the hero itself,
 * then the members of a composite). Returns null when nobody knows them, so the page can skip
 * a build it cannot explain instead of showing raw ids.
 */
export function resolveBuild(candidates: readonly Pick<Hero, 'id' | 'name' | 'talents'>[], ids: readonly string[]): ResolvedBuild | null {
  for (const owner of candidates) {
    const found = ids.map((id) => locate(owner.talents, id));
    if (found.length === 0 || found.some((f) => f === null)) continue;
    const picks: (PickedTalent | null)[] = TIERS.map((tier) => found.find((f) => f?.tier === tier) ?? null);
    // Two talents from one tier cannot be a real build.
    const valid = found.length === picks.filter(Boolean).length && picks.every((p) => !p || (p.sort >= 1 && p.sort <= 9));
    const code = valid ? `[T${picks.map((p) => (p ? String(p.sort) : '0')).join('')},${buildToken(owner)}]` : null;
    return { owner, picks, code };
  }
  return null;
}
