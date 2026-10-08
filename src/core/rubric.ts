import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { configDir, packageRoot } from '../data/paths.js';

const tiers = z.array(z.object({ tier: z.number(), label: z.string(), min: z.number() })).min(1);
const karsten = z.object({
  deckSize: z.number(),
  table: z.record(z.string(), z.record(z.string(), z.number())),
});
const manaBase = z.object({
  coverageWeight: z.number(),
  landCountWeight: z.number(),
  tappedWeight: z.number(),
  shortfallPenalty: z.number(),
  landTolerance: z.number(),
  pointsPerLandOff: z.number(),
  freeTappedLands: z.number(),
  pointsPerTappedLand: z.number(),
});
const interaction = z.object({ volumeWeight: z.number(), cheapWeight: z.number(), cheapMaxMv: z.number() });
const cardQuality = z.object({
  meta: z.object({ inMetaBase: z.number(), inMetaRateBonus: z.number() }),
  heuristic: z.object({
    popularityWeight: z.number(),
    rarityWeight: z.number(),
    recencyWeight: z.number(),
    popularityBest: z.number(),
    popularityWorst: z.number(),
    recencyFullYears: z.number(),
    recencyZeroYears: z.number(),
    rarityValue: z.object({ common: z.number(), uncommon: z.number(), rare: z.number(), mythic: z.number() }),
  }),
});
const archetype = z.object({
  avgMv: z.number(),
  lowDropShare: z.number(),
  lands: z.number(),
  interaction: z.number(),
  maxTopEnd: z.number(),
});

export const constructedRubricSchema = z.object({
  name: z.string(),
  tiers,
  weights: z.object({
    manaBase: z.number(),
    speed: z.number(),
    interaction: z.number(),
    cardQuality: z.number(),
    consistency: z.number(),
  }),
  karsten,
  archetypes: z.object({ aggro: archetype, midrange: archetype, control: archetype, ramp: archetype }),
  inference: z.object({
    ramp: z.object({ minRamp: z.number() }),
    control: z.object({ minInteraction: z.number(), maxCreatures: z.number() }),
    aggro: z.object({ maxAvgMv: z.number(), minCreatures: z.number() }),
  }),
  manaBase,
  speed: z.object({
    avgMvWeight: z.number(),
    lowDropWeight: z.number(),
    topEndWeight: z.number(),
    pointsPerMvOver: z.number(),
    pointsPerExtraTopEnd: z.number(),
  }),
  interaction,
  cardQuality,
  consistency: z.object({
    simulationWeight: z.number(),
    structureWeight: z.number(),
    keepableTarget: z.number(),
    landDropTarget: z.number(),
    colorTarget: z.number(),
    fourOfTarget: z.number(),
    freeSingletons: z.number(),
    pointsPerSingleton: z.number(),
    simulationIterations: z.number().int().positive(),
    simulationSeed: z.number().int(),
  }),
});

export const brawlRubricSchema = z.object({
  name: z.string(),
  tiers,
  weights: z.object({
    manaBase: z.number(),
    commanderSynergy: z.number(),
    ramp: z.number(),
    cardDraw: z.number(),
    interaction: z.number(),
    cardQuality: z.number(),
  }),
  karsten,
  targetsPer100: z.object({ lands: z.number(), ramp: z.number(), cardDraw: z.number(), interaction: z.number() }),
  manaBase,
  interaction,
  commanderSynergy: z.object({ targetShare: z.number(), themes: z.record(z.string(), z.string()) }),
  cardQuality,
});

export type ConstructedRubric = z.infer<typeof constructedRubricSchema>;
export type BrawlRubric = z.infer<typeof brawlRubricSchema>;
export type KarstenTable = z.infer<typeof karsten>;
export type Archetype = keyof ConstructedRubric['archetypes'];

/**
 * Rubric files are read from `<config dir>/rubric/` when present (so users can tune them
 * without touching the package), else from the package's own `rubric/` folder.
 */
function rubricPath(file: string): string {
  const override = path.join(configDir(), 'rubric', file);
  return existsSync(override) ? override : path.join(packageRoot(), 'rubric', file);
}

const cache = new Map<string, unknown>();

function load<T>(file: string, schema: z.ZodType<T>): T {
  const p = rubricPath(file);
  if (cache.has(p)) return cache.get(p) as T;
  const parsed = schema.safeParse(JSON.parse(readFileSync(p, 'utf8')));
  if (!parsed.success) throw new Error(`Invalid rubric ${p}: ${parsed.error.message}`);
  cache.set(p, parsed.data);
  return parsed.data;
}

export const constructedRubric = () => load('power-rubric.json', constructedRubricSchema);
export const brawlRubric = () => load('brawl-rubric.json', brawlRubricSchema);

/** Sources needed for `pips` colored pips at mana value `mv`, scaled to the deck size. */
export function karstenSources(table: KarstenTable, pips: number, mv: number, deckSize: number): number {
  const keys = Object.keys(table.table).map(Number).sort((a, b) => a - b);
  const p = keys.filter((k) => k <= pips).pop() ?? keys[0]!;
  const row = table.table[String(p)]!;
  const cols = Object.keys(row).map(Number).sort((a, b) => a - b);
  const col = cols.filter((c) => c <= Math.max(mv, pips)).pop() ?? cols[0]!;
  const n = row[String(col)]!;
  return Math.round((n * deckSize) / table.deckSize);
}

export function tierFor(score: number, t: z.infer<typeof tiers>) {
  const sorted = [...t].sort((a, b) => b.min - a.min);
  return sorted.find((x) => score >= x.min) ?? sorted[sorted.length - 1]!;
}
