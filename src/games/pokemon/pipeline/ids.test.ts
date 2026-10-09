import { describe, expect, it } from 'vitest';
import type { Item, Species } from '../schema.ts';
import { dexIndex, toId } from './ids.ts';

const base = { base: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, abilities: ['x'], weightkg: 1, legal: ['M-C'] };
const species: Species[] = [
  { ...base, id: 'charizard', name: 'Charizard', num: 6, types: ['Fire', 'Flying'], megas: ['charizardmegay'] },
  { ...base, id: 'charizardmegay', name: 'Charizard-Mega-Y', num: 6, types: ['Fire', 'Flying'], baseSpecies: 'Charizard', forme: 'Mega-Y', megaOf: 'charizard', requiredItem: 'charizarditey' },
  { ...base, id: 'vivillon', name: 'Vivillon', num: 666, types: ['Bug', 'Flying'], cosmeticFormes: ['vivillonarchipelago', 'vivillonmarine'] },
  { ...base, id: 'vivillonfancy', name: 'Vivillon-Fancy', num: 666, types: ['Bug', 'Flying'], baseSpecies: 'Vivillon', forme: 'Fancy' },
  { ...base, id: 'floetteeternal', name: 'Floette-Eternal', num: 670, types: ['Fairy'], baseSpecies: 'Floette', forme: 'Eternal' },
  { ...base, id: 'floettemega', name: 'Floette-Mega', num: 670, types: ['Fairy'], baseSpecies: 'Floette', forme: 'Mega', megaOf: 'floetteeternal', requiredItem: 'floettite' },
  { ...base, id: 'rotomwash', name: 'Rotom-Wash', num: 479, types: ['Electric', 'Water'], baseSpecies: 'Rotom', forme: 'Wash' },
  { ...base, id: 'rotomheat', name: 'Rotom-Heat', num: 479, types: ['Electric', 'Fire'], baseSpecies: 'Rotom', forme: 'Heat' },
];
const items: Item[] = [
  { id: 'charizarditey', name: 'Charizardite Y', legal: ['M-C'], mega: { base: 'charizard', forme: 'charizardmegay' } },
  { id: 'leftovers', name: 'Leftovers', legal: ['M-C'] },
];

describe('toId', () => {
  it('matches Showdown toID', () => {
    expect(toId('Charizard-Mega-Y')).toBe('charizardmegay');
    expect(toId("Farfetch’d")).toBe('farfetchd');
    expect(toId('Mr. Mime')).toBe('mrmime');
    expect(toId('Flabébé')).toBe('flabb');
    expect(toId(null)).toBe('');
    expect(toId(undefined)).toBe('');
  });
});

describe('dexIndex', () => {
  const dex = dexIndex(species, items);

  it('resolves names and ids, folding cosmetic formes into their species', () => {
    expect(dex.species('Charizard')).toBe('charizard');
    expect(dex.species('Vivillon-Marine')).toBe('vivillon');
    // A real forme keeps its own entry.
    expect(dex.species('Vivillon-Fancy')).toBe('vivillonfancy');
    expect(dex.species('Missingno')).toBeNull();
    // A base species that is not legal itself resolves to its only legal forme...
    expect(dex.species('Floette')).toBe('floetteeternal');
    expect(dex.species('floette-eternal')).toBe('floetteeternal');
    // ...but never guesses between several.
    expect(dex.species('Rotom')).toBeNull();
    expect(dex.has('charizardmegay')).toBe(true);
  });

  it('counts a Pokémon holding its own Mega Stone as the Mega', () => {
    expect(dex.mega('charizard', 'charizarditey')).toBe('charizardmegay');
    expect(dex.usageId('charizard', 'charizarditey')).toBe('charizardmegay');
    expect(dex.usageId('charizard', 'leftovers')).toBe('charizard');
    expect(dex.usageId('charizard', undefined)).toBe('charizard');
    // Someone else's stone does nothing.
    expect(dex.usageId('vivillon', 'charizarditey')).toBe('vivillon');
  });

  it('names ids and finds base species', () => {
    expect(dex.name('charizardmegay')).toBe('Charizard-Mega-Y');
    expect(dex.name('unknown')).toBe('unknown');
    expect(dex.base('charizardmegay')).toBe('charizard');
    expect(dex.base('vivillon')).toBe('vivillon');
  });
});
