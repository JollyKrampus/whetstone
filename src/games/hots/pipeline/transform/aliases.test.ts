import { describe, expect, it } from 'vitest';
import { buildAliases, editDistance, searchTextOwners, type AliasInput } from './aliases.ts';

const input = (over: Partial<AliasInput>): AliasInput => ({
  slug: 'liming',
  name: 'Li-Ming',
  internalIds: ['Wizard', 'LiMing'],
  localizedNames: [],
  curated: [],
  ...over,
});

describe('editDistance', () => {
  it('computes Levenshtein distance with an early exit', () => {
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(editDistance('zalatath', 'xalatath')).toBe(1);
    expect(editDistance('a', 'abcdefgh', 2)).toBe(3);
  });
});

describe('buildAliases', () => {
  it('adds the outbound slug, the display name, localized names and curated aliases', () => {
    const a = buildAliases(input({ curated: ['Ming', 'li ming'], localizedNames: ['리밍', 'Ли Мин'] }), new Map());
    expect(a).toEqual(expect.arrayContaining(['li-ming', 'ming', 'li ming', '리밍', 'ли мин']));
    expect(a).not.toContain('liming');
    expect([...a].sort()).toEqual(a);
  });

  it('keeps unique searchText tokens that spell the hero, drops generic words', () => {
    const heroes = [
      input({ slug: 'xalatath', name: "Xal'atath", internalIds: ['Xalatath'], searchText: "Zal'atath Zalatath Void Burst Ranged" }),
      input({ slug: 'kelthuzad', name: "Kel'Thuzad", internalIds: ['KelThuzad'], searchText: 'KT Kelthuzad Burst Ranged' }),
    ];
    const owners = searchTextOwners(heroes);
    expect(buildAliases(heroes[0] as AliasInput, owners)).toEqual(expect.arrayContaining(['zalatath', "zal'atath"]));
    expect(buildAliases(heroes[0] as AliasInput, owners)).not.toContain('burst');
    expect(buildAliases(heroes[0] as AliasInput, owners)).not.toContain('void');
    expect(buildAliases(heroes[1] as AliasInput, owners)).toContain('kt');
  });
});
