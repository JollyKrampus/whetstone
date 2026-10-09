import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { parseData } from '../../core/schemas.ts';
import { repoRoot } from '../../lib/datadir.ts';
import * as load from './load.ts';
import {
  AbilitiesFileSchema,
  DexShardSchema,
  H2HSchema,
  ItemsFileSchema,
  LearnsetsSchema,
  MovesFileSchema,
  POKEMON_FILES,
  POKEMON_TYPES,
  PokemonMetaSchema,
  RegulationsFileSchema,
  SpeciesFileSchema,
  SpeedTiersSchema,
  SpSpreadSchema,
  TournamentsSchema,
  TypeChartSchema,
  UsageIndexSchema,
  UsageSchema,
} from './schema.ts';

const ROOT = repoRoot();
const FIXTURES = path.join(ROOT, 'fixtures', 'pokemon');
const CURATED = path.join(ROOT, 'curated', 'pokemon');
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));
function fixture<S extends z.ZodType>(schema: S, file: string): z.output<S> {
  return parseData(schema, readJson(path.join(FIXTURES, file)), `fixtures/pokemon/${file}`);
}

describe('pokemon fixtures match the schemas', () => {
  for (const [file, { schema }] of Object.entries(POKEMON_FILES)) {
    if (file.includes('<')) continue;
    it(file, () => expect(() => fixture(schema, file)).not.toThrow());
  }
  for (const entry of (readJson(path.join(FIXTURES, 'usage/index.json')) as { file: string }[])) {
    it(entry.file, () => expect(() => fixture(UsageSchema, entry.file)).not.toThrow());
  }
  it('marks every meta sample as synthetic', () => {
    for (const file of ['tournaments.json', 'h2h.json', 'speed.json', ...fixture(UsageIndexSchema, 'usage/index.json').map((e) => e.file)]) {
      expect((readJson(path.join(FIXTURES, file)) as { synthetic?: boolean }).synthetic, file).toBe(true);
    }
  });
});

describe('pokemon curated files match the schemas', () => {
  it('regulations.yaml validates and matches the fixture copy', () => {
    const regs = parseData(RegulationsFileSchema, parseYaml(fs.readFileSync(path.join(CURATED, 'regulations.yaml'), 'utf8')), 'curated/pokemon/regulations.yaml');
    expect(regs).toEqual(fixture(RegulationsFileSchema, 'regulations.json'));
    const mc = regs.regulations.find((r) => r.id === 'M-C');
    expect(mc?.start).toBe('2026-09-09T02:00:00Z');
    expect(mc?.end).toBe('2026-12-02T01:59:00Z');
    expect(mc?.formats).toEqual({ doubles: 'gen9championsvgc2026regmc', doublesBo3: 'gen9championsvgc2026regmcbo3', singles: 'gen9championsbssregmc' });
  });
});

describe('pokemon fixture cross-references', () => {
  const species = fixture(SpeciesFileSchema, 'dex/species.json');
  const speciesIds = new Set(species.map((s) => s.id));
  const moves = new Set(fixture(MovesFileSchema, 'dex/moves.json').map((m) => m.id));
  const items = fixture(ItemsFileSchema, 'dex/items.json');
  const itemIds = new Set(items.map((i) => i.id));
  const abilities = new Set(fixture(AbilitiesFileSchema, 'dex/abilities.json').map((a) => a.id));

  it('has ~20 species with their abilities and Mega stones defined', () => {
    expect(species.length).toBeGreaterThanOrEqual(20);
    for (const s of species) {
      for (const a of s.abilities) expect(abilities.has(a), `${s.id}: ${a}`).toBe(true);
      if (s.requiredItem) {
        const stone = items.find((i) => i.id === s.requiredItem);
        expect(stone?.mega, s.id).toEqual({ base: s.megaOf, forme: s.id });
      }
    }
    const chomp = species.find((s) => s.id === 'garchompmegaz');
    expect(chomp?.types).toEqual(['Dragon']);
    expect(chomp?.base).toEqual({ hp: 108, atk: 130, def: 85, spa: 141, spd: 85, spe: 151 });
    expect(species.find((s) => s.id === 'incineroar')?.base).toEqual({ hp: 95, atk: 115, def: 90, spa: 80, spd: 90, spe: 60 });
  });

  it('learnsets cover base species with known moves', () => {
    const learnsets = fixture(LearnsetsSchema, 'dex/learnsets.json');
    for (const [id, list] of Object.entries(learnsets)) {
      expect(speciesIds.has(id), id).toBe(true);
      for (const m of list) expect(moves.has(m), `${id}: ${m}`).toBe(true);
    }
    for (const s of species.filter((x) => !x.megaOf)) expect(learnsets[s.id], s.id).toBeDefined();
  });

  it('has a full 18 × 18 type chart', () => {
    const chart = fixture(TypeChartSchema, 'dex/typechart.json');
    expect(chart.types).toEqual([...POKEMON_TYPES]);
    expect(chart.damage.Ground.Flying).toBe(0);
    expect(chart.damage.Fairy.Dragon).toBe(2);
    expect(chart.damage.Fire.Water).toBe(0.5);
  });

  it('only references known species, moves, items and abilities in usage and tournaments', () => {
    for (const e of fixture(UsageIndexSchema, 'usage/index.json')) {
      for (const p of fixture(UsageSchema, e.file).pokemon) {
        expect(speciesIds.has(p.id), p.id).toBe(true);
        for (const x of p.moves) expect(moves.has(x.id), x.id).toBe(true);
        for (const x of p.items) expect(itemIds.has(x.id), x.id).toBe(true);
        for (const x of p.abilities) expect(abilities.has(x.id), x.id).toBe(true);
        for (const x of [...p.teammates, ...p.checks]) expect(speciesIds.has(x.id), x.id).toBe(true);
      }
    }
    const t = fixture(TournamentsSchema, 'tournaments.json');
    for (const team of t.teams) {
      for (const m of team.members) {
        expect(speciesIds.has(m.species)).toBe(true);
        for (const mv of m.moves) expect(moves.has(mv), mv).toBe(true);
        if (m.item) expect(itemIds.has(m.item)).toBe(true);
      }
      expect(new Set(team.members.map((m) => m.item)).size, 'item clause').toBe(team.members.length);
    }
    const h2h = fixture(H2HSchema, 'h2h.json');
    for (const e of [...h2h.counters, ...h2h.synergies]) expect(speciesIds.has(e.a) && speciesIds.has(e.b)).toBe(true);
  });

  it('computes speed tiers with the Champions formula', () => {
    for (const e of fixture(SpeedTiersSchema, 'speed.json').entries) {
      const s = species.find((x) => x.id === e.id);
      expect(e.base).toBe(s?.base.spe);
      expect(e.max).toBe(Math.floor((e.base + 32 + 20) * 1.1));
      expect(e.neutral).toBe(e.base + 20);
      expect(e.min).toBe(Math.floor((e.base + 20) * 0.9));
    }
  });

  it('ships a browser dex shard identical to the dex files', () => {
    const shard = fixture(DexShardSchema, 'public/dex.json');
    expect(shard.species).toEqual(species);
    expect(shard.learnsets).toEqual(fixture(LearnsetsSchema, 'dex/learnsets.json'));
    expect(shard.typechart).toEqual(fixture(TypeChartSchema, 'dex/typechart.json'));
  });

  it('meta extras point at the current regulation', () => {
    const meta = fixture(PokemonMetaSchema, 'meta.json');
    expect(meta.version.label).toBe('Reg M-C');
    expect(meta.extra.regulation).toBe('M-C');
    expect(meta.counts.species).toBe(species.length);
  });
});

describe('pokemon schema rejects bad data', () => {
  it('enforces Stat Point caps', () => {
    expect(SpSpreadSchema.safeParse([32, 32, 0, 0, 2, 0]).success).toBe(true);
    expect(SpSpreadSchema.safeParse([33, 0, 0, 0, 0, 0]).success).toBe(false);
    expect(SpSpreadSchema.safeParse([32, 32, 3, 0, 0, 0]).success).toBe(false);
  });

  it('rejects overlapping regulations and player names in tournament data', () => {
    const regs = readJson(path.join(FIXTURES, 'regulations.json')) as { regulations: { end: string }[] };
    const overlapping = { regulations: [{ ...regs.regulations[0], end: '2026-10-01T00:00:00Z' }, regs.regulations[1]] };
    expect(RegulationsFileSchema.safeParse(overlapping).success).toBe(false);
    const t = readJson(path.join(FIXTURES, 'tournaments.json')) as { teams: Record<string, unknown>[] };
    expect(TournamentsSchema.safeParse({ ...t, teams: [{ ...t.teams[0], player: 'someone' }] }).success).toBe(false);
  });
});

describe('pokemon load.ts against fixtures', () => {
  afterEach(() => load.clearPokemonCache());

  it('loads the dex and resolves the current regulation', () => {
    expect(load.getMeta().game).toBe('pokemon');
    expect(load.getSpecies().length).toBeGreaterThan(0);
    expect(load.getRegulations().length).toBeGreaterThan(0);
    expect(load.getCurrentRegulation().id).toBe('M-C');
    expect(load.getCurrentSeason()?.id).toBe('M-7');
    expect(load.getCurrentRegulation(new Date('2026-08-01T00:00:00Z')).id).toBe('M-B');
    expect(load.getCurrentRegulation(new Date('2027-03-01T00:00:00Z')).id).toBe('M-C');
    expect(load.getMegaFormes('garchomp').map((s) => s.id)).toEqual(['garchompmegaz']);
    expect(load.getBaseSpecies().some((s) => s.megaOf)).toBe(false);
    expect(load.getLearnset('garchompmegaz')).toEqual(load.getLearnset('garchomp'));
    expect(load.getLearnset('indeedeef')).toContain('followme');
    expect(load.getMove('fakeout')?.priority).toBe(3);
    expect(load.getItem('garchompitez')?.mega).toEqual({ base: 'garchomp', forme: 'garchompmegaz' });
    expect(load.getAbility('intimidate')?.name).toBe('Intimidate');
    expect(load.typeEffectiveness('Ice', ['Dragon', 'Ground'])).toBe(4);
    expect(load.typeEffectiveness('Ground', ['Fire', 'Flying'])).toBe(0);
    expect(load.getDefaultUsage()?.pokemon[0]?.id).toBe('rillaboom');
    expect(load.getUsage('gen9championsvgc2026regmc', 0)).toBeNull();
    expect(load.getTournaments()?.teams.length).toBeGreaterThan(0);
    expect(load.getH2H()?.counters.length).toBeGreaterThan(0);
    expect(load.getSpeedTiers()?.entries[0]?.speed).toBeGreaterThanOrEqual(load.getSpeedTiers()?.entries.at(-1)?.speed ?? 0);
    expect(load.getDexShard()?.regulation).toBe('M-C');
  });
});
