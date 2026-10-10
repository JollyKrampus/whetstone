import { describe, expect, it } from 'vitest';
import { parseAndResolve } from '../src/core/deck.js';
import { getFormat } from '../src/core/formats.js';
import { ratePower } from '../src/core/power.js';
import { parseRecommendations, recommendationScore } from '../src/core/recs.js';
import { suggestUpgrades } from '../src/core/suggest.js';
import { createServer } from '../src/server.js';
import { fixtureIndex, readFixture, testContext } from './fixture.js';
import { call, connect } from './helpers.js';

const brawl = getFormat('brawl');

async function setup() {
  const index = await fixtureIndex();
  const deck = await parseAndResolve(readFixture('standardbrawl-krenko.txt'), index);
  const recs = parseRecommendations(readFixture('recs-paste-krenko.txt'), index, { commander: 'Krenko, Mob Boss' });
  return { index, deck, recs };
}

describe('pasted recommendations', () => {
  it('picks card names and their inclusion/synergy out of page text', async () => {
    const { index, recs } = await setup();
    const warboss = recs.cards.get(index.lookup('Legion Warboss')!.oracleId)!;
    expect(warboss).toMatchObject({ name: 'Legion Warboss', inclusion: 0.61, synergy: 0.44 });
    expect(recs.cards.get(index.lookup('Skirk Prospector')!.oracleId)?.inclusion).toBeUndefined();
    expect(recs.cards.has(index.lookup('Dragon Fodder')!.oracleId)).toBe(true);
    expect(recs.cards.size).toBe(8); // Krenko himself, 5 with stats, Skirk Prospector, Dragon Fodder
    expect(recs.ignoredLines).toBeGreaterThanOrEqual(6); // headings and prose
  });

  it('also reads a plain or Arena-style list', async () => {
    const { index } = await setup();
    const recs = parseRecommendations('1 Legion Warboss\n1x Battle Cry Goblin (M19) 129\nImpact Tremors', index);
    expect([...recs.cards.values()].map((r) => r.name)).toEqual(['Legion Warboss', 'Battle Cry Goblin', 'Impact Tremors']);
    const first = recommendationScore(recs, index.lookup('Legion Warboss')!);
    const last = recommendationScore(recs, index.lookup('Impact Tremors')!);
    expect(first).toBeGreaterThan(last);
    expect(recommendationScore(recs, index.lookup('Shock')!)).toBe(0);
  });

  it('steers Brawl suggestions toward recommended cards and says so', async () => {
    const { index, deck, recs } = await setup();
    const r = suggestUpgrades(deck, brawl, index, { mode: 'casual', recommendations: recs, intensity: 'heavy', asOf: '2026-10-08' });
    expect(r.swaps.length).toBeGreaterThan(0);
    const recommended = r.swaps.filter((s) => recs.cards.has(index.lookup(s.add)!.oracleId));
    expect(recommended.length).toBeGreaterThan(0);
    for (const s of recommended) expect(s.reason).toMatch(/recommendation list for Krenko, Mob Boss/);
    // Recommended cards already in the deck are protected from cuts.
    const cuts = r.swaps.map((s) => s.cut);
    expect(cuts).not.toContain('Impact Tremors');
    expect(cuts).not.toContain('Dragon Fodder');
  });

  it('counts toward Brawl commander synergy', async () => {
    const { deck, recs } = await setup();
    const without = ratePower(deck, brawl, { asOf: '2026-10-08' });
    const withRecs = ratePower(deck, brawl, { asOf: '2026-10-08', recommendations: recs });
    const syn = (r: typeof without) => r.dimensions.find((d) => d.name === 'Commander synergy')!;
    expect(syn(withRecs).reasons.join(' ')).toMatch(/pasted recommendation list/);
    expect(syn(withRecs).score).not.toBe(syn(without).score);
  });

  it('is accepted by suggest_upgrades and rate_power, flagging a commander mismatch', async () => {
    const client = await connect(createServer(testContext()));
    const text = readFixture('standardbrawl-krenko.txt');
    const recommendations = { text: readFixture('recs-paste-krenko.txt'), commander: 'Lathliss, Dragon Queen', source: 'EDHREC' };
    const s = await call(client, 'suggest_upgrades', { text, format: 'brawl', mode: 'casual', recommendations });
    expect(s.isError).toBe(false);
    expect(s.body.recommendations).toMatchObject({ source: 'EDHREC', cardsRecognized: 8, alreadyInDeck: 2 });
    expect((s.body.recommendations as { notes: string[] }).notes[0]).toMatch(/for Lathliss, Dragon Queen/);
    const r = await call(client, 'rate_power', { text, format: 'brawl', recommendations: { text: 'Legion Warboss' } });
    expect(r.isError).toBe(false);
    expect(r.body.recommendations).toMatchObject({ cardsRecognized: 1 });
  });

  it('tune_my_deck asks the user to paste EDHREC for Brawl instead of fetching it', async () => {
    const client = await connect(createServer(testContext()));
    const p = await client.getPrompt({ name: 'tune_my_deck', arguments: { decklist: '1 Krenko, Mob Boss', format: 'brawl' } });
    expect((p.messages[0]!.content as { text: string }).text).toMatch(/paste my commander's EDHREC page/);
    const std = await client.getPrompt({ name: 'tune_my_deck', arguments: { decklist: '4 Shock', format: 'standard' } });
    expect((std.messages[0]!.content as { text: string }).text).not.toMatch(/EDHREC/);
  });
});
