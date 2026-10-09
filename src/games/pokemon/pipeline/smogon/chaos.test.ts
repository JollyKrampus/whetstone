import { describe, expect, it } from 'vitest';
import { UsageSchema, type Item, type Species } from '../../schema.ts';
import { dexIndex } from '../ids.ts';
import { CHECK_MIN_N, ChaosSchema, chaosToUsage, evToSp, monthLabel, parseSpread, TOP, type ChaosContext } from './chaos.ts';

const stub = { base: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, abilities: ['x'], weightkg: 1, legal: ['M-C'] };
const species: Species[] = [
  { ...stub, id: 'rillaboom', name: 'Rillaboom', num: 812, types: ['Grass'] },
  { ...stub, id: 'incineroar', name: 'Incineroar', num: 727, types: ['Fire', 'Dark'] },
  { ...stub, id: 'salamence', name: 'Salamence', num: 373, types: ['Dragon', 'Flying'] },
  { ...stub, id: 'salamencemega', name: 'Salamence-Mega', num: 373, types: ['Dragon', 'Flying'], megaOf: 'salamence', requiredItem: 'salamencite' },
  { ...stub, id: 'vivillon', name: 'Vivillon', num: 666, types: ['Bug', 'Flying'], cosmeticFormes: ['vivillonmarine'] },
];
const items: Item[] = [
  { id: 'miracleseed', name: 'Miracle Seed', legal: ['M-C'] },
  { id: 'sitrusberry', name: 'Sitrus Berry', legal: ['M-C'] },
  { id: 'salamencite', name: 'Salamencite', legal: ['M-C'], mega: { base: 'salamence', forme: 'salamencemega' } },
];
const ctx: ChaosContext = {
  regulation: 'M-C',
  format: 'gen9championsvgc2026regmc',
  cutoff: 1760,
  month: '2026-09',
  dex: dexIndex(species, items),
  moves: new Set(['fakeout', 'grassyglide', 'woodhammer', 'protect', ...Array.from({ length: 12 }, (_, i) => `move${i}`)]),
  items: new Set(items.map((i) => i.id)),
  abilities: new Set(['grassysurge', 'overgrow']),
};

describe('Stat Point spreads', () => {
  it('converts EVs with the HOME rule', () => {
    expect([0, 3, 4, 11, 12, 20, 252].map(evToSp)).toEqual([0, 0, 1, 1, 2, 3, 32]);
  });

  it('reads Champions spreads as Stat Points and converts EV-shaped ones', () => {
    expect(parseSpread('Adamant:32/32/0/0/2/0')).toEqual({ nature: 'Adamant', sp: [32, 32, 0, 0, 2, 0] });
    expect(parseSpread('jolly:2/32/0/0/0/32')).toEqual({ nature: 'Jolly', sp: [2, 32, 0, 0, 0, 32] });
    expect(parseSpread('Timid:4/0/0/252/0/252')).toEqual({ nature: 'Timid', sp: [1, 0, 0, 32, 0, 32] });
    expect(parseSpread('Nope:1/1/1/1/1/1')).toBeNull();
    expect(parseSpread('Adamant:32/32/32')).toBeNull();
  });

  it('labels months', () => {
    expect(monthLabel('2026-09')).toBe('September 2026');
  });
});

describe('chaosToUsage', () => {
  const chaos = ChaosSchema.parse({
    info: { metagame: 'gen9championsvgc2026regmc', cutoff: 1760, 'number of battles': 1631943 },
    data: {
      Rillaboom: {
        usage: 0.4659939,
        'Raw count': 1410840,
        Abilities: { grassysurge: 997.6, overgrow: 2.4 },
        Items: { miracleseed: 625, sitrusberry: 95.7, unknownitem: 50 },
        Moves: { fakeout: 986.5, grassyglide: 986.5, woodhammer: 852.3, protect: 147.4, '': 3, ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`move${i}`, 10 - i / 2])) },
        Spreads: { 'Adamant:32/32/0/0/2/0': 400, 'Adamant:32/32/0/0/0/2': 100, 'Jolly:4/252/0/0/0/252': 50, 'Odd:0/0/0/0/0/0': 10 },
        Teammates: { Incineroar: 409.9, 'Salamence-Mega': 341.9, Rillaboom: 5, Missingno: 3 },
        'Checks and Counters': {
          Incineroar: { n: 34.1, p: 0.4507, d: 0.0852 },
          'Salamence-Mega': [50, 0.6, 0.05],
          Vivillon: { n: CHECK_MIN_N - 1, p: 0.9, d: 0.01 },
        },
        'Tera Types': { nothing: 1000 },
      },
      'Salamence-Mega': {
        usage: 0.28,
        'Raw count': 900000,
        Abilities: { aerilate: 1 },
        Items: { salamencite: 1 },
        Moves: {},
        Spreads: {},
        Teammates: {},
        'Checks and Counters': {},
      },
      'Vivillon-Marine': {
        usage: 0.01,
        'Raw count': 1000,
        Abilities: { shielddust: 1 },
        Items: {},
        Moves: {},
        Spreads: {},
        Teammates: {},
        'Checks and Counters': {},
      },
      Missingno: { usage: 0.5, 'Raw count': 1, Abilities: {}, Items: {}, Moves: {}, Spreads: {}, Teammates: {}, 'Checks and Counters': {} },
    },
  });
  const { usage, unknown } = chaosToUsage(chaos, ctx);

  it('produces a valid, ranked usage file with attribution', () => {
    expect(UsageSchema.safeParse(usage).success).toBe(true);
    expect(usage.pokemon.map((p) => [p.id, p.rank])).toEqual([
      ['rillaboom', 1],
      ['salamencemega', 2],
      ['vivillon', 3],
    ]);
    expect(usage).toMatchObject({ source: 'smogon', regulation: 'M-C', format: 'gen9championsvgc2026regmc', cutoff: 1760, month: '2026-09', battles: 1631943 });
    expect(usage.attribution.text).toContain('September 2026');
    expect(usage.attribution.url).toBe('https://www.smogon.com/stats/2026-09/');
    expect(unknown).toEqual(['Missingno']);
  });

  it('normalises weights by the species total and keeps the top K', () => {
    const r = usage.pokemon[0]!;
    expect(r.usage).toBeCloseTo(0.465994, 6);
    expect(r.abilities).toEqual([
      { id: 'grassysurge', share: 0.9976 },
      { id: 'overgrow', share: 0.0024 },
    ]);
    // Unknown items are dropped, not renormalised away.
    expect(r.items).toEqual([
      { id: 'miracleseed', share: 0.625 },
      { id: 'sitrusberry', share: 0.0957 },
    ]);
    expect(r.moves).toHaveLength(TOP.moves);
    // Ties sort by id.
    expect(r.moves.slice(0, 2).map((m) => m.id)).toEqual(['fakeout', 'grassyglide']);
    expect(r.teammates.map((t) => t.id)).toEqual(['incineroar', 'salamencemega']);
  });

  it('keeps legal SP spreads, converting EV-shaped ones and dropping the rest', () => {
    const r = usage.pokemon[0]!;
    expect(r.spreads).toEqual([
      { nature: 'Adamant', sp: [32, 32, 0, 0, 2, 0], share: 0.4 },
      { nature: 'Adamant', sp: [32, 32, 0, 0, 0, 2], share: 0.1 },
      { nature: 'Jolly', sp: [1, 32, 0, 0, 0, 32], share: 0.05 },
    ]);
  });

  it('keeps checks with n ≥ 20 ranked by p − 4d, accepting both chaos encodings', () => {
    const r = usage.pokemon[0]!;
    expect(r.checks).toEqual([
      { id: 'salamencemega', n: 50, p: 0.6, d: 0.05 },
      { id: 'incineroar', n: 34.1, p: 0.4507, d: 0.0852 },
    ]);
  });

  it('folds cosmetic formes into their species', () => {
    expect(usage.pokemon.find((p) => p.id === 'vivillon')?.raw).toBe(1000);
  });
});
