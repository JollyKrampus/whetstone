import { describe, expect, it } from 'vitest';
import { analyzeDeck } from '../src/core/analyze.js';
import { castingMv, frontTypeLine, isBasicLand, wildcardRarity } from '../src/core/cards.js';
import { parseAndResolve } from '../src/core/deck.js';
import { getFormat } from '../src/core/formats.js';
import { buildMeta } from '../src/core/meta.js';
import { heuristicQuality } from '../src/core/power.js';
import { constructedRubric } from '../src/core/rubric.js';
import { NO_META_MARGIN, suggestUpgrades, type SuggestOptions } from '../src/core/suggest.js';
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

  it('caps how much of the deck changes by intensity', async () => {
    const { index, deck, meta } = await setup('tiers/t2-white-weenie.txt');
    const limits = { light: 4, normal: 9, heavy: 18 } as const;
    for (const intensity of ['light', 'normal', 'heavy'] as const) {
      const r = suggestUpgrades(deck, historic, index, { mode: 'competitive', meta, maxSwaps: 20, intensity, asOf: '2026-10-08' });
      const changed = r.swaps.reduce((n, s) => n + s.qty, 0);
      expect(r.changes).toMatchObject({ cards: changed, limit: limits[intensity], deckSize: 60, intensity });
      expect(changed).toBeLessThanOrEqual(limits[intensity]);
    }
    const custom = suggestUpgrades(deck, historic, index, { mode: 'competitive', meta, maxChangePercent: 2, asOf: '2026-10-08' });
    expect(custom.changes.limit).toBe(1);
    expect(custom.swaps.reduce((n, s) => n + s.qty, 0)).toBeLessThanOrEqual(1);
  });

  it("only adds cards that support the Brawl commander's theme", async () => {
    const { index, deck } = await setup('standardbrawl-krenko.txt');
    const r = suggestUpgrades(deck, getFormat('brawl'), index, { mode: 'casual', maxSwaps: 10, intensity: 'heavy', asOf: '2026-10-08' });
    expect(r.commanderThemes).toMatchObject({ commander: 'Krenko, Mob Boss', tribes: ['Goblin'] });
    expect(r.commanderThemes!.themes).toContain('tokens');
    expect(r.swaps.length).toBeGreaterThan(0);
    for (const s of r.swaps) {
      const add = index.lookup(s.add)!;
      expect(/Goblin/.test(add.typeLine) || /create[^.]*token/i.test(add.oracleText)).toBe(true);
      expect(s.reason).toMatch(/Krenko, Mob Boss's/);
      expect(s.qty).toBe(1);
    }
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

describe('suggest_upgrades guardrails (no downgrades)', () => {
  const RANK = { common: 0, uncommon: 1, rare: 2, mythic: 3 } as const;
  const DECKS = [
    ['tiers/t5-mono-red.txt', 'standard'],
    ['standard-boros.txt', 'standard'],
    ['timeless-rakdos.txt', 'timeless'],
    ['tiers/t3-gruul.txt', 'historic'],
  ] as const;
  const RUNS: SuggestOptions[] = [
    { mode: 'casual', asOf: '2026-10-08', maxSwaps: 20, intensity: 'heavy' },
    { mode: 'competitive', asOf: '2026-10-08', maxSwaps: 20, intensity: 'heavy' },
    { profile: 'faithful', asOf: '2026-10-08' },
    { profile: 'competitive', asOf: '2026-10-08' },
    { profile: 'casual', asOf: '2026-10-08' },
    { profile: 'casual', preferPremium: true, asOf: '2026-10-08' },
  ];

  async function* everyRun() {
    const index = await fixtureIndex();
    for (const [file, format] of DECKS) {
      const deck = await parseAndResolve(readFixture(file), index);
      const fmt = getFormat(format);
      const avgMv = analyzeDeck(deck, fmt).averageManaValue;
      for (const opts of RUNS) {
        const r = suggestUpgrades(deck, fmt, index, opts);
        for (const s of r.swaps) {
          yield { file, opts, avgMv, s, cut: index.byOracle.get(s.cutOracleId)!, add: index.byOracle.get(s.addOracleId)! };
        }
      }
    }
  }

  it('never raises the mana value of an optional swap in a low-curve deck', async () => {
    let checked = 0;
    for await (const { avgMv, s, cut, add } of everyRun()) {
      if (s.required || s.kind === 'land' || avgMv > 2.4) continue;
      expect(castingMv(add), `${s.cut} → ${s.add}`).toBeLessThanOrEqual(castingMv(cut));
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('never trades an instant for a sorcery-speed card', async () => {
    for await (const { s, cut, add } of everyRun()) {
      if (s.required || !/\bInstant\b/.test(frontTypeLine(cut))) continue;
      expect(/\bInstant\b/.test(frontTypeLine(add)) || add.keywords.includes('Flash'), `${s.cut} → ${s.add}`).toBe(true);
    }
  });

  it('never spends a rarer wildcard in budget-minded (casual) play', async () => {
    for await (const { opts, s, cut, add } of everyRun()) {
      const casual = opts.mode === 'casual' || opts.profile === 'casual';
      if (!casual || opts.preferPremium || s.required) continue;
      const rarity = (c: typeof cut) => (isBasicLand(c) ? 'common' : wildcardRarity(c));
      expect(RANK[rarity(add)], `${s.cut} → ${s.add}`).toBeLessThanOrEqual(RANK[rarity(cut)]);
    }
  });

  it('only calls a card more widely played when it is', async () => {
    for await (const { s, cut, add } of everyRun()) {
      if (!/more widely played/.test(s.reason)) continue;
      expect(add.edhrecRank, s.reason).not.toBeNull();
      if (cut.edhrecRank !== null) expect(add.edhrecRank!, s.reason).toBeLessThan(cut.edhrecRank);
    }
  });

  it('needs a clear margin on the estimate when there are no meta lists', async () => {
    const h = constructedRubric().cardQuality.heuristic;
    for await (const { opts, s, cut, add } of everyRun()) {
      // Competitive scoring without meta lists is the plain estimate (no rarity cost penalty).
      const competitive = opts.mode === 'competitive' || opts.profile === 'competitive' || opts.profile === 'faithful';
      if (!competitive || s.required || s.kind === 'land') continue;
      if (opts.profile === 'faithful' && castingMv(add) < castingMv(cut)) {
        // "Same deck, best cards": the same job for less mana is the upgrade, and the reason says so.
        expect(s.reason).toMatch(/lower cost is the upgrade/);
        continue;
      }
      const margin = heuristicQuality(add, h, '2026-10-08') - heuristicQuality(cut, h, '2026-10-08');
      expect(margin, `${s.cut} → ${s.add}`).toBeGreaterThanOrEqual(NO_META_MARGIN - 1e-9);
      expect(s.reason).toMatch(/estimated without meta lists, low confidence/);
    }
  });

  it('does not suggest the reported downgrades for a Rakdos deck', async () => {
    const index = await fixtureIndex();
    const deck = await parseAndResolve(readFixture('timeless-rakdos.txt'), index);
    for (const opts of RUNS) {
      const r = suggestUpgrades(deck, getFormat('timeless'), index, opts);
      const pairs = r.swaps.map((s) => `${s.cut} → ${s.add}`);
      expect(pairs).not.toContain('Fatal Push → Feed the Swarm');
      expect(pairs).not.toContain("Kolaghan's Command → Fell the Profane // Fell Mire");
    }
  });
});
