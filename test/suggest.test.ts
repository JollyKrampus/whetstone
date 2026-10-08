import { describe, expect, it } from 'vitest';
import { castingMv } from '../src/core/cards.js';
import { parseAndResolve } from '../src/core/deck.js';
import { getFormat } from '../src/core/formats.js';
import { buildMeta } from '../src/core/meta.js';
import { suggestUpgrades, type SuggestOptions } from '../src/core/suggest.js';
import { RARITIES } from '../src/core/types.js';
import { wildcardCost } from '../src/core/wildcards.js';
import { createServer } from '../src/server.js';
import { fixtureIndex, readFixture, testContext } from './fixture.js';
import { call, connect } from './helpers.js';

const historic = getFormat('historic');

async function setup(file: string) {
  const index = await fixtureIndex();
  const deck = await parseAndResolve(readFixture(file), index);
  const meta = await buildMeta(JSON.parse(readFixture('meta-historic.json')).decks, index);
  return { index, deck, meta };
}

describe('wildcard_cost', () => {
  it('prices each card at its cheapest Arena rarity and skips basics', async () => {
    const { deck } = await setup('standard-boros.txt');
    const r = wildcardCost(deck);
    expect(r.byRarity).toEqual({ common: 17, uncommon: 4, rare: 38, mythic: 0 });
    expect(r.total).toBe(59);
    expect(r.cards.some((c) => c.name === 'Mountain')).toBe(false);
  });

  it('caps copies at four and lists cards that are not on Arena', async () => {
    const { index } = await setup('standard-boros.txt');
    const deck = await parseAndResolve('Deck\n12 Relentless Rats\n4 Goblin Guide\n\nSideboard\n2 Relentless Rats', index);
    const r = wildcardCost(deck);
    expect(r.cards).toEqual([{ name: 'Relentless Rats', qty: 4, rarity: r.cards[0]!.rarity }]);
    expect(r.unavailable).toEqual(['Goblin Guide']);
  });
});

describe('suggest_upgrades', () => {
  it('only adds legal Arena cards in the deck colors within one mana of the cut', async () => {
    const { index, deck, meta } = await setup('tiers/t3-gruul.txt');
    const r = suggestUpgrades(deck, historic, index, { mode: 'competitive', meta, asOf: '2026-10-08' });
    expect(r.swaps.length).toBeGreaterThan(0);
    const names = new Set(deck.main.map((e) => e.name));
    for (const s of r.swaps) {
      const add = index.lookup(s.add)!;
      const cut = index.lookup(s.cut)!;
      expect(add.onArena).toBe(true);
      expect(add.legalities.historic).toBe('legal');
      expect(add.colorIdentity.every((c) => c === 'R' || c === 'G')).toBe(true);
      expect(Math.abs(castingMv(add) - castingMv(cut))).toBeLessThanOrEqual(1);
      expect(names.has(add.name)).toBe(false);
      expect(s.reason).toMatch(/\.$/);
    }
  });

  it('never exceeds the wildcard budget and reports what is left', async () => {
    const { index, deck, meta } = await setup('tiers/t4-boros-midrange.txt');
    const budgets: SuggestOptions['wildcards'][] = [
      { rare: 0, mythic: 0, uncommon: 0, common: 0 },
      { rare: 2, mythic: 0 },
      { rare: 4, mythic: 2, uncommon: 3, common: 8 },
    ];
    for (const wildcards of budgets) {
      for (const mode of ['casual', 'competitive'] as const) {
        const r = suggestUpgrades(deck, historic, index, { mode, meta, wildcards, maxSwaps: 10, asOf: '2026-10-08' });
        for (const rarity of RARITIES) {
          const limit = wildcards?.[rarity];
          if (limit !== undefined) {
            expect(r.totalCost[rarity]).toBeLessThanOrEqual(limit);
            expect(r.remaining?.[rarity]).toBe(limit - r.totalCost[rarity]);
          }
        }
      }
    }
    const none = suggestUpgrades(deck, historic, index, {
      mode: 'competitive',
      meta,
      wildcards: { rare: 0, mythic: 0, uncommon: 0, common: 0 },
      asOf: '2026-10-08',
    });
    expect(none.swaps).toEqual([]);
  });

  it('respects keepCards and maxSwaps', async () => {
    const { index, deck, meta } = await setup('tiers/t3-gruul.txt');
    const base = suggestUpgrades(deck, historic, index, { mode: 'competitive', meta, asOf: '2026-10-08' });
    const firstCut = base.swaps[0]!.cut;
    const kept = suggestUpgrades(deck, historic, index, {
      mode: 'competitive',
      meta,
      keepCards: [firstCut.toUpperCase()],
      maxSwaps: 2,
      asOf: '2026-10-08',
    });
    expect(kept.swaps.map((s) => s.cut)).not.toContain(firstCut);
    expect(kept.swaps.length).toBeLessThanOrEqual(2);
  });

  it('keeps a mostly-white deck from drifting into its splash colors', async () => {
    const { index, deck } = await setup('tiers/t2-white-weenie.txt');
    const r = suggestUpgrades(deck, historic, index, { mode: 'casual', asOf: '2026-10-08' });
    for (const s of r.swaps) expect(index.lookup(s.add)!.colorIdentity.every((c) => c === 'W')).toBe(true);
  });

  it('keeps burn that can hit players in aggro decks', async () => {
    const { index, deck } = await setup('standard-boros.txt');
    const r = suggestUpgrades(deck, getFormat('standard'), index, { mode: 'competitive', maxSwaps: 10, asOf: '2026-10-08' });
    for (const s of r.swaps.filter((x) => ['Shock', 'Burst Lightning', 'Lightning Strike'].includes(x.cut))) {
      expect(index.lookup(s.add)!.oracleText).toMatch(/any target|each opponent|target player|target opponent/);
    }
  });

  it('is deterministic', async () => {
    const { index, deck, meta } = await setup('tiers/t3-gruul.txt');
    const opts = { mode: 'casual' as const, meta, asOf: '2026-10-08', wildcards: { rare: 3 } };
    expect(suggestUpgrades(deck, historic, index, opts)).toEqual(suggestUpgrades(deck, historic, index, opts));
  });

  it('is exposed as suggest_upgrades and wildcard_cost', async () => {
    const client = await connect(createServer(testContext()));
    const text = readFixture('tiers/t3-gruul.txt');
    const s = await call(client, 'suggest_upgrades', { text, format: 'historic', mode: 'competitive', wildcards: { rare: 4, mythic: 2 } });
    expect(s.isError).toBe(false);
    expect(s.body).toMatchObject({ format: 'historic', mode: 'competitive', budget: { rare: 4, mythic: 2 } });
    const w = await call(client, 'wildcard_cost', { text });
    expect(w.body.byRarity).toBeDefined();
  });
});
