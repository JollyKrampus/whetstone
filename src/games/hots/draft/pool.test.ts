import { describe, expect, it } from 'vitest';
import { memoryStorage } from '../../../core/storage.ts';
import { allowedFor, mentions, parsePool, readPool } from './pool.ts';

const KEY = 'whetstone:hots:pool';
const ENTITIES = [
  { id: 'Wiza', slug: 'liming', members: null },
  { id: 'Mura', slug: 'muradin', members: null },
  { id: 'chogall', slug: 'chogall', members: ['CCho', 'Gall'] },
  { id: 'Zera', slug: 'zeratul', members: null },
];

describe('pool contract', () => {
  it('reads the core-store envelope and the bare value', () => {
    const pool = { v: 1, owned: ['Wiza'], favorites: ['Mura'] };
    expect(readPool(memoryStorage({ [KEY]: JSON.stringify({ v: 1, d: pool }) }))).toEqual(pool);
    expect(readPool(memoryStorage({ [KEY]: JSON.stringify(pool) }))).toEqual(pool);
    expect(readPool(memoryStorage({ [KEY]: JSON.stringify({ v: 1, d: { owned: ['Wiza'] } }) }))).toEqual({ v: 1, owned: ['Wiza'], favorites: [] });
  });

  it('falls back to an empty pool on anything else', () => {
    const empty = { v: 1, owned: [], favorites: [] };
    expect(readPool(memoryStorage())).toEqual(empty);
    expect(readPool(memoryStorage({ [KEY]: '{oops' }))).toEqual(empty);
    expect(readPool(memoryStorage({ [KEY]: JSON.stringify({ v: 2, owned: ['Wiza'], favorites: [] }) }))).toEqual(empty);
    expect(readPool(null)).toEqual(empty);
    expect(parsePool({ owned: 'Wiza' })).toBeUndefined();
    expect(parsePool({ owned: ['Wiza', 'Wiza', 3, ''], favorites: [] })).toEqual({ v: 1, owned: ['Wiza'], favorites: [] });
  });

  it('matches entities by id, slug or member id', () => {
    expect(mentions(new Set(['liming']), ENTITIES[0]!)).toBe(true);
    expect(mentions(new Set(['Gall']), ENTITIES[2]!)).toBe(true);
    expect(mentions(new Set(['Zera']), ENTITIES[1]!)).toBe(false);
  });

  it('builds the allowed set: pool = owned ∪ favourites ∪ free, free = rotation only', () => {
    const pool = { v: 1 as const, owned: ['Wiza'], favorites: ['zeratul'] };
    const free = new Set(['CCho']);
    expect(allowedFor('all', ENTITIES, pool, free)).toBeNull();
    expect([...allowedFor('pool', ENTITIES, pool, free)!].sort()).toEqual(['Wiza', 'Zera', 'chogall']);
    expect([...allowedFor('free', ENTITIES, pool, free)!]).toEqual(['chogall']);
  });
});
