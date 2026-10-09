/**
 * The visitor's HotS hero pool, shared by the hero grid (/hots/) and the draft tool.
 *
 * Storage contract (keep it stable; both pages read and write it):
 *   key    storageKey('hots', 'pool')  ->  "whetstone:hots:pool"   (src/core/storage.ts)
 *   value  { v: 1, owned: string[], favorites: string[] }
 *          ids are draftable entity ids (attributeIds, plus composites such as `chogall`),
 *          deduplicated and sorted so the stored string is deterministic.
 *   owned  empty = "not set up yet": treat every hero as available, never as "owns nothing".
 * The store wraps the value in its own envelope ({ v: 1, d: value }); readers must go through
 * createStore('hots'), never parse localStorage by hand. Unknown or malformed values read as the
 * empty pool. Unknown ids (a hero removed from the game) are kept, so a stale page never wipes
 * someone's pool; callers simply ignore ids they don't render.
 *
 * Browser-safe and DOM-free; every function takes an optional Store so tests can inject one.
 */
import { createStore, type Store, type StoreOptions } from '../../../core/storage.ts';

export const POOL_KEY = 'pool';
export const POOL_VERSION = 1;

export interface HeroPool {
  v: typeof POOL_VERSION;
  owned: string[];
  favorites: string[];
}

export const EMPTY_POOL: Readonly<HeroPool> = Object.freeze({ v: POOL_VERSION, owned: [], favorites: [] });

const ID = /^[A-Za-z0-9]{1,32}$/;

function cleanIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((x): x is string => typeof x === 'string' && ID.test(x));
  return [...new Set(ids)].sort();
}

/** Validator for Store.get: a well-formed pool (ids cleaned), or undefined. */
export function validatePool(value: unknown): HeroPool | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Partial<Record<keyof HeroPool, unknown>>;
  if (v.v !== POOL_VERSION) return undefined;
  const owned = cleanIds(v.owned ?? []);
  const favorites = cleanIds(v.favorites ?? []);
  if (!owned || !favorites) return undefined;
  return { v: POOL_VERSION, owned, favorites };
}

/** The 'hots' store (localStorage when usable, memory otherwise). */
export function poolStore(opts?: StoreOptions): Store {
  return createStore('hots', opts);
}

export function readPool(store: Store = poolStore()): HeroPool {
  const pool = store.get<HeroPool | null>(POOL_KEY, null, (v) => validatePool(v) ?? null);
  return pool ?? { ...EMPTY_POOL, owned: [], favorites: [] };
}

/** Persists the pool (normalized); true when it reached persistent storage. */
export function writePool(pool: HeroPool, store: Store = poolStore()): boolean {
  const clean = validatePool(pool) ?? { v: POOL_VERSION, owned: [], favorites: [] };
  return store.set(POOL_KEY, clean);
}

/** Calls `listener` with the new pool whenever it changes here or in another tab. */
export function subscribePool(listener: (pool: HeroPool) => void, store: Store = poolStore()): () => void {
  return store.subscribe(POOL_KEY, (value) => listener(validatePool(value) ?? { v: POOL_VERSION, owned: [], favorites: [] }));
}

/** True once the visitor has marked at least one owned hero. */
export function hasOwnedList(pool: HeroPool): boolean {
  return pool.owned.length > 0;
}

/** Whether a hero counts as available: owned, or no owned list set up yet. */
export function isOwned(pool: HeroPool, id: string): boolean {
  return !hasOwnedList(pool) || pool.owned.includes(id);
}

function toggleIn(list: readonly string[], id: string, on: boolean): string[] {
  const set = new Set(list);
  if (on) set.add(id);
  else set.delete(id);
  return [...set].sort();
}

export function setOwned(pool: HeroPool, id: string, owned: boolean): HeroPool {
  return { ...pool, owned: toggleIn(pool.owned, id, owned) };
}

export function setFavorite(pool: HeroPool, id: string, favorite: boolean): HeroPool {
  return { ...pool, favorites: toggleIn(pool.favorites, id, favorite) };
}

/** Replace the owned list (e.g. "select all", "clear"). */
export function withOwned(pool: HeroPool, ids: readonly string[]): HeroPool {
  return { ...pool, owned: cleanIds([...ids]) ?? [] };
}
