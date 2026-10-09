import { describe, expect, it } from 'vitest';
import { compactKey, createSearchIndex, normalize, type SearchEntity } from './search.ts';

const ROSTER: SearchEntity[] = [
  { id: 'abathur', name: 'Abathur', aliases: ['slapathur'], extra: 'Support' },
  { id: 'anubarak', name: "Anub'arak", aliases: ['anub'], extra: 'Tank' },
  { id: 'chen', name: 'Chen', extra: 'Bruiser' },
  { id: 'chogall', name: "Cho'gall", extra: ['Tank', 'Ranged Assassin'] },
  { id: 'dva', name: 'D.Va', extra: 'Bruiser' },
  { id: 'etc', name: 'E.T.C.', extra: 'Tank' },
  { id: 'kaelthas', name: "Kael'thas", aliases: ['kael'], extra: 'Ranged Assassin' },
  { id: 'kelthuzad', name: "Kel'Thuzad", aliases: ['kt'], extra: 'Ranged Assassin' },
  { id: 'lili', name: 'Li Li', extra: 'Healer' },
  { id: 'liming', name: 'Li-Ming', aliases: ['li-ming'], extra: 'Ranged Assassin' },
  { id: 'lucio', name: 'Lúcio', extra: 'Healer' },
  { id: 'malfurion', name: 'Malfurion', aliases: ['malf'], extra: 'Healer' },
  { id: 'malganis', name: "Mal'Ganis", extra: 'Tank' },
  { id: 'malthael', name: 'Malthael', extra: 'Bruiser' },
  { id: 'sgthammer', name: 'Sgt. Hammer', aliases: ['hammer'], extra: 'Ranged Assassin' },
  { id: 'thebutcher', name: 'The Butcher', extra: 'Melee Assassin' },
  { id: 'thelostvikings', name: 'The Lost Vikings', aliases: ['tlv', 'lost vikings'], extra: 'Support' },
  { id: 'xalatath', name: "Xal'atath", extra: 'Ranged Assassin' },
  { id: 'zuljin', name: "Zul'jin", aliases: ['zj'], extra: 'Ranged Assassin' },
];

const index = createSearchIndex(ROSTER);
const top = (q: string): string | undefined => index.search(q)[0];

describe('normalize', () => {
  it.each([
    ['Li-Ming', 'li ming'],
    ["Kel'Thuzad", 'kelthuzad'],
    ['Kel’Thuzad', 'kelthuzad'],
    ['Lúcio', 'lucio'],
    ['E.T.C.', 'e t c'],
    ["Thrall's", 'thrall'],
    ['  The   Butcher!! ', 'the butcher'],
    ["Cho'gall", 'chogall'],
    ['D.Va', 'd va'],
    ['ＡＢＡＴＨＵＲ', 'abathur'],
    ["Urza's Saga", 'urza saga'],
    ['', ''],
  ])('%s → %s', (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });

  it('compacts away spaces', () => {
    expect(compactKey('Li Ming')).toBe('liming');
    expect(compactKey('E.T.C.')).toBe('etc');
  });
});

describe('createSearchIndex', () => {
  it.each(['li ming', 'liming', 'Li-Ming', 'LI MING', 'li-ming'])('finds Li-Ming for %s', (q) => {
    expect(top(q)).toBe('liming');
  });

  it.each([
    ['kael', 'kaelthas'],
    ["kael'thas", 'kaelthas'],
    ['etc', 'etc'],
    ['E.T.C', 'etc'],
    ['butcher', 'thebutcher'],
    ['the butcher', 'thebutcher'],
    ['xal', 'xalatath'],
    ['xalatath', 'xalatath'],
    ['cho gall', 'chogall'],
    ["cho'gall", 'chogall'],
    ['chogall', 'chogall'],
    ['kt', 'kelthuzad'],
    ['kel', 'kelthuzad'],
    ['lucio', 'lucio'],
    ['Lúcio', 'lucio'],
    ['dva', 'dva'],
    ['d.va', 'dva'],
    ['hammer', 'sgthammer'],
    ['sgt hammer', 'sgthammer'],
    ['lost vik', 'thelostvikings'],
    ['tlv', 'thelostvikings'],
    ['zj', 'zuljin'],
    ['anub', 'anubarak'],
    ['slapathur', 'abathur'],
    ["butcher's", 'thebutcher'],
  ])('%s → %s', (q, id) => {
    expect(top(q)).toBe(id);
  });

  it('ranks exact > prefix > token-prefix > substring > subsequence', () => {
    expect(index.hits('chen')[0]).toMatchObject({ id: 'chen', tier: 'exact', field: 'name' });
    expect(index.hits('kael')[0]).toMatchObject({ id: 'kaelthas', tier: 'exact', field: 'alias' });
    expect(index.hits('xal')[0]).toMatchObject({ id: 'xalatath', tier: 'prefix', field: 'name' });
    expect(index.hits('butcher')[0]).toMatchObject({ id: 'thebutcher', tier: 'token-prefix' });
    expect(index.hits('thuz')[0]).toMatchObject({ id: 'kelthuzad', tier: 'substring' });
    expect(index.hits('abth')[0]).toMatchObject({ id: 'abathur', tier: 'subsequence' });
  });

  it('orders a shared prefix by closeness, then name', () => {
    expect(index.search('li').slice(0, 2)).toEqual(['lili', 'liming']);
    // All three are name prefixes; the shorter names are the closer matches.
    expect(index.search('mal').slice(0, 3)).toEqual(['malganis', 'malthael', 'malfurion']);
  });

  it('ranks name matches above extras', () => {
    const healers = index.search('healer');
    expect(healers).toEqual(['lili', 'lucio', 'malfurion']);
    expect(index.hits('tank')[0]!.field).toBe('extra');
  });

  it('returns nothing for no match and everything for a blank query', () => {
    expect(index.search('qqq')).toEqual([]);
    expect(index.search('')).toEqual(ROSTER.map((e) => e.id));
    expect(index.search('  ', 3)).toEqual(['abathur', 'anubarak', 'chen']);
    expect(index.hits('')).toEqual([]);
    expect(index.search('a', 2)).toHaveLength(2);
  });

  it('is stable regardless of input order and ignores duplicate ids', () => {
    const shuffled = createSearchIndex([...ROSTER].reverse().concat(ROSTER[0]!));
    expect(shuffled.size).toBe(ROSTER.length);
    for (const q of ['li', 'mal', 'a', 'tank', 'healer', 'th']) expect(shuffled.search(q)).toEqual(index.search(q));
  });

  it('keeps the plain-s variant of possessive names searchable', () => {
    const cards = createSearchIndex([
      { id: 'urza', name: "Urza's Saga" },
      { id: 'urzalord', name: 'Urza, Lord High Artificer' },
    ]);
    expect(cards.search('urzas saga')[0]).toBe('urza');
    expect(cards.search("urza's saga")[0]).toBe('urza');
    expect(cards.search('urza lord')[0]).toBe('urzalord');
  });
});
