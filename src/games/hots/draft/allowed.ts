/**
 * Which heroes the draft and ARAM tools may suggest for your own picks ("Suggest from"), based on
 * the visitor's hero pool. The pool itself (storage contract, tolerant reading, `mentions`) lives
 * in ../pool.ts, shared with the hero grid that writes it.
 */
import { mentions, type HeroPool, type PoolEntity } from '../pool.ts';

export type SuggestFrom = 'all' | 'pool' | 'free';

export const SUGGEST_FROM_LABEL: Readonly<Record<SuggestFrom, string>> = {
  all: 'All heroes',
  pool: 'My pool (owned, favourites and free)',
  free: 'Free this week only',
};

/**
 * Entity ids your own picks may be suggested from, or null for "everyone".
 * 'pool' = owned ∪ favourites ∪ this week's free rotation; 'free' = free rotation only.
 */
export function allowedFor(
  mode: SuggestFrom,
  entities: readonly PoolEntity[],
  pool: HeroPool,
  freeIds: ReadonlySet<string>,
): Set<string> | null {
  if (mode === 'all') return null;
  const mine = new Set([...pool.owned, ...pool.favorites]);
  const out = new Set<string>();
  for (const e of entities) {
    const free = mentions(freeIds, e);
    if (free || (mode === 'pool' && mentions(mine, e))) out.add(e.id);
  }
  return out;
}
