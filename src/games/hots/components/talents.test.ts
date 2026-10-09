import { describe, expect, it } from 'vitest';
import type { Talent, Talents } from '../schema.ts';
import { buildToken, resolveBuild } from './talents.ts';

function tier(prefix: string, n = 3): Talent[] {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i + 1}`, name: `${prefix} ${i + 1}`, text: 'x', icon: 'img/t.webp', sort: i + 1 }));
}

const talents: Talents = { '1': tier('a'), '4': tier('b'), '7': tier('c'), '10': tier('d', 2), '13': tier('e'), '16': tier('f'), '20': tier('g', 4) };
const hero = { id: 'Garr', name: 'Garrosh', talents };

describe('talent build strings', () => {
  it('derives the hero token from the English name', () => {
    expect(buildToken({ id: 'Garr', name: 'Garrosh' })).toBe('Garrosh');
    expect(buildToken({ id: 'Wiza', name: 'Li-Ming' })).toBe('LiMing');
    expect(buildToken({ id: 'HXAL', name: "Xal'atath" })).toBe('Xalatath');
    expect(buildToken({ id: 'Luci', name: 'Lúcio' })).toBe('Lucio');
    expect(buildToken({ id: 'CCho', name: 'Cho' })).toBe('Chogall');
  });

  it('writes one digit per tier from the talent positions', () => {
    const build = resolveBuild([hero], ['a2', 'b2', 'c2', 'd2', 'e2', 'f3', 'g2']);
    expect(build?.code).toBe('[T2222232,Garrosh]');
    expect(build?.picks.map((p) => p?.tier)).toEqual(['1', '4', '7', '10', '13', '16', '20']);
  });

  it('writes 0 for tiers a partial build leaves open', () => {
    const build = resolveBuild([hero], ['a1', 'c3']);
    expect(build?.code).toBe('[T1030000,Garrosh]');
    expect(build?.picks.filter(Boolean)).toHaveLength(2);
  });

  it('refuses a build with two talents from one tier', () => {
    expect(resolveBuild([hero], ['a1', 'a2'])?.code).toBeNull();
  });

  it('tries each candidate in order and gives up on unknown talents', () => {
    const member = { id: 'Gall', name: 'Gall', talents: { ...talents, '1': tier('z') } };
    expect(resolveBuild([hero, member], ['z1'])?.owner.id).toBe('Gall');
    expect(resolveBuild([hero], ['nope'])).toBeNull();
    expect(resolveBuild([hero], [])).toBeNull();
  });
});
