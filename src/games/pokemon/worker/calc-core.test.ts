import { describe, expect, it } from 'vitest';
import { betterResult, knowsSpecies, percentOfHp, runCalc, runMatrix } from './calc-core.ts';
import type { CalcMon, MoveResult } from './protocol.ts';

const GARCHOMP: CalcMon = { species: 'garchomp', nature: 'Jolly', sp: [2, 32, 0, 0, 0, 32], ability: 'roughskin' };
const INCINEROAR: CalcMon = { species: 'incineroar', nature: 'Careful', sp: [32, 0, 2, 0, 32, 0], ability: 'intimidate', item: 'sitrusberry' };

describe('runCalc (Champions, @smogon/calc gen 0)', () => {
  it('reproduces the verified Earthquake calc with spread damage in Doubles', () => {
    const res = runCalc({ attacker: GARCHOMP, defender: INCINEROAR, moves: ['earthquake'], field: { doubles: true } });
    expect(res.errors).toEqual([]);
    const eq = res.results[0]!;
    expect([eq.min, eq.max]).toEqual([138, 164]);
    // 164 / 202 = 81.19 %: floored like the calc's own description, not rounded up to 81.2.
    expect([eq.minPct, eq.maxPct]).toEqual([68.3, 81.1]);
    expect(eq).toMatchObject({ koN: 2, koChance: 1, spread: true, moveName: 'Earthquake' });
    expect(eq.desc).toContain('guaranteed 2HKO');
    expect(eq.desc).toContain('(68.3 - 81.1%)');
    expect(res.attackerStats).toMatchObject({ hp: 185, atk: 182, spe: 169 });
  });

  it('prints the same percentages as the description line for every result', () => {
    const attackers: CalcMon[] = [GARCHOMP, { ...GARCHOMP, item: 'lifeorb' }, { species: 'gholdengo', nature: 'Modest', sp: [2, 0, 0, 32, 0, 32], ability: 'goodasgold' }];
    const moves = ['earthquake', 'dragonclaw', 'rockslide', 'makeitrain', 'shadowball'];
    let checked = 0;
    for (const attacker of attackers) {
      for (const defender of [INCINEROAR, { ...INCINEROAR, sp: [0, 0, 0, 0, 0, 0] as number[] }]) {
        const res = runCalc({ attacker, defender, moves, field: { doubles: true } });
        for (const r of res.results) {
          if (r.max === 0) continue;
          const m = /\(([\d.]+) - ([\d.]+)%\)/.exec(r.desc);
          expect(m, r.desc).not.toBeNull();
          expect([r.minPct, r.maxPct], r.desc).toEqual([Number(m![1]), Number(m![2])]);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(6);
    expect(percentOfHp(164, 202)).toBe(81.1);
    expect(percentOfHp(201, 202)).toBe(99.5);
    expect(percentOfHp(1, 0)).toBe(0);
  });

  it('drops the spread modifier in Singles and applies field effects', () => {
    const singles = runCalc({ attacker: GARCHOMP, defender: INCINEROAR, moves: ['earthquake'], field: { doubles: false } }).results[0]!;
    expect(singles.max).toBeGreaterThan(164);
    expect(singles.spread).toBe(false);
    const screened = runCalc({ attacker: GARCHOMP, defender: INCINEROAR, moves: ['earthquake'], field: { doubles: true, defender: { reflect: true } } }).results[0]!;
    expect(screened.max).toBeLessThan(164);
    const intimidated = runCalc({ attacker: { ...GARCHOMP, boosts: { atk: -1 } }, defender: INCINEROAR, moves: ['earthquake'], field: { doubles: true } }).results[0]!;
    expect(intimidated.max).toBeLessThan(164);
  });

  it('resolves item and ability ids to the names the calc compares', () => {
    const plain = runCalc({ attacker: GARCHOMP, defender: INCINEROAR, moves: ['dragonclaw'], field: { doubles: true } }).results[0]!;
    const orb = runCalc({ attacker: { ...GARCHOMP, item: 'lifeorb' }, defender: INCINEROAR, moves: ['dragonclaw'], field: { doubles: true } }).results[0]!;
    expect(orb.max).toBeGreaterThan(plain.max);
  });

  it('reports unknown moves and Pokémon instead of throwing', () => {
    const res = runCalc({ attacker: GARCHOMP, defender: INCINEROAR, moves: ['notamove', 'protect'], field: { doubles: true } });
    expect(res.errors.map((e) => e.move)).toEqual(['notamove']);
    expect(res.results[0]).toMatchObject({ move: 'protect', max: 0, koN: 0 });
    const bad = runCalc({ attacker: { ...GARCHOMP, species: 'missingno' }, defender: INCINEROAR, moves: ['earthquake'], field: { doubles: true } });
    expect(bad.results).toEqual([]);
    expect(bad.errors[0]!.error).toMatch(/doesn't know/);
    expect(knowsSpecies('garchompmegaz')).toBe(true);
    expect(knowsSpecies('missingno')).toBe(false);
  });

  it('applies current HP', () => {
    const half = runCalc({ attacker: GARCHOMP, defender: { ...INCINEROAR, hpPercent: 50 }, moves: ['earthquake'], field: { doubles: true } }).results[0]!;
    expect(half.koN).toBe(1);
  });
});

describe('runMatrix', () => {
  it('keeps the best move per pair', () => {
    const res = runMatrix({
      attackers: [{ key: 'a', mon: GARCHOMP, moves: ['protect', 'dragonclaw', 'earthquake'] }],
      defenders: [
        { key: 'x', mon: INCINEROAR },
        { key: 'y', mon: { species: 'missingno', nature: 'Serious', sp: [0, 0, 0, 0, 0, 0] } },
      ],
      field: { doubles: true },
    });
    expect(res.pairs).toHaveLength(2);
    expect(res.pairs[0]!.best?.move).toBe('earthquake');
    expect(res.pairs[1]).toMatchObject({ best: null });
    expect(res.pairs[1]!.error).toBeTruthy();
  });

  it('orders results by hits to KO, then chance, then damage', () => {
    const r = (koN: number, koChance: number, maxPct: number) => ({ koN, koChance, maxPct }) as MoveResult;
    expect(betterResult(r(1, 0.5, 90), r(2, 1, 99))).toBe(true);
    expect(betterResult(r(0, 0, 40), r(4, 1, 30))).toBe(false);
    expect(betterResult(r(2, 1, 60), r(2, 0.5, 70))).toBe(true);
    expect(betterResult(r(0, 0, 40), r(0, 0, 30))).toBe(true);
  });
});
