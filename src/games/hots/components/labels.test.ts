import { describe, expect, it } from 'vitest';
import { HERO_TAGS, MAP_TAGS } from '../schema.ts';
import { countDirs, describeCounts, emptyCounts, groupTags, mapTagLabel, netVerdict, sortAbilities, tagLabel } from './labels.ts';

describe('hots display labels', () => {
  it('labels every hero and map tag in the schema vocabulary', () => {
    for (const tag of HERO_TAGS) expect(tagLabel(tag), tag).toMatch(/\S/);
    for (const tag of MAP_TAGS) expect(mapTagLabel(tag), tag).toMatch(/\S/);
  });

  it('groups tags in a fixed order, alphabetical inside a group, dropping empty groups', () => {
    const groups = groupTags([{ tag: 'stun' }, { tag: 'blind' }, { tag: 'dive' }]);
    expect(groups.map((g) => g.group)).toEqual(['control', 'trait']);
    expect(groups[0]?.items.map((i) => i.tag)).toEqual(['blind', 'stun']);
  });

  it('counts change directions, treating undirected lines as plain changes', () => {
    const counts = countDirs([{ dir: 'buff' }, { dir: 'buff' }, { dir: 'nerf' }, {}]);
    expect(counts).toEqual({ buff: 2, nerf: 1, change: 1, rework: 0 });
    expect(describeCounts(counts)).toBe('2 buffs, 1 nerf, 1 other change');
    expect(describeCounts(emptyCounts())).toBe('');
  });

  it('summarises a set of changes in one verdict', () => {
    expect(netVerdict({ buff: 1, nerf: 0, change: 0, rework: 0 })).toBe('buff');
    expect(netVerdict({ buff: 0, nerf: 2, change: 1, rework: 0 })).toBe('nerf');
    expect(netVerdict({ buff: 1, nerf: 1, change: 0, rework: 0 })).toBe('mixed');
    expect(netVerdict({ buff: 3, nerf: 0, change: 0, rework: 1 })).toBe('rework');
    expect(netVerdict(emptyCounts())).toBe('change');
  });

  it('orders abilities like the game: trait, Q W E, heroics, actives, mount', () => {
    const sorted = sortAbilities([
      { kind: 'mount', hotkey: 'Z', name: 'Mount' },
      { kind: 'heroic', hotkey: 'R', name: 'Ult B' },
      { kind: 'basic', hotkey: 'E', name: 'E' },
      { kind: 'heroic', hotkey: 'R', name: 'Ult A' },
      { kind: 'basic', hotkey: 'Q', name: 'Q' },
      { kind: 'trait', hotkey: 'D', name: 'Trait' },
      { kind: 'active', hotkey: '1', name: 'Active' },
    ]);
    expect(sorted.map((a) => a.name)).toEqual(['Trait', 'Q', 'E', 'Ult A', 'Ult B', 'Active', 'Mount']);
  });
});
