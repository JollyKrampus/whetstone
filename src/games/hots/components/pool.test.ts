import { describe, expect, it } from 'vitest';
import { createStore, storageKey, type StorageLike } from '../../../core/storage.ts';
import {
  EMPTY_POOL,
  hasOwnedList,
  isOwned,
  POOL_KEY,
  readPool,
  setFavorite,
  setOwned,
  subscribePool,
  validatePool,
  withOwned,
  writePool,
  type HeroPool,
} from './pool.ts';

function memoryStorage(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function store(storage = memoryStorage()) {
  return { storage, store: createStore('hots', { storage, events: null }) };
}

describe('hero pool contract', () => {
  it('lives under whetstone:hots:pool, wrapped in the store envelope, with sorted unique ids', () => {
    const { storage, store: s } = store();
    expect(storageKey('hots', POOL_KEY)).toBe('whetstone:hots:pool');
    expect(writePool({ v: 1, owned: ['Tra0', 'Abat', 'Abat'], favorites: ['chogall'] }, s)).toBe(true);
    const raw = JSON.parse(storage.data.get('whetstone:hots:pool') ?? 'null');
    expect(raw).toEqual({ v: 1, d: { v: 1, owned: ['Abat', 'Tra0'], favorites: ['chogall'] } });
    expect(readPool(s)).toEqual({ v: 1, owned: ['Abat', 'Tra0'], favorites: ['chogall'] });
  });

  it('reads missing, malformed or future-version values as the empty pool', () => {
    const { storage, store: s } = store();
    expect(readPool(s)).toEqual(EMPTY_POOL);
    for (const bad of ['not json', '{"v":1,"d":{"v":2,"owned":[],"favorites":[]}}', '{"v":1,"d":{"v":1,"owned":"Abat"}}', '{"v":1,"d":[1,2]}']) {
      storage.data.set('whetstone:hots:pool', bad);
      expect(readPool(s), bad).toEqual(EMPTY_POOL);
    }
  });

  it('drops ids that are not entity-shaped but keeps unknown heroes', () => {
    expect(validatePool({ v: 1, owned: ['Abat', '<script>', 42, 'Gone'], favorites: [] })).toEqual({ v: 1, owned: ['Abat', 'Gone'], favorites: [] });
    expect(validatePool({ v: 1 })).toEqual({ v: 1, owned: [], favorites: [] });
    expect(validatePool(null)).toBeUndefined();
  });

  it('treats an empty owned list as "not set up": every hero counts as available', () => {
    const empty: HeroPool = { v: 1, owned: [], favorites: [] };
    expect(hasOwnedList(empty)).toBe(false);
    expect(isOwned(empty, 'Abat')).toBe(true);
    const some = setOwned(empty, 'Tra0', true);
    expect(hasOwnedList(some)).toBe(true);
    expect(isOwned(some, 'Tra0')).toBe(true);
    expect(isOwned(some, 'Abat')).toBe(false);
  });

  it('toggles owned and favourite ids without mutating the input', () => {
    const start: HeroPool = { v: 1, owned: ['Abat'], favorites: [] };
    const next = setFavorite(setOwned(start, 'Abat', false), 'Valla', true);
    expect(start).toEqual({ v: 1, owned: ['Abat'], favorites: [] });
    expect(next).toEqual({ v: 1, owned: [], favorites: ['Valla'] });
    expect(withOwned(next, ['Zera', 'Abat', 'Zera']).owned).toEqual(['Abat', 'Zera']);
  });

  it('notifies subscribers with the cleaned pool', () => {
    const { store: s } = store();
    const seen: HeroPool[] = [];
    const stop = subscribePool((p) => seen.push(p), s);
    writePool({ v: 1, owned: ['Tra0'], favorites: [] }, s);
    stop();
    writePool({ v: 1, owned: [], favorites: [] }, s);
    expect(seen).toEqual([{ v: 1, owned: ['Tra0'], favorites: [] }]);
  });
});
