/**
 * Build-time (Node-only) helpers shared by the Pokémon pages: the clock pages render against, a
 * dex index over the loader's files, and the common sets handed to islands as props. Imported
 * from .astro frontmatter only, never from an island (it reads files through load.ts).
 */
import { usingFixtures } from '../../../lib/datadir.ts';
import {
  getAbilities,
  getCurrentRegulation,
  getDefaultUsage,
  getItems,
  getLearnsets,
  getMeta,
  getMove,
  getMoves,
  getSpecies,
  getSpeciesById,
  getTypeChart,
} from '../load.ts';
import type { Usage } from '../schema.ts';
import { createDexIndex, type DexIndex } from './lib/dex.ts';
import { metaSets, type MetaSet } from './lib/metasets.ts';
import { cutoffLabel, monthLabel } from '../view.ts';

/** Fixtures are frozen in time: render them against their own snapshot time. */
export function buildNow(): number {
  return usingFixtures('pokemon') ? Date.parse(getMeta().generatedAt) : Date.now();
}

let dex: DexIndex | null = null;

export function serverDex(): DexIndex {
  dex ??= createDexIndex({
    regulation: getCurrentRegulation(new Date(buildNow())).id,
    species: getSpecies(),
    moves: getMoves(),
    items: getItems(),
    abilities: getAbilities(),
    learnsets: getLearnsets(),
    typechart: getTypeChart(),
  });
  return dex;
}

export function currentUsage(): Usage | null {
  return getDefaultUsage(new Date(buildNow()));
}

/** Common sets of the most used Pokémon (default top 50), for islands. */
export function topMetaSets(limit = 50): MetaSet[] {
  const usage = currentUsage();
  if (!usage) return [];
  return metaSets(usage.pokemon, { species: getSpeciesById, move: getMove }, limit);
}

/** "Smogon ≥ 1760 · Sep 2026" for labels, or null without usage. */
export function usageLabel(usage: Usage | null = currentUsage()): string | null {
  if (!usage) return null;
  return `Smogon ${cutoffLabel(usage.cutoff)} · ${monthLabel(usage.month)}`;
}
