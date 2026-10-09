/**
 * The visitor's HotS hero pool: the single source of truth for the hero grid (/hots/, which
 * writes it) and the draft and ARAM tools (which read it and follow changes).
 *
 * Storage contract (keep it stable):
 *   key    storageKey('hots', 'pool')  ->  "whetstone:hots:pool"   (src/core/storage.ts)
 *   value  { v: 1, owned: string[], favorites: string[] }, written inside the store's own
 *          envelope ({ v: 1, d: value }); ids deduplicated and sorted so the string is stable.
 *   owned  empty = "not set up yet": treat every hero as available, never as "owns nothing".
 *
 * Reading is tolerant on purpose, so a stale page or an older writer never wipes someone's pool:
 * the value may sit in the envelope or be stored bare, `v` may be missing, and ids may be entity
 * ids (`Wiza`, `chogall`), member ids (`CCho`) or slugs (`liming`); `mentions` matches any of them
 * against an entity. Unknown ids (a hero removed from the game) are kept. Anything malformed reads
 * as the empty pool.
 *
 * Browser-safe and DOM-free; every function takes an optional Store so tests can inject one.
 */
import { createStore, type Store, type StoreOptions } from '../../core/storage.ts';

export const POOL_SCOPE = 'hots' as const;
export const POOL_KEY = 'pool';
export const POOL_VERSION = 1;

export interface HeroPool {
  v: typeof POOL_VERSION;
  owned: string[];
  favorites: string[];
}

export const EMPTY_POOL: Readonly<HeroPool> = Object.freeze({ v: POOL_VERSION, owned: [], favorites: [] });

const emptyPool = (): HeroPool => ({ v: POOL_VERSION, owned: [], favorites: [] });

/** Entity ids, member ids and slugs are short ASCII alphanumerics. */
const ID = /^[A-Za-z0-9]{1,32}$/;

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

function cleanIds(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((x): x is string => typeof x === 'string' && ID.test(x));
  return [...new Set(ids)].sort();
}

/** A well-formed pool (ids cleaned) from a stored value, bare or enveloped; undefined when unusable. */
export function parsePool(value: unknown): HeroPool | undefined {
  if (!isRecord(value)) return undefined;
  // A store envelope ({ v: 1, d: { … } }) read without unwrapping.
  if ('d' in value && isRecord(value.d)) return parsePool(value.d);
  if (value.v !== undefined && value.v !== POOL_VERSION) return undefined;
  const owned = cleanIds(value.owned);
  const favorites = cleanIds(value.favorites);
  if (!owned || !favorites) return undefined;
  return { v: POOL_VERSION, owned, favorites };
}

/** The 'hots' store (localStorage when usable, memory otherwise). */
export function poolStore(opts?: StoreOptions): Store {
  return createStore(POOL_SCOPE, opts);
}

/** The pool; the empty pool when absent, unreadable or of another version. Never throws. */
export function readPool(store: Store = poolStore()): HeroPool {
  const pool = store.get<HeroPool | null>(POOL_KEY, null, (v) => parsePool(v) ?? null);
  if (pool) return pool;
  // Not in the envelope: accept a bare value too.
  try {
    const raw = store.raw(POOL_KEY);
    return (raw === null ? undefined : parsePool(JSON.parse(raw))) ?? emptyPool();
  } catch {
    return emptyPool();
  }
}

/** Persists the pool (normalized); true when it reached persistent storage. */
export function writePool(pool: HeroPool, store: Store = poolStore()): boolean {
  return store.set(POOL_KEY, parsePool(pool) ?? emptyPool());
}

/** Calls `listener` with the fresh pool whenever it changes here or in another tab. */
export function subscribePool(listener: (pool: HeroPool) => void, store: Store = poolStore()): () => void {
  return store.subscribe(POOL_KEY, () => listener(readPool(store)));
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

/** The parts of a draftable entity a pool id may name. */
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
