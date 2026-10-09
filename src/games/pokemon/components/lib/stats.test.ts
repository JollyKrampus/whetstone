import { describe, expect, it } from 'vitest';
import {
  checkSp,
  evToSp,
  finalStats,
  looksLikeEvs,
  modifiedSpeed,
  natureFor,
  natureLabel,
  natureMultiplier,
  setSp,
  spToEv,
  statValue,
} from './stats.ts';

const GARCHOMP = { hp: 108, atk: 130, def: 95, spa: 80, spd: 85, spe: 102 };
const INCINEROAR = { hp: 95, atk: 115, def: 90, spa: 80, spd: 90, spe: 60 };

describe('Champions stat formulas', () => {
  it('matches @smogon/calc gen 0 for a Jolly 2/32/0/0/0/32 Garchomp', () => {
    expect(finalStats(GARCHOMP, [2, 32, 0, 0, 0, 32], 'Jolly')).toEqual({ hp: 185, atk: 182, def: 115, spa: 90, spd: 105, spe: 169 });
  });

  it('matches @smogon/calc gen 0 for a Careful 32/0/2/0/32/0 Incineroar', () => {
    expect(finalStats(INCINEROAR, [32, 0, 2, 0, 32, 0], 'Careful')).toEqual({ hp: 202, atk: 135, def: 112, spa: 90, spd: 156, spe: 80 });
  });

  it('uses HP = base + SP + 75 and floors natured stats with integer maths', () => {
    expect(statValue('hp', 100, 10)).toBe(185);
    expect(statValue('spe', 130, 0, 'Timid')).toBe(165); // 150 × 1.1 = 165, not 164.99…
    expect(statValue('spe', 130, 23, 'Timid')).toBe(190);
    expect(statValue('spe', 130, 0, 'Brave')).toBe(135);
  });

  it('clamps out-of-range points', () => {
    expect(statValue('atk', 100, 40)).toBe(statValue('atk', 100, 32));
    expect(statValue('atk', 100, -3)).toBe(statValue('atk', 100, 0));
  });
});

describe('natures', () => {
  it('knows the multiplier per stat', () => {
    expect(natureMultiplier('Adamant', 'atk')).toBe(110);
    expect(natureMultiplier('Adamant', 'spa')).toBe(90);
    expect(natureMultiplier('Adamant', 'hp')).toBe(100);
    expect(natureMultiplier('Serious', 'spe')).toBe(100);
  });

  it('labels and inverts natures', () => {
    expect(natureLabel('Timid')).toBe('Timid (+Spe −Atk)');
    expect(natureLabel('Hardy')).toBe('Hardy (neutral)');
    expect(natureFor('spe', 'spa')).toBe('Jolly');
    expect(natureFor('atk', 'atk')).toBe('Serious');
    expect(natureFor(null, 'def')).toBe('Serious');
  });
});

describe('Stat Point budget', () => {
  it('validates 32 per stat and 66 total', () => {
    expect(checkSp([32, 32, 0, 0, 2, 0]).ok).toBe(true);
    expect(checkSp([33, 0, 0, 0, 0, 0]).badStats).toEqual([0]);
    const over = checkSp([32, 32, 3, 0, 0, 0]);
    expect(over.ok).toBe(false);
    expect(over.overTotal).toBe(true);
    expect(over.total).toBe(67);
  });

  it('setSp clamps to the remaining budget', () => {
    expect(setSp([32, 32, 0, 0, 0, 0], 5, 32)).toEqual([32, 32, 0, 0, 0, 2]);
    expect(setSp([0, 0, 0, 0, 0, 0], 1, 50)).toEqual([0, 32, 0, 0, 0, 0]);
    expect(setSp([10, 0, 0, 0, 0, 0], 0, -4)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe('EV → Stat Point conversion (HOME rule)', () => {
  it('gives the first point at 4 EVs and one per 8 after', () => {
    expect([0, 3, 4, 11, 12, 20, 244, 252].map(evToSp)).toEqual([0, 0, 1, 1, 2, 3, 31, 32]);
  });

  it('never exceeds 66 for a legal 510-EV spread', () => {
    const spread = [252, 252, 4, 0, 0, 2].map(evToSp);
    expect(spread).toEqual([32, 32, 1, 0, 0, 0]);
    expect([85, 85, 85, 85, 85, 85].map(evToSp).reduce((a, b) => a + b)).toBe(66);
  });

  it('spToEv is the cheapest EV count for a point total', () => {
    for (let sp = 0; sp <= 32; sp++) expect(evToSp(spToEv(sp))).toBe(sp);
  });

  it('detects EV-style lines', () => {
    expect(looksLikeEvs([252, 4, 0, 0, 0, 252])).toBe(true);
    expect(looksLikeEvs([20, 20, 20, 10, 0, 0])).toBe(true);
    expect(looksLikeEvs([32, 32, 0, 0, 2, 0])).toBe(false);
  });
});

describe('speed modifiers', () => {
  it('applies stages, Scarf, Tailwind and paralysis in simulator order', () => {
    expect(modifiedSpeed(169)).toBe(169);
    expect(modifiedSpeed(169, { scarf: true })).toBe(253);
    expect(modifiedSpeed(169, { tailwind: true })).toBe(338);
    expect(modifiedSpeed(169, { scarf: true, tailwind: true })).toBe(506);
    expect(modifiedSpeed(169, { paralysis: true })).toBe(84);
    expect(modifiedSpeed(100, { stage: -1 })).toBe(66);
    expect(modifiedSpeed(100, { stage: 1 })).toBe(150);
  });
});
