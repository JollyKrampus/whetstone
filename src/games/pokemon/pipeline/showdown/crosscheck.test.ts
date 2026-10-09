import { describe, expect, it } from 'vitest';
import type { Species } from '../../schema.ts';
import { recordedDex } from '../test-support.ts';
import { CALC_ALIASES, crossCheckWithCalc } from './crosscheck.ts';

describe('crossCheckWithCalc', () => {
  it('agrees with @smogon/calc generation 0 on the recorded dex', () => {
    const { species } = recordedDex();
    const check = crossCheckWithCalc(species);
    expect(check.mismatches).toEqual([]);
    expect(check.missing).toEqual([]);
    expect(check.matched).toBe(species.length);
  });

  it('flags base stat and type disagreements', () => {
    const species = recordedDex().species.filter((s) => s.id === 'garchomp' || s.id === 'incineroar');
    const wrong: Species[] = species.map((s) => (s.id === 'garchomp' ? { ...s, base: { ...s.base, spe: 103 } } : { ...s, types: ['Fire'] }));
    const check = crossCheckWithCalc(wrong);
    expect(check.matched).toBe(0);
    expect(check.mismatches).toEqual(['garchomp: spe 103 vs calc 102', 'incineroar: types Fire vs calc Fire/Dark']);
  });

  it('reports species the calc does not have and honours its spelling of formes', () => {
    const stub = recordedDex().species[0] as Species;
    expect(crossCheckWithCalc([{ ...stub, id: 'notapokemon' }]).missing).toEqual(['notapokemon']);
    const aegislash: Species = { ...stub, id: 'aegislash', types: ['Steel', 'Ghost'], base: { hp: 60, atk: 50, def: 140, spa: 50, spd: 140, spe: 60 } };
    expect(CALC_ALIASES.aegislash).toBe('aegislashshield');
    expect(crossCheckWithCalc([aegislash])).toEqual({ matched: 1, missing: [], mismatches: [] });
  });
});
