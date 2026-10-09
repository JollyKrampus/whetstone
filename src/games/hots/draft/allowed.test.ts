import { describe, expect, it } from 'vitest';
import { allowedFor } from './allowed.ts';

const ENTITIES = [
  { id: 'Wiza', slug: 'liming', members: null },
  { id: 'Mura', slug: 'muradin', members: null },
  { id: 'chogall', slug: 'chogall', members: ['CCho', 'Gall'] },
  { id: 'Zera', slug: 'zeratul', members: null },
];

describe('suggest from', () => {
  it('builds the allowed set: pool = owned ∪ favourites ∪ free, free = rotation only', () => {
    const pool = { v: 1 as const, owned: ['Wiza'], favorites: ['zeratul'] };
    const free = new Set(['CCho']);
    expect(allowedFor('all', ENTITIES, pool, free)).toBeNull();
    expect([...allowedFor('pool', ENTITIES, pool, free)!].sort()).toEqual(['Wiza', 'Zera', 'chogall']);
    expect([...allowedFor('free', ENTITIES, pool, free)!]).toEqual(['chogall']);
  });
});
