/**
 * Build-time loaders for Pokémon Champions data: the only place pages read Pokémon files
 * (SPEC §3). Node-only (fs through src/lib/datadir.ts). Every read is zod-validated (errors
 * name the file) and memoized. Ids are Showdown toIDs.
 */
import path from 'node:path';
import { createCachedLoader } from '../../core/schemas.ts';
import { gameDataDir, readGameJson, usingFixtures } from '../../lib/datadir.ts';
import {
  AbilitiesFileSchema,
  DexShardSchema,
  H2HSchema,
  ItemsFileSchema,
  LearnsetsSchema,
  MovesFileSchema,
  PokemonMetaSchema,
  RegulationsFileSchema,
  SpeciesFileSchema,
  SpeedTiersSchema,
  TournamentsSchema,
  TypeChartSchema,
  UsageIndexSchema,
  UsageSchema,
  usageFile,
  type Cutoff,
  type DexShard,
  type H2H,
  type Item,
  type Learnsets,
  type Move,
  type PokemonAbility,
  type PokemonMeta,
  type PokemonType,
  type Regulation,
  type Species,
  type SpeedTiers,
  type Tournaments,
  type TypeChart,
  type Usage,
  type UsageIndex,
} from './schema.ts';

const GAME = 'pokemon';

const data = createCachedLoader({
  read: (file, { optional }) => readGameJson(GAME, file, { optional }),
  where: (file) => path.join(gameDataDir(GAME), file),
});

const derived = new Map<string, unknown>();
function memo<T>(key: string, make: () => T): T {
  if (!derived.has(key)) derived.set(key, make());
  return derived.get(key) as T;
}

/** Drops cached files and indexes (tests, dev-server reloads). */
export function clearPokemonCache(): void {
  data.clear();
  derived.clear();
}

export function getMeta(): PokemonMeta {
  return data.required('meta.json', PokemonMetaSchema);
}

// ---- regulations -----------------------------------------------------------------------

/** Sorted by start. */
export function getRegulations(): Regulation[] {
  return data.required('regulations.json', RegulationsFileSchema).regulations;
}

export function getRegulation(id: string): Regulation | undefined {
  return getRegulations().find((r) => r.id === id);
}

/** The data snapshot time for fixtures (frozen), the wall clock otherwise. */
function clock(now?: Date): number {
  if (now) return now.getTime();
  return usingFixtures(GAME) ? Date.parse(getMeta().generatedAt) : Date.now();
}

/**
 * Regulation in force at `now`; between windows (or after the last one) the latest one that
 * has started, so the site keeps showing the most recent rules.
 */
export function getCurrentRegulation(now?: Date): Regulation {
  const t = clock(now);
  const regs = getRegulations();
  const inWindow = regs.find((r) => Date.parse(r.start) <= t && t <= Date.parse(r.end) + 59_999);
  const started = regs.filter((r) => Date.parse(r.start) <= t);
  const pick = inWindow ?? started.at(-1) ?? regs[0];
  if (!pick) throw new Error(`No regulations in ${path.join(gameDataDir(GAME), 'regulations.json')}`);
  return pick;
}

export function getCurrentSeason(now?: Date): Regulation['seasons'][number] | undefined {
  const t = clock(now);
  return getCurrentRegulation(now).seasons.find((s) => Date.parse(s.start) <= t && t <= Date.parse(s.end) + 59_999);
}

// ---- dex -------------------------------------------------------------------------------

/** Sorted by id. */
export function getSpecies(): Species[] {
  return data.required('dex/species.json', SpeciesFileSchema);
}

export function getSpeciesById(id: string): Species | undefined {
  return memo('species', () => new Map(getSpecies().map((s) => [s.id, s]))).get(id);
}

/** Species/formes legal in a regulation (default: the current one). */
export function getLegalSpecies(regulationId: string = getCurrentRegulation().id): Species[] {
  return getSpecies().filter((s) => s.legal.includes(regulationId));
}

/** Base species only (no Mega formes): one page per Pokémon, Megas shown as tabs. */
export function getBaseSpecies(): Species[] {
  return getSpecies().filter((s) => !s.megaOf);
}

export function getMegaFormes(baseId: string): Species[] {
  return getSpecies().filter((s) => s.megaOf === baseId);
}

export function getMoves(): Move[] {
  return data.required('dex/moves.json', MovesFileSchema);
}

export function getMove(id: string): Move | undefined {
  return memo('moves', () => new Map(getMoves().map((m) => [m.id, m]))).get(id);
}

export function getItems(): Item[] {
  return data.required('dex/items.json', ItemsFileSchema);
}

export function getItem(id: string): Item | undefined {
  return memo('items', () => new Map(getItems().map((i) => [i.id, i]))).get(id);
}

export function getAbilities(): PokemonAbility[] {
  return data.required('dex/abilities.json', AbilitiesFileSchema);
}

export function getAbility(id: string): PokemonAbility | undefined {
  return memo('abilities', () => new Map(getAbilities().map((a) => [a.id, a]))).get(id);
}

export function getTypeChart(): TypeChart {
  return data.required('dex/typechart.json', TypeChartSchema);
}

/** Damage multiplier of an attacking type against a defender's types (0, 0.25 .. 4). */
export function typeEffectiveness(attack: PokemonType, defender: readonly PokemonType[]): number {
  const row = getTypeChart().damage[attack];
  return defender.reduce((m, t) => m * row[t], 1);
}

export function getLearnsets(): Learnsets {
  return data.required('dex/learnsets.json', LearnsetsSchema);
}

/** Legal move ids; formes without their own entry (Megas) use their base species' list. */
export function getLearnset(speciesId: string): string[] {
  const sets = getLearnsets();
  const own = sets[speciesId];
  if (own) return own;
  const s = getSpeciesById(speciesId);
  const base = s?.megaOf ?? (s?.baseSpecies ? s.baseSpecies.toLowerCase().replace(/[^a-z0-9]/g, '') : undefined);
  return (base && sets[base]) || [];
}

/** Browser shard for the builder/calc/preview islands. */
export function getDexShard(): DexShard | null {
  return data.optional('public/dex.json', DexShardSchema);
}

// ---- meta: usage, tournaments, replays, speed ------------------------------------------

/** Available Smogon usage files; empty before the first month of a regulation is published. */
export function getUsageIndex(): UsageIndex {
  return data.optional('usage/index.json', UsageIndexSchema) ?? [];
}

export function getUsage(format: string, cutoff: Cutoff): Usage | null {
  if (!getUsageIndex().some((e) => e.format === format && e.cutoff === cutoff)) return null;
  return data.required(usageFile(format, cutoff), UsageSchema);
}

/**
 * Usage for the current regulation's doubles format at the highest cutoff available, or null
 * ("data warming up" right after a regulation change).
 */
export function getDefaultUsage(now?: Date): Usage | null {
  const reg = getCurrentRegulation(now);
  const entries = getUsageIndex()
    .filter((e) => e.regulation === reg.id && e.format === reg.formats.doubles)
    .sort((a, b) => b.cutoff - a.cutoff);
  const top = entries[0];
  return top ? getUsage(top.format, top.cutoff) : null;
}

/** Limitless aggregates (no player names). Credit `attribution` next to the data. */
export function getTournaments(): Tournaments | null {
  return data.optional('tournaments.json', TournamentsSchema);
}

/** Head-to-head edges mined from public Bo3 replays. */
export function getH2H(): H2H | null {
  return data.optional('h2h.json', H2HSchema);
}

export function getSpeedTiers(): SpeedTiers | null {
  return data.optional('speed.json', SpeedTiersSchema);
}
