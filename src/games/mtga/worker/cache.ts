/**
 * IndexedDB cache for the card shards, keyed by Scryfall snapshot: a visitor downloads each
 * shard (≈0.8 MB / 2.6 MB compressed) once per daily card-data snapshot instead of on every
 * visit. Holds only public card data; one record per pool, older snapshots are replaced.
 * Every call fails soft (private mode, blocked storage, quota): the worker then just fetches.
 */
import type { Pool } from './protocol.ts';

export const DB_NAME = 'whetstone-mtga';
const STORE = 'shards';
const VERSION = 1;

export interface ShardRecord {
  pool: Pool;
  url: string;
  snapshot: string;
  text: string;
  savedAt: number;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

let opening: Promise<IDBDatabase | null> | null = null;

function open(factory: IDBFactory | undefined = globalThis.indexedDB): Promise<IDBDatabase | null> {
  if (!factory) return Promise.resolve(null);
  opening ??= new Promise<IDBDatabase | null>((resolve) => {
    try {
      const req = factory.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'pool' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
  return opening;
}

/** The cached shard text for this pool, URL and snapshot, or null. */
export async function readShard(pool: Pool, url: string, snapshot: string): Promise<string | null> {
  try {
    const db = await open();
    if (!db) return null;
    const rec = (await request(db.transaction(STORE, 'readonly').objectStore(STORE).get(pool))) as ShardRecord | undefined;
    return rec && rec.url === url && rec.snapshot === snapshot && typeof rec.text === 'string' ? rec.text : null;
  } catch {
    return null;
  }
}

/** Store a shard, replacing whatever was cached for the pool. Returns false when it could not. */
export async function writeShard(rec: ShardRecord): Promise<boolean> {
  try {
    const db = await open();
    if (!db) return false;
    await request(db.transaction(STORE, 'readwrite').objectStore(STORE).put(rec));
    return true;
  } catch {
    return false;
  }
}
