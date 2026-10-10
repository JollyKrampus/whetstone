import { z } from 'zod';
import defaultBrawl from '../../rubric/brawl-rubric.json' with { type: 'json' };
import defaultConstructed from '../../rubric/power-rubric.json' with { type: 'json' };
import defaultSalt from '../../rubric/salt.json' with { type: 'json' };

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
  commanderSynergy: z.object({ targetShare: z.number(), targetRecommendedShare: z.number(), themes: z.record(z.string(), z.string()) }),
  cardQuality,
});

export type ConstructedRubric = z.infer<typeof constructedRubricSchema>;
export type BrawlRubric = z.infer<typeof brawlRubricSchema>;
export type KarstenTable = z.infer<typeof karsten>;
export type Archetype = keyof ConstructedRubric['archetypes'];

/**
 * Where rubric JSON comes from. The defaults are the package's own rubric/ files, bundled
 * at build time, so this module needs no file system. The MCP server swaps in a source
 * that prefers <config dir>/rubric/ overrides (see data/rubricFiles.ts); a browser app can
 * pass rubric objects it loaded itself.
 */
export interface RubricSource {
  /** A stable key for caching (e.g. the file path the JSON came from). */
  constructed(): { key: string; json: unknown };
  brawl(): { key: string; json: unknown };
  /** Casual etiquette rules; optional so older custom sources keep working. */
  salt?(): { key: string; json: unknown };
}

export const bundledRubrics: Required<RubricSource> = {
  constructed: () => ({ key: 'bundled:power-rubric.json', json: defaultConstructed }),
  brawl: () => ({ key: 'bundled:brawl-rubric.json', json: defaultBrawl }),
  salt: () => ({ key: 'bundled:salt.json', json: defaultSalt }),
};

export const saltRubricSchema = z.object({
  name: z.string(),
  gameChangers: z.object({ level: z.enum(['avoid', 'penalize', 'ignore']), reason: z.string(), weight: z.number().optional() }),
  rules: z.array(
    z.object({
      name: z.string(),
      level: z.enum(['avoid', 'penalize']),
      weight: z.number().optional(),
      pattern: z.string().optional(),
      role: z.string().optional(),
    }),
  ),
});
export type SaltRubric = z.infer<typeof saltRubricSchema>;

let source: RubricSource = bundledRubrics;
const cache = new Map<string, unknown>();

export function setRubricSource(next: RubricSource): void {
  source = next;
  cache.clear();
}

function load<T>(pick: { key: string; json: unknown }, schema: z.ZodType<T>): T {
  if (cache.has(pick.key)) return cache.get(pick.key) as T;
  const parsed = schema.safeParse(pick.json);
  if (!parsed.success) throw new Error(`Invalid rubric ${pick.key}: ${parsed.error.message}`);
  cache.set(pick.key, parsed.data);
  return parsed.data;
}

export const constructedRubric = () => load(source.constructed(), constructedRubricSchema);
export const brawlRubric = () => load(source.brawl(), brawlRubricSchema);
export const saltRubric = () => load((source.salt ?? bundledRubrics.salt)(), saltRubricSchema);

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
