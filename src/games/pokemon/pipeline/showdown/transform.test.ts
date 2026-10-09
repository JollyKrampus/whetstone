import { describe, expect, it } from 'vitest';
import { validateFiles } from '../../../../../pipeline/validate.ts';
import { POKEMON_FILES, POKEMON_TYPES, SpeciesFileSchema } from '../../schema.ts';
import { ROOT } from '../test-support.ts';
import { RawDexExportSchema, type RawDexExport } from './raw.ts';
import { dexOutputs, readRecordedExport } from './source.ts';
import { transformDex } from './transform.ts';

const raw = readRecordedExport(ROOT);
const t = transformDex(raw);
const byId = new Map(t.files.species.map((s) => [s.id, s]));

describe('recorded export', () => {
  it('is a real Champions export with M-B and M-C formats', () => {
    expect(RawDexExportSchema.safeParse(raw).success).toBe(true);
    expect(raw.dataRegulation).toBe('M-C');
    expect(raw.dataMod).toBe('champions');
    expect(raw.regulations.map((r) => [r.id, r.exists])).toEqual([
      ['M-B', true],
      ['M-C', true],
    ]);
  });
});

describe('transformDex', () => {
  it('produces dex files and a shard that pass the registry schemas', () => {
    expect(t.warnings).toEqual([]);
    expect(validateFiles(dexOutputs(t.files, 'M-C'), POKEMON_FILES)).toEqual([]);
    expect(SpeciesFileSchema.safeParse(t.files.species).success).toBe(true);
  });

  it('links Megas to their base species and stones, Z Megas included', () => {
    const z = byId.get('garchompmegaz');
    expect(z).toMatchObject({ name: 'Garchomp-Mega-Z', megaOf: 'garchomp', requiredItem: 'garchompitez', types: ['Dragon'], legal: ['M-C'] });
    expect(z?.base).toEqual({ hp: 108, atk: 130, def: 85, spa: 141, spd: 85, spe: 151 });
    expect(byId.get('garchomp')?.megas).toContain('garchompmegaz');
    const stone = t.files.items.find((i) => i.id === 'garchompitez');
    expect(stone?.mega).toEqual({ base: 'garchomp', forme: 'garchompmegaz' });
    // Megas have no learnset of their own (they use the base species').
    expect(t.files.learnsets.garchompmegaz).toBeUndefined();
    expect(t.files.learnsets.garchomp?.length).toBeGreaterThan(0);
  });

  it('marks legality per regulation (M-C added Rillaboom)', () => {
    expect(byId.get('rillaboom')?.legal).toEqual(['M-C']);
    expect(byId.get('incineroar')?.legal).toEqual(['M-B', 'M-C']);
    expect(t.legalCounts['M-C']?.species).toBeGreaterThan(t.legalCounts['M-B']?.species ?? 0);
  });

  it('keeps Champions move data (PP rules, rebalanced moves)', () => {
    const protect = t.files.moves.find((m) => m.id === 'protect');
    expect(protect).toMatchObject({ pp: 8, priority: 4, category: 'Status', accuracy: true });
    const fakeout = t.files.moves.find((m) => m.id === 'fakeout');
    expect(fakeout?.flags).toEqual([...(fakeout?.flags ?? [])].sort());
  });

  it('builds the full 18 × 18 type chart from Showdown damage codes', () => {
    const chart = t.files.typechart;
    expect(chart.types).toEqual([...POKEMON_TYPES]);
    expect(chart.damage.Ground.Flying).toBe(0);
    expect(chart.damage.Fire.Grass).toBe(2);
    expect(chart.damage.Fire.Water).toBe(0.5);
    expect(chart.damage.Fairy.Dragon).toBe(2);
    expect(chart.damage.Dragon.Fairy).toBe(0);
    expect(chart.damage.Normal.Normal).toBe(1);
  });

  it('is sorted and deterministic', () => {
    for (const list of [t.files.species, t.files.moves, t.files.items, t.files.abilities]) {
      const ids = list.map((x) => x.id);
      expect(ids).toEqual([...ids].sort());
    }
    expect(transformDex(structuredClone(raw)).files).toEqual(t.files);
  });

  it('skips entries it cannot represent and fails loudly on a broken type chart', () => {
    const broken: RawDexExport = structuredClone(raw);
    const first = broken.species[0]!;
    broken.species[0] = { ...first, types: ['Stellar'] };
    const out = transformDex(broken);
    expect(out.warnings[0]).toMatch(/unknown type/);
    expect(out.files.species.some((s) => s.id === first.id)).toBe(false);

    const noChart: RawDexExport = { ...structuredClone(raw), types: [] };
    expect(() => transformDex(noChart)).toThrow(/type chart/);
  });
});
