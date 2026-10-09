import { describe, expect, it } from 'vitest';
import { cardImageUrl, hasBackImage, scryfallCardUrl } from './images.ts';
import { manaLabel, manaSymbols } from './mana.ts';
import { curatedSelection, fromSnapshot, mySelection, newListId, sanitizeList, toFraction, toSnapshot, validateMyLists, type MyList } from './metaLists.ts';
import { MAX_DECK_CHARS, decodeDeckText, deckCodec, deckHash, encodeDeckText, readDeckHash } from './share.ts';

const DECK = 'About\nName Boros Test\n\nDeck\n4 Emberheart Challenger\n4 Lightning Strike\n20 Mountain\n\nSideboard\n2 Abrade';

describe('deck share links', () => {
  it('round-trips deck text, format and seed through the hash', async () => {
    const hash = await deckHash({ text: DECK, format: 'pioneer', seed: 1234 });
    expect(hash).toMatch(/^#v=1&d=z[A-Za-z0-9_-]+&f=pioneer&s=1234$/);
    expect(await readDeckHash(hash)).toEqual({ text: DECK, format: 'pioneer', seed: 1234 });
  });

  it('compresses: a 60-card list fits in a few hundred characters', async () => {
    const long = `Deck\n${Array.from({ length: 15 }, (_, i) => `4 Some Fairly Long Card Name Number ${i}`).join('\n')}`;
    const token = await encodeDeckText(long);
    expect(token.length).toBeLessThan(long.length / 2);
    expect(await decodeDeckText(token)).toBe(long);
  });

  it('omits defaults and keeps the plain-text fallback readable', async () => {
    expect(await deckHash({ text: 'Deck\n4 Shock', format: null, seed: 0 })).toMatch(/^#v=1&d=z[^&]+$/);
    const plain = `t${Buffer.from('Deck\n4 Shock').toString('base64url')}`;
    expect(await decodeDeckText(plain)).toBe('Deck\n4 Shock');
  });

  it('never throws on broken or hostile links', async () => {
    expect(await readDeckHash('')).toBeNull();
    expect(await readDeckHash('#v=1')).toBeNull();
    expect(await readDeckHash('#v=1&d=zzzz')).toBeNull();
    expect(await readDeckHash('#v=1&d=x123')).toBeNull();
    expect(await readDeckHash('#v=9&d=tAAAA')).toBeNull();
    expect(await decodeDeckText('t%%%')).toBeNull();
    // A deflate bomb inflating past the cap is refused.
    const bomb = await encodeDeckText('a'.repeat(MAX_DECK_CHARS));
    expect(await decodeDeckText(bomb)).toBe('a'.repeat(MAX_DECK_CHARS));
    const huge = Buffer.from(new Uint8Array(200_000)).toString('base64url');
    expect(await decodeDeckText(`t${huge}`)).toBeNull();
    // Unknown formats fall back to auto.
    expect(deckCodec.decode('#v=1&f=explorer').format).toBe('auto');
  });
});

describe('card images', () => {
  const id = '88b13bc0-da54-4c3b-917c-7c8345a329f5';
  it('builds cards.scryfall.io URLs from the Scryfall id', () => {
    expect(cardImageUrl(id)).toBe(`https://cards.scryfall.io/normal/front/8/8/${id}.jpg`);
    expect(cardImageUrl(id, 'small', 'back')).toBe(`https://cards.scryfall.io/small/back/8/8/${id}.jpg`);
    expect(cardImageUrl('../evil')).toBeNull();
    expect(cardImageUrl(undefined)).toBeNull();
  });

  it('knows which layouts have a back image and links to the printing', () => {
    expect(hasBackImage('transform')).toBe(true);
    expect(hasBackImage('adventure')).toBe(false);
    expect(scryfallCardUrl('msh', '142', 'Lightning Strike')).toBe('https://scryfall.com/card/msh/142');
    expect(scryfallCardUrl(undefined, undefined, 'Fire // Ice')).toContain('scryfall.com/search?q=');
  });
});

describe('mana symbols', () => {
  it('labels generic, coloured, hybrid and Phyrexian symbols', () => {
    expect(manaSymbols('{2}{R}{G/U}{W/P}{X}').map((s) => s.label)).toEqual(['2 generic', 'red', 'green or blue', 'Phyrexian white', 'X']);
    expect(manaSymbols('{2/W}')[0]?.colors).toEqual(['N', 'W']);
    expect(manaLabel('')).toBe('no mana cost');
    expect(manaLabel('{1}{B}')).toBe('1 generic, black');
  });
});

describe('my meta lists', () => {
  const now = new Date('2026-10-08T12:00:00Z');
  const base: MyList = { id: 'a', format: 'standard', name: 'Boros', list: DECK, addedAt: now.toISOString() };

  it('validates stored lists and drops broken entries', () => {
    expect(validateMyLists('nope')).toBeUndefined();
    const out = validateMyLists([base, { ...base }, { format: 'explorer', list: 'x' }, { format: 'pioneer', list: '  ' }, { ...base, id: 'b', metaShare: 12.5, winRate: '55%', sourceUrl: 'javascript:alert(1)' }]);
    expect(out?.map((l) => l.id)).toEqual(['a', 'b']);
    expect(out?.[1]).toMatchObject({ metaShare: 0.125, winRate: 0.55 });
    expect(out?.[1]?.sourceUrl).toBeUndefined();
    expect(sanitizeList({ format: 'standard', list: 'Deck\n4 Shock', sourceUrl: 'https://magic.gg/x' })?.sourceUrl).toBe('https://magic.gg/x');
  });

  it('reads shares as fractions or percentages', () => {
    expect(toFraction(0.25)).toBe(0.25);
    expect(toFraction(25)).toBe(0.25);
    expect(toFraction('7.5%')).toBe(0.075);
    expect(toFraction(-1)).toBeUndefined();
    expect(toFraction('abc')).toBeUndefined();
  });

  it('builds analyzer selections per format, never from example decks', () => {
    expect(mySelection([base], 'pioneer')).toBeNull();
    expect(mySelection([base], 'standard')).toEqual({ label: 'My Standard lists', lists: [{ name: 'Boros', list: DECK }] });
    expect(curatedSelection({ format: 'standard', example: true, decks: [{ list: DECK }] })).toBeNull();
    expect(curatedSelection({ format: 'standard', decks: [{ list: DECK, example: true }] })).toBeNull();
    expect(curatedSelection({ format: 'standard', date: '2026-10-01', decks: [{ archetype: 'Boros', list: DECK, sourceUrl: 'https://x.test/' }] })).toEqual({
      label: 'Curated Standard lists (2026-10-01)',
      lists: [{ archetype: 'Boros', list: DECK }],
    });
  });

  it('exports and re-imports grindstone snapshots', () => {
    const snap = toSnapshot([{ ...base, archetype: 'Boros Aggro', metaShare: 0.2 }], 'standard', '2026-10-08');
    expect(snap).toMatchObject({ format: 'standard', decks: [{ name: 'Boros', archetype: 'Boros Aggro', metaShare: 0.2, list: DECK }] });
    const back = fromSnapshot(snap, now, [base]);
    expect(back.errors).toEqual([]);
    expect(back.lists).toHaveLength(1);
    expect(back.lists[0]?.id).not.toBe('a');
    expect(back.lists[0]).toMatchObject({ format: 'standard', archetype: 'Boros Aggro', metaShare: 0.2 });
    const bad = fromSnapshot([{ format: 'vintage', decks: [] }, { decks: 1 }, { format: 'explorer', decks: [{ list: '' }, { list: 'Deck\n4 Opt', winRate: 54 }] }], now);
    expect(bad.errors).toHaveLength(3);
    expect(bad.lists).toEqual([expect.objectContaining({ format: 'pioneer', winRate: 0.54 })]);
  });

  it('makes unique ids', () => {
    let i = 0;
    const seq = [0.1, 0.1, 0.2];
    const id = newListId([{ ...base, id: newListId([], 5, () => 0.1) }], 5, () => seq[i++] ?? 0.3);
    expect(id).toBe(newListId([], 5, () => 0.2));
  });
});
