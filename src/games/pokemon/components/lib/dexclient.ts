/**
 * Browser loader for the staged dex shard (public/dex.json → /whetstone/data/pokemon/dex.<hash>.json).
 * Pages resolve the URL at build time (stagedUrl) and pass it to the island; this fetches it once
 * per page and builds the DexIndex. The pipeline already validated the file with zod, so the
 * browser only checks the shape it relies on (keeping zod out of the client bundle).
 */
import type { DexShard } from '../../schema.ts';
import { createDexIndex, type DexIndex } from './dex.ts';

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

const cache = new Map<string, Promise<DexIndex>>();

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Throws a readable error unless `raw` looks like a DexShard. */
export function assertDexShard(raw: unknown): asserts raw is DexShard {
  if (!isRecord(raw)) throw new Error('The Pokédex file is not a JSON object.');
  if (raw.schema !== 1) throw new Error(`Unsupported Pokédex file version ${String(raw.schema)}.`);
  for (const key of ['species', 'moves', 'items', 'abilities'] as const) {
    if (!Array.isArray(raw[key])) throw new Error(`The Pokédex file has no ${key} list.`);
  }
  if (!isRecord(raw.learnsets) || !isRecord(raw.typechart) || typeof raw.regulation !== 'string') {
    throw new Error('The Pokédex file is incomplete.');
  }
  const species = raw.species as unknown[];
  if (!species.every((s) => isRecord(s) && typeof s.id === 'string' && Array.isArray(s.types) && isRecord(s.base))) {
    throw new Error('The Pokédex file has malformed species.');
  }
}

/** Fetch and index the dex shard (memoized per URL; a failed load can be retried). */
export function loadDex(url: string, fetchImpl: Fetch = (u) => fetch(u)): Promise<DexIndex> {
  const hit = cache.get(url);
  if (hit) return hit;
  const promise = (async () => {
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`Could not load the Pokédex (HTTP ${res.status}).`);
    const raw = await res.json();
    assertDexShard(raw);
    return createDexIndex(raw);
  })();
  cache.set(url, promise);
  promise.catch(() => cache.delete(url));
  return promise;
}
