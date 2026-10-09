import { describe, expect, it, vi } from 'vitest';
import { assertDexShard, loadDex } from './dexclient.ts';
import { fixtureShard } from './testdex.ts';

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('loadDex', () => {
  it('fetches the shard once per URL and indexes it', async () => {
    const fetchImpl = vi.fn(async () => ok(fixtureShard()));
    const a = await loadDex('/dex.a.json', fetchImpl);
    const b = await loadDex('/dex.a.json', fetchImpl);
    expect(a).toBe(b);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(a.speciesById('rillaboom')?.name).toBe('Rillaboom');
    expect(a.regulation).toBe('M-C');
  });

  it('reports HTTP failures and lets the next call retry', async () => {
    const failing = vi.fn(async () => ({ ok: false, status: 404, json: async () => null }));
    await expect(loadDex('/dex.b.json', failing)).rejects.toThrow(/HTTP 404/);
    await Promise.resolve();
    const fetchImpl = vi.fn(async () => ok(fixtureShard()));
    await expect(loadDex('/dex.b.json', fetchImpl)).resolves.toBeTruthy();
  });
});

describe('assertDexShard', () => {
  it('rejects files that are not a dex shard', () => {
    expect(() => assertDexShard(null)).toThrow(/not a JSON object/);
    expect(() => assertDexShard({ schema: 2 })).toThrow(/version 2/);
    expect(() => assertDexShard({ schema: 1, species: [], moves: [], items: [] })).toThrow(/abilities/);
    expect(() => assertDexShard({ ...fixtureShard(), species: [{ id: 'x' }] })).toThrow(/malformed species/);
    expect(() => assertDexShard(fixtureShard())).not.toThrow();
  });
});
