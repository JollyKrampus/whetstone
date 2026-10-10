import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { castingMv, isLand, isMdfcLand, normalizeName, pipsOf, printedCopyLimit } from '../src/core/cards.js';
import { searchCards } from '../src/core/search.js';
import { ensureIndex } from '../src/data/bulk.js';
import { ScryfallClient } from '../src/data/scryfall.js';
import { createServer } from '../src/server.js';
import { FIXTURE_SNAPSHOT, fixtureIndex, readFixture, testContext } from './fixture.js';
import { call, connect } from './helpers.js';

const names = (r: { cards: { name: string }[] }) => r.cards.map((c) => c.name);

describe('card index', () => {
  it('aggregates printings into one record per oracle ID', async () => {
    const index = await fixtureIndex();
    expect(index.meta.snapshot).toBe(FIXTURE_SNAPSHOT);
    const bolt = index.lookup('Lightning Bolt')!;
    expect(bolt.onArena).toBe(true);
    expect(bolt.arenaIds.length).toBeGreaterThan(0);
    expect(bolt.releasedAt).toBe('1993-08-05');
    expect(index.lookup('Goblin Guide')!.onArena).toBe(false);
    expect(index.lookup('Goblin Guide')!.arenaRarity).toBeNull();
  });

  it('resolves names case-, accent- and face-insensitively', async () => {
    const index = await fixtureIndex();
    expect(index.lookup('lightning bolt')?.name).toBe('Lightning Bolt');
    expect(index.lookup('Kumano Faces Kakkazan')?.name).toBe('Kumano Faces Kakkazan // Etching of Kumano');
    expect(index.lookup('Wear/Tear')?.name).toBe('Wear // Tear');
    expect(index.lookup('Commit//Memory')?.name).toBe('Commit // Memory');
    expect(index.lookup('Brazen Borrower')?.name).toBe('Brazen Borrower // Petty Theft');
    expect(index.suggest('Lightnig Bolt')).toContain('Lightning Bolt');
  });

  it('exposes card helpers', async () => {
    const index = await fixtureIndex();
    expect(isLand(index.lookup('Sacred Foundry')!)).toBe(true);
    const flora = index.lookup('Tangled Florahedron')!;
    expect(isLand(flora)).toBe(false);
    expect(isMdfcLand(flora)).toBe(true);
    expect(castingMv(index.lookup('Bonecrusher Giant')!)).toBe(3);
    expect(printedCopyLimit(index.lookup('Seven Dwarves')!)).toBe(7);
    expect(printedCopyLimit(index.lookup('Relentless Rats')!)).toBe(Infinity);
    expect(pipsOf('{1}{W}{W}{R/G}{B/P}').hard).toMatchObject({ W: 2, U: 0, B: 0, R: 0, G: 0 });
    expect(pipsOf('{R/G}').hybrid).toEqual([['R', 'G']]);
    expect(normalizeName('  Æther Vial ')).toBe('æther vial');
  });
});

describe('search', () => {
  it('filters by type, mana value and color identity', async () => {
    const index = await fixtureIndex();
    const r = searchCards(index, 't:creature id<=r mv<=1');
    expect(names(r)).toContain('Monastery Swiftspear');
    expect(names(r)).not.toContain('Llanowar Elves');
    expect(r.cards.every((c) => c.cmc <= 1)).toBe(true);
  });

  it('supports or, parentheses, negation and quoted oracle text', async () => {
    const index = await fixtureIndex();
    const r = searchCards(index, '(t:instant or t:sorcery) o:"damage to any target" -c:w');
    expect(names(r)).toEqual(expect.arrayContaining(['Lightning Bolt', 'Shock', 'Lightning Strike']));
    expect(names(r)).not.toContain('Lightning Helix');
  });

  it('supports exact names, legality, game:arena and rarity', async () => {
    const index = await fixtureIndex();
    expect(names(searchCards(index, '!"Shock"'))).toEqual(['Shock']);
    expect(names(searchCards(index, 'banned:standard'))).toContain('Heartfire Hero');
    expect(names(searchCards(index, 'goblin game:arena'))).not.toContain('Goblin Guide');
    expect(searchCards(index, 'r:mythic').cards.every((c) => (c.arenaRarity ?? c.rarity) === 'mythic')).toBe(true);
    const std = searchCards(index, 't:creature', { format: 'standard' });
    expect(names(std)).not.toContain('Heartfire Hero');
    expect(names(std)).toContain('Voice of Victory');
  });

  it('rejects unknown keys and Alchemy', async () => {
    const index = await fixtureIndex();
    expect(() => searchCards(index, 'foo:bar')).toThrow('bad_query');
    expect(() => searchCards(index, 'f:alchemy')).toThrow('unsupported_format');
  });

  it('is exposed as the search_cards tool', async () => {
    const client = await connect(createServer(testContext()));
    const ok = await call(client, 'search_cards', { query: 'krenko', format: 'standard' });
    expect(ok.isError).toBe(false);
    expect(ok.body).toMatchObject({ snapshot: FIXTURE_SNAPSHOT, total: 1 });
    const bad = await call(client, 'search_cards', { query: 'zzz:1' });
    expect(bad.isError).toBe(true);
    expect(bad.body.error).toBe('bad_query');
  });
});

describe('scryfall client', () => {
  it('sends the required headers and spaces out search calls', async () => {
    const seen: { url: string; headers: Record<string, string>; at: number }[] = [];
    let clock = 0;
    const client = new ScryfallClient({
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      fetch: async (url, init) => {
        seen.push({ url, headers: init?.headers as Record<string, string>, at: clock });
        return new Response(JSON.stringify({ object: 'card', name: 'Shock' }), { status: 200 });
      },
    });
    await client.getJson('/cards/named?exact=Shock');
    await client.getJson('/cards/named?exact=Shock');
    expect(seen[0]!.headers['User-Agent']).toMatch(/^grindstone-mcp\//);
    expect(seen[0]!.headers.Accept).toBe('application/json');
    expect(seen[1]!.at - seen[0]!.at).toBeGreaterThanOrEqual(500);
  });

  it('backs off for the 30-second lockout after a 429, then retries once', async () => {
    let clock = 0;
    let calls = 0;
    const client = new ScryfallClient({
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      fetch: async () => {
        calls++;
        if (calls === 1) return new Response('{}', { status: 429 });
        return new Response(JSON.stringify({ object: 'list' }), { status: 200 });
      },
    });
    await client.getJson('/sets');
    expect(calls).toBe(2);
    expect(clock).toBeGreaterThanOrEqual(30_000);
  });
});

describe('ensureIndex', () => {
  it('downloads the gzipped JSONL bulk file and builds the SQLite index', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'grindstone-bulk-'));
    const gz = zlib.gzipSync(readFixture('cards.jsonl'));
    const requested: string[] = [];
    const client = new ScryfallClient({
      sleep: async () => {},
      fetch: async (url) => {
        requested.push(url);
        if (url.endsWith('/bulk-data/default_cards')) {
          return Response.json({
            object: 'bulk_data',
            type: 'default_cards',
            updated_at: '2026-10-08T09:05:44.946+00:00',
            jsonl_download_uri: 'https://data.scryfall.io/default-cards/default-cards-x.jsonl.gz',
          });
        }
        return new Response(gz, { status: 200 });
      },
    });
    const index = await ensureIndex({ client, dir });
    expect(index.meta.snapshot).toBe('2026-10-08T09:05:44.946+00:00');
    expect(index.lookup('Shock')).toBeDefined();
    // A second call inside the refresh window uses the cache without touching the network.
    const again = await ensureIndex({ client, dir });
    expect(again.records.length).toBe(index.records.length);
    expect(requested).toHaveLength(2);
  });
});
