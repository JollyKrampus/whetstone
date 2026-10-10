import { describe, expect, it } from 'vitest';
import { analyzeDeck, tappedKind } from '../src/core/analyze.js';
import { parseAndResolve } from '../src/core/deck.js';
import { getFormat } from '../src/core/formats.js';
import { constructedRubric, karstenSources } from '../src/core/rubric.js';
import { tagRoles } from '../src/data/roles.js';
import { createServer } from '../src/server.js';
import { fixtureIndex, readFixture, testContext } from './fixture.js';
import { call, connect } from './helpers.js';

const roleIds = async (name: string) => tagRoles((await fixtureIndex()).lookup(name)!).map((t) => t.role);

describe('role tagging', () => {
  it('tags removal, counters, sweepers, draw, ramp, threats and lifegain', async () => {
    expect(await roleIds('Lightning Bolt')).toContain('removal');
    expect(await roleIds('Stroke of Midnight')).toContain('removal');
    expect(await roleIds('Pacifism')).toContain('removal');
    expect(await roleIds('Cut Down')).toContain('removal');
    expect(await roleIds('Counterspell')).toEqual(['counterspell']);
    expect(await roleIds('Wrath of God')).toContain('sweeper');
    expect(await roleIds('Sunfall')).toContain('sweeper');
    expect(await roleIds('Opt')).toContain('card_draw');
    expect(await roleIds('Llanowar Elves')).toContain('ramp');
    expect(await roleIds('Cultivate')).toContain('ramp');
    expect(await roleIds('Cultivate')).not.toContain('tutor');
    expect(await roleIds('Monastery Swiftspear')).toContain('threat');
    expect(await roleIds('Lightning Helix')).toEqual(expect.arrayContaining(['removal', 'lifegain']));
    expect(await roleIds('Mountain')).toEqual([]);
  });

  it('does not tag reminder text', async () => {
    // Evolving Wilds fetches a land but isn't a tutor or card draw.
    expect(await roleIds('Evolving Wilds')).not.toContain('tutor');
  });
});

describe('Karsten table', () => {
  it('reads the rubric table and scales by deck size', () => {
    const t = constructedRubric().karsten;
    expect(karstenSources(t, 1, 1, 60)).toBe(14);
    expect(karstenSources(t, 2, 2, 60)).toBe(21);
    expect(karstenSources(t, 1, 9, 60)).toBe(9); // past the last column
    expect(karstenSources(t, 1, 1, 40)).toBe(9);
  });
});

describe('analyzeDeck', () => {
  it('reports curve, lands, sources, tapped lands and interaction for a Standard deck', async () => {
    const deck = await parseAndResolve(readFixture('standard-boros.txt'), await fixtureIndex());
    const a = analyzeDeck(deck, getFormat('standard'));
    expect(a.deckSize).toBe(60);
    expect(a.landCount).toBe(20);
    expect(a.nonlandCount).toBe(40);
    expect(a.curve).toEqual({ '0': 0, '1': 12, '2': 24, '3': 2, '4': 2, '5': 0, '6': 0, '7+': 0 });
    expect(a.averageManaValue).toBe(1.85);
    expect(a.colors.sources).toEqual({ W: 14, U: 0, B: 0, R: 18, G: 0 });
    expect(a.colors.deckColors).toEqual(['W', 'R']);
    expect(a.tappedLands).toMatchObject({ unconditional: 2, conditional: 8 });
    expect(a.archetype).toBe('aggro');
    expect(a.interaction.total).toBeGreaterThanOrEqual(14);
    expect(a.roles.cards.find((c) => c.name === 'Shock')?.roles).toEqual([{ role: 'removal', rule: 'damage-target' }]);
  });

  it('flags color shortfalls against Karsten', async () => {
    const deck = await parseAndResolve('4 Counterspell\n4 Lightning Strike\n4 Opt\n24 Mountain\n4 Island\n20 Shock', await fixtureIndex());
    const a = analyzeDeck(deck, getFormat('historic'));
    const blue = a.colors.shortfalls.find((s) => s.color === 'U' && s.pips === 2)!;
    expect(blue).toMatchObject({ sources: 4, sourcesNeeded: 21, ok: false });
    expect(blue.cards).toEqual(['Counterspell']);
  });

  it('counts fetch lands as sources for the basics in the deck', async () => {
    const deck = await parseAndResolve('4 Evolving Wilds\n10 Mountain\n10 Forest\n36 Llanowar Elves', await fixtureIndex());
    const a = analyzeDeck(deck, getFormat('historic'));
    expect(a.colors.sources).toMatchObject({ R: 14, G: 14 });
    expect(a.archetype).toBe('ramp');
  });

  it('classifies tapped lands', async () => {
    const index = await fixtureIndex();
    expect(tappedKind(index.lookup('Temple of Triumph')!)).toBe('unconditional');
    expect(tappedKind(index.lookup('Sacred Foundry')!)).toBe('conditional');
    expect(tappedKind(index.lookup('Sundown Pass')!)).toBe('conditional');
    expect(tappedKind(index.lookup('Mountain')!)).toBeNull();
  });

  it('is exposed as analyze_deck', async () => {
    const client = await connect(createServer(testContext()));
    const r = await call(client, 'analyze_deck', { text: readFixture('standardbrawl-krenko.txt'), format: 'standardbrawl' });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ format: 'standardbrawl', deckSize: 60, archetype: 'brawl', landCount: 34 });
  });
});
