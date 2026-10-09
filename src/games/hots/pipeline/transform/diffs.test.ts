import { describe, expect, it } from 'vitest';
import { DiffsFileSchema } from '../../schema.ts';
import { FIXTURE_NOW, fixtureRelease, testCurated } from '../test-helpers.ts';
import { diffModels, fieldNear, lastChangedBuilds, mergeDiffs, textEntries } from './diffs.ts';
import { buildHeroes } from './heroes.ts';

const models = (build: '2.55.17.98025' | '2.57.0.98285' | '2.57.0.98348') =>
  buildHeroes(fixtureRelease(build, false), { aliases: testCurated().aliases, now: FIXTURE_NOW }).models;

describe('textEntries', () => {
  it('pairs numbers when only numbers changed, labelled by the nearest stat word', () => {
    const e = textEntries('ability', 'Void Volley', 'Unleash 6 missiles that deal 90 damage each.', 'Unleash 6 missiles that deal 72 damage each.');
    expect(e).toEqual([{ kind: 'ability', target: 'Void Volley', field: 'damage', old: 90, new: 72 }]);
  });

  it('keeps percentages as strings and labels seconds by their effect', () => {
    expect(textEntries('talent', 'Anchored Core', 'Radius increased by 50%.', 'Radius increased by 25%.', '1')).toEqual([
      { kind: 'talent', target: 'Anchored Core', level: '1', field: 'radius', old: '50%', new: '25%' },
    ]);
    expect(fieldNear('Silence enemies for 2 seconds.', 0)).toBe('silence');
    expect(fieldNear('After 1.5 seconds, explode.', 0)).toBe('delay');
  });

  it('never pairs the per-level scaling percentages as numbers', () => {
    expect(textEntries('ability', 'X', 'Deal 10 (+4% per level) damage.', 'Deal 12 (+4% per level) damage.')).toEqual([
      { kind: 'ability', target: 'X', field: 'damage', old: 10, new: 12 },
    ]);
    // Only the annotation changed: reported as a text change with both full tooltips.
    expect(textEntries('ability', 'X', 'Deal 10 (+4% per level) damage.', 'Deal 10 damage.')).toEqual([
      { kind: 'ability', target: 'X', field: 'text', old: 'Deal 10 (+4% per level) damage.', new: 'Deal 10 damage.' },
    ]);
  });

  it('reports only the reworded sentences, and still pairs numbers around them', () => {
    const e = textEntries('ability', 'X', 'Stuns for 1 second. Deals 90 damage.', 'Roots for 1 second. Deals 72 damage.');
    expect(e).toEqual([
      { kind: 'ability', target: 'X', field: 'text', old: 'Stuns for 1 second.', new: 'Roots for 1 second.' },
      { kind: 'ability', target: 'X', field: 'damage', old: 90, new: 72 },
    ]);
    const added = textEntries('talent', 'Y', 'Gain 10 Armor.', 'Gain 10 Armor. Lasts 2 seconds.', '4');
    expect(added).toEqual([{ kind: 'talent', target: 'Y', level: '4', field: 'text', new: 'Lasts 2 seconds.' }]);
  });
});

describe('diffModels on recorded releases', () => {
  const d285 = diffModels('2.55.17.98025', '2.57.0.98285', models('2.55.17.98025'), models('2.57.0.98285'), '2026-09-28');
  const d348 = diffModels('2.57.0.98285', '2.57.0.98348', models('2.57.0.98285'), models('2.57.0.98348'));

  it('lists a new hero as added abilities', () => {
    expect(d285.heroes.HXAL?.every((e) => e.kind === 'ability-added')).toBe(true);
    expect(d285.heroes.HXAL?.length).toBeGreaterThan(4);
  });

  it('finds the 2.57 base health and talent changes', () => {
    expect(d285.heroes.Alex).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'stat', target: 'Health', old: 1698, new: 1780 })]));
    expect(d285.heroes.Abat?.some((e) => e.target === 'Survival Instincts')).toBe(true);
  });

  it('finds the 10/5 hotfix numbers for Xal\'atath', () => {
    const x = d348.heroes.HXAL ?? [];
    expect(x).toEqual(expect.arrayContaining([expect.objectContaining({ target: 'Void Volley', old: 90, new: 72 })]));
    expect(d348.heroes.Abat).toBeUndefined();
  });

  it('validates as diffs.json and merges newest first', () => {
    const merged = mergeDiffs([d285], [d348, d285]);
    expect(merged.map((d) => d.id)).toEqual(['2.57.0.98285..2.57.0.98348', '2.55.17.98025..2.57.0.98285']);
    expect(DiffsFileSchema.safeParse(merged).success).toBe(true);
    const last = lastChangedBuilds(merged);
    expect(last.get('HXAL')).toBe('2.57.0.98348');
    expect(last.get('Alex')).toBe('2.57.0.98285');
  });
});
