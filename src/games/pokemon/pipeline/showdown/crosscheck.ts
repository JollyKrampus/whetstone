/**
 * Cross-check of the exported dex against @smogon/calc's Champions table (Generations.get(0)),
 * which powers the site's damage calculator. A disagreement on base stats or types means the
 * calc and the dex would describe different Pokémon, so the new dex is rejected (the pipeline
 * keeps the last-good one) until one of them is updated.
 */
import { Generations } from '@smogon/calc';
import type { Species } from '../../schema.ts';

export const CALC_GENERATION = 0;

export interface CrossCheck {
  /** Species found in the calc and identical. */
  matched: number;
  /** Species the calc does not know yet (its npm releases trail Showdown); the calc cannot use them. */
  missing: string[];
  /** Human-readable disagreements; any entry fails the check. */
  mismatches: string[];
}

const STATS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;

export function crossCheckWithCalc(species: readonly Species[]): CrossCheck {
  const gen = Generations.get(CALC_GENERATION);
  const out: CrossCheck = { matched: 0, missing: [], mismatches: [] };
  for (const s of species) {
    const calc = gen.species.get(s.id);
    if (!calc) {
      out.missing.push(s.id);
      continue;
    }
    const diffs: string[] = [];
    for (const stat of STATS) {
      if (calc.baseStats[stat] !== s.base[stat]) diffs.push(`${stat} ${s.base[stat]} vs calc ${calc.baseStats[stat]}`);
    }
    const calcTypes = [...calc.types].join('/');
    if (calcTypes !== s.types.join('/')) diffs.push(`types ${s.types.join('/')} vs calc ${calcTypes}`);
    if (diffs.length > 0) out.mismatches.push(`${s.id}: ${diffs.join(', ')}`);
    else out.matched++;
  }
  return out;
}
