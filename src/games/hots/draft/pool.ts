/**
 * Reader for the visitor's hero pool, shared with the hero grid (storage scope 'hots', key
 * 'pool', value `{ v: 1, owned: string[], favorites: string[] }`). The hero grid writes it; the
 * draft and ARAM tools only read it and follow changes from other tabs.
 *
 * Tolerant on purpose, because two modules write/read the same key: the value may sit inside
 * the core store envelope (`{"v":1,"d":{…}}`, src/core/storage.ts) or be stored bare, and the
 * ids may be entity ids (`Wiza`, `chogall`), member ids (`CCho`) or slugs (`liming`).
 */
import { createStore, storageKey, type StorageLike, type Store } from '../../../core/storage.ts';

export const POOL_SCOPE = 'hots' as const;
export const POOL_KEY = 'pool';
export const POOL_VERSION = 1;

export interface HeroPool {
  v: 1;
  owned: string[];
  favorites: string[];
}

export const EMPTY_POOL: Readonly<HeroPool> = Object.freeze({ v: 1, owned: [], favorites: [] });

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function idList(x: unknown): string[] | null {
  if (x === undefined) return [];
  if (!Array.isArray(x)) return null;
  return [...new Set(x.filter((s): s is string => typeof s === 'string' && s !== ''))];
}

/** Validate a stored pool value (bare or enveloped); undefined when unusable. */
export function parsePool(value: unknown): HeroPool | undefined {
  if (!isRecord(value)) return undefined;
  // Core store envelope: { v: 1, d: { … } }.
  if ('d' in value && isRecord(value.d)) return parsePool(value.d);
  if (value.v !== undefined && value.v !== POOL_VERSION) return undefined;
  const owned = idList(value.owned);
  const favorites = idList(value.favorites);
  if (owned === null || favorites === null) return undefined;
  return { v: 1, owned, favorites };
}

function rawStorage(): StorageLike | null {
  try {
    if (typeof (globalThis as { window?: unknown }).window === 'undefined') return null;
    return (globalThis as { localStorage?: StorageLike }).localStorage ?? null;
  } catch {
    return null;
  }
}

/** Read the pool; EMPTY_POOL when absent, unreadable or of another version. Never throws. */
export function readPool(storage: StorageLike | null = rawStorage()): HeroPool {
  if (!storage) return { ...EMPTY_POOL, owned: [], favorites: [] };
  try {
    const raw = storage.getItem(storageKey(POOL_SCOPE, POOL_KEY));
    if (raw === null) return { ...EMPTY_POOL, owned: [], favorites: [] };
    return parsePool(JSON.parse(raw)) ?? { ...EMPTY_POOL, owned: [], favorites: [] };
  } catch {
    return { ...EMPTY_POOL, owned: [], favorites: [] };
  }
}

/**
 * Call `listener` with the fresh pool whenever it changes (this page or another tab).
 * Returns an unsubscribe function.
 */
export function watchPool(listener: (pool: HeroPool) => void, store: Store = createStore(POOL_SCOPE)): () => void {
  return store.subscribe(POOL_KEY, () => listener(readPool()));
}

export interface PoolEntity {
  id: string;
  slug: string;
  members: readonly string[] | null;
}

/** Does the id list mention this entity (by id, slug, or any member id)? */
export function mentions(ids: ReadonlySet<string>, e: PoolEntity): boolean {
  if (ids.has(e.id) || ids.has(e.slug)) return true;
  return (e.members ?? []).some((m) => ids.has(m));
}

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
