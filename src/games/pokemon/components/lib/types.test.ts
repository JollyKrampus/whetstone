import { describe, expect, it } from 'vitest';
import {
  attackMoves,
  bestAgainst,
  defenseProfile,
  effectiveness,
  groupDefense,
  multiplierLabel,
  sharedWeaknesses,
  teamCoverage,
  teamDefenseMatrix,
} from './types.ts';
import { fixtureShard } from './testdex.ts';

const chart = fixtureShard().typechart;

describe('effectiveness', () => {
  it('multiplies dual types', () => {
    expect(effectiveness(chart, 'Ice', ['Dragon', 'Ground'])).toBe(4);
    expect(effectiveness(chart, 'Ground', ['Fire', 'Flying'])).toBe(0);
    expect(effectiveness(chart, 'Fire', ['Fire', 'Dragon'])).toBe(0.25);
    expect(effectiveness(chart, 'Fairy', ['Dark', 'Steel'])).toBe(1);
  });
});

describe('defenseProfile', () => {
  it('applies Levitate as a labelled adjustment', () => {
    const cells = defenseProfile(chart, ['Dragon'], 'levitate');
    const ground = cells.find((c) => c.type === 'Ground')!;
    expect(ground).toEqual({ type: 'Ground', multiplier: 0, byAbility: true });
    expect(cells.find((c) => c.type === 'Ice')!.multiplier).toBe(2);
  });

  it('groups weaknesses strongest first and immunities last', () => {
    const groups = groupDefense(defenseProfile(chart, ['Dragon', 'Flying']));
    expect(groups[0]).toMatchObject({ multiplier: 4, label: '×4' });
    expect(groups[0]!.cells.map((c) => c.type)).toEqual(['Ice']);
    expect(groups.at(-1)).toMatchObject({ multiplier: 0, label: '×0' });
  });

  it('labels multipliers', () => {
    expect([4, 2, 1, 0.5, 0.25, 0, 1.25].map(multiplierLabel)).toEqual(['×4', '×2', '×1', '×½', '×¼', '×0', '×1.25']);
  });
});

describe('team matrix and coverage', () => {
  const members = [
    { id: 'a', name: 'Garchomp', types: ['Dragon', 'Ground'] as const },
    { id: 'b', name: 'Salamence', types: ['Dragon', 'Flying'] as const },
    { id: 'c', name: 'Kingambit', types: ['Dark', 'Steel'] as const },
  ];

  it('counts weak, resist and immune members per attacking type', () => {
    const rows = teamDefenseMatrix(chart, members);
    const ice = rows.find((r) => r.type === 'Ice')!;
    expect(ice).toMatchObject({ weak: 2, resist: 1, immune: 0 });
    const ground = rows.find((r) => r.type === 'Ground')!;
    expect(ground.immune).toBe(1);
    const dragon = rows.find((r) => r.type === 'Dragon')!;
    expect(sharedWeaknesses(rows).map((r) => r.type)).not.toContain('Ice');
    expect(dragon.weak).toBe(2);
  });

  it('finds the best multiplier per defending type and turns -ate Normal moves', () => {
    const moves = attackMoves(
      'b',
      [
        { id: 'hypervoice', name: 'Hyper Voice', type: 'Normal', category: 'Special', basePower: 90 },
        { id: 'protect', name: 'Protect', type: 'Normal', category: 'Status', basePower: 0 },
      ],
      ['Dragon', 'Flying'],
      'aerilate',
    );
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ type: 'Flying', stab: true });
    const cov = teamCoverage(chart, moves);
    expect(cov.find((c) => c.type === 'Grass')!.best).toBe(2);
    expect(cov.find((c) => c.type === 'Rock')!.best).toBe(0.5);
    expect(bestAgainst(chart, moves, ['Grass', 'Fairy'])).toBe(2);
    expect(bestAgainst(chart, moves, ['Bug'], 'levitate')).toBe(2);
  });
});
