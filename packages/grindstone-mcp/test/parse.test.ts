import { describe, expect, it } from 'vitest';
import { countCards, parseAndResolve, playEntries } from '../src/core/deck.js';
import { getFormat } from '../src/core/formats.js';
import { parseArenaText } from '../src/core/parse.js';
import { validateDeck } from '../src/core/validate.js';
import { createServer } from '../src/server.js';
import { fixtureIndex, readFixture, testContext } from './fixture.js';
import { call, connect } from './helpers.js';

describe('parseArenaText', () => {
  it('reads Deck / Sideboard sections, set codes and the About name', () => {
    const raw = parseArenaText(readFixture('standard-boros.txt'));
    expect(raw.name).toBe('Boros Pressure');
    expect(raw.issues).toEqual([]);
    const first = raw.entries[0]!;
    expect(first).toMatchObject({ qty: 4, name: 'Emberheart Challenger', set: 'BLB', collectorNumber: '133', section: 'main' });
    expect(raw.entries.filter((e) => e.section === 'side').map((e) => e.name)).toEqual(['Abrade', 'Boltwave', 'Cathar Commando']);
  });

  it('treats lines before any header as Deck and a bare blank line as the sideboard break', () => {
    const raw = parseArenaText(readFixture('historic-blank-line.txt'));
    const side = raw.entries.filter((e) => e.section === 'side');
    expect(side.map((e) => e.name)).toEqual(['Abrade', 'Fable of the Mirror-Breaker // Reflection of Kiki-Jiki']);
    expect(raw.entries.find((e) => e.name === 'Monastery Swiftspear')).toMatchObject({ qty: 4, section: 'main' });
  });

  it('does not treat a blank line before an explicit Sideboard header as a break', () => {
    const raw = parseArenaText('4 Shock\n\n4 Lightning Strike\n\nSideboard\n2 Abrade');
    expect(raw.entries.map((e) => e.section)).toEqual(['main', 'main', 'side']);
  });

  it('reads the Commander and Companion sections', () => {
    const raw = parseArenaText(readFixture('standardbrawl-krenko.txt'));
    expect(raw.entries[0]).toMatchObject({ name: 'Krenko, Mob Boss', section: 'commander' });
    expect(raw.entries.filter((e) => e.section === 'main')).toHaveLength(26);
  });

  it('collects bad lines without throwing (CRLF input)', () => {
    const raw = parseArenaText(readFixture('malformed.txt'));
    expect(raw.name).toBe('Messy List');
    expect(raw.issues.map((i) => i.code).sort()).toEqual(['bad_quantity', 'unparsed_line']);
    expect(raw.entries.some((e) => e.name === 'Hill Giant')).toBe(false); // maybeboard is ignored
    expect(raw.entries.find((e) => e.name === 'Shock' && e.set === 'M21')).toBeDefined(); // *F* marker stripped
  });

  it('survives arbitrary garbage', () => {
    expect(() => parseArenaText('\u0000\n(((\n99999999999999999999 x\n// comment\n')).not.toThrow();
    expect(parseArenaText('').entries).toEqual([]);
  });
});

describe('resolveDeck', () => {
  it('resolves by name, front faces and split names, and merges duplicate lines', async () => {
    const deck = await parseAndResolve(readFixture('malformed.txt'), await fixtureIndex());
    const byName = Object.fromEntries(deck.main.map((e) => [e.name, e.qty]));
    expect(byName['Shock']).toBe(4);
    expect(byName['Brazen Borrower // Petty Theft']).toBe(2);
    expect(byName['Wear // Tear']).toBe(1);
    expect(byName['Commit // Memory']).toBe(1);
    expect(deck.companion?.name).toBe('Krenko, Tin Street Kingpin');
    const codes = deck.unresolved.map((u) => u.code).sort();
    expect(codes).toEqual(['alchemy_card', 'bad_quantity', 'unknown_card', 'unparsed_line']);
    const typo = deck.unresolved.find((u) => u.code === 'unknown_card')!;
    expect(typo.suggestions).toContain('Lightning Bolt');
  });
});

describe('validateDeck', () => {
  it('accepts a legal Standard deck', async () => {
    const deck = await parseAndResolve(readFixture('standard-boros.txt'), await fixtureIndex());
    const r = validateDeck(deck, getFormat('standard'));
    expect(r.issues).toEqual([]);
    expect(r).toMatchObject({ legal: true, mainCount: 60, sideCount: 7 });
  });

  it('flags cards not legal in the format, banned cards and Arena availability', async () => {
    const index = await fixtureIndex();
    const deck = await parseAndResolve(readFixture('historic-blank-line.txt'), index);
    expect(validateDeck(deck, getFormat('historic')).legal).toBe(true);
    const pioneer = validateDeck(deck, getFormat('explorer'));
    expect(pioneer.format).toBe('pioneer');
    expect(pioneer.issues).toContainEqual(expect.objectContaining({ code: 'not_legal', card: 'Raging Goblin' }));
    const std = validateDeck(deck, getFormat('standard'));
    expect(std.issues).toContainEqual(expect.objectContaining({ code: 'banned', card: 'Heartfire Hero' }));

    const bolt = await parseAndResolve('56 Mountain\n4 Lightning Bolt', index);
    expect(validateDeck(bolt, getFormat('historic')).issues).toContainEqual(
      expect.objectContaining({ code: 'banned', card: 'Lightning Bolt' }),
    );

    const offArena = await parseAndResolve('20 Mountain\n40 Goblin Guide', index);
    expect(validateDeck(offArena, getFormat('timeless')).issues).toContainEqual(
      expect.objectContaining({ code: 'not_on_arena', card: 'Goblin Guide' }),
    );
  });

  it('checks deck size, copy limits across main and side, sideboard size and printed limits', async () => {
    const index = await fixtureIndex();
    const deck = await parseAndResolve(
      'Deck\n5 Shock\n7 Seven Dwarves\n12 Relentless Rats\n20 Mountain\n\nSideboard\n1 Shock\n16 Abrade',
      index,
    );
    const r = validateDeck(deck, getFormat('historic'));
    const codes = r.issues.map((i) => i.code);
    expect(codes).toContain('deck_size');
    expect(codes).toContain('sideboard_size');
    expect(r.issues.filter((i) => i.code === 'too_many_copies').map((i) => i.card).sort()).toEqual(['Abrade', 'Shock']);
  });

  it('validates Brawl: commander, singleton, exact size and color identity', async () => {
    const index = await fixtureIndex();
    const ok = await parseAndResolve(readFixture('standardbrawl-krenko.txt'), index);
    const r = validateDeck(ok, getFormat('standard brawl'));
    expect(r.issues).toEqual([]);
    expect(countCards(playEntries(ok))).toBe(60);

    const bad = await parseAndResolve(
      'Commander\n1 Krenko, Mob Boss\n\nDeck\n2 Shock\n1 Voice of Victory\n1 Shivan Dragon\n54 Mountain',
      index,
    );
    const codes = validateDeck(bad, getFormat('standardbrawl')).issues.map((i) => `${i.code}:${i.card ?? ''}`);
    expect(codes).toEqual(
      expect.arrayContaining(['deck_size:', 'too_many_copies:Shock', 'color_identity:Voice of Victory']),
    );

    const noCommander = await parseAndResolve('60 Mountain', index);
    expect(validateDeck(noCommander, getFormat('brawl')).issues.map((i) => i.code)).toContain('no_commander');
  });
});

describe('deck tools', () => {
  it('parse_decklist returns a deck that validate_deck accepts back', async () => {
    const client = await connect(createServer(testContext()));
    const parsed = await call(client, 'parse_decklist', { text: readFixture('standard-boros.txt'), format: 'standard' });
    expect(parsed.isError).toBe(false);
    const deck = parsed.body.deck as { format: string; main: unknown[] };
    expect(deck.format).toBe('standard');
    expect(parsed.body.counts).toEqual({ main: 60, side: 7 });
    const validated = await call(client, 'validate_deck', { deck });
    expect(validated.body).toMatchObject({ legal: true, format: 'standard' });
  });

  it('returns structured errors for missing input and Alchemy', async () => {
    const client = await connect(createServer(testContext()));
    const missing = await call(client, 'validate_deck', { format: 'standard' });
    expect(missing).toMatchObject({ isError: true, body: { error: 'missing_deck' } });
    const alchemy = await call(client, 'validate_deck', { text: '60 Mountain', format: 'alchemy' });
    expect(alchemy).toMatchObject({ isError: true, body: { error: 'unsupported_format' } });
  });
});
