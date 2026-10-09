/**
 * "Common sets" built from Smogon usage rows: the most used item, ability, spread and moves of
 * each top Pokémon. They stand in for an opponent's real set in the threat list, the calc
 * presets, the speed comparison and the team-preview assistant, and are always labelled as the
 * most common choices rather than anyone's actual team.
 */
import type { Move, Nature, PokemonType, Species, UsageEntry } from '../../schema.ts';
import { finalStats, type SpTuple } from './stats.ts';
import { emptySp } from './team.ts';

export interface MetaSet {
  /** Usage row id: the battle forme (Megas are their own rows, e.g. salamencemega). */
  id: string;
  /** Species that registers it (the base species for Megas). */
  base: string;
  name: string;
  rank: number;
  /** Weighted usage share (0–1). */
  usage: number;
  types: PokemonType[];
  item?: string;
  ability?: string;
  nature: Nature;
  sp: SpTuple;
  /** Share of the chosen spread among the species' spreads (0 when none was reported). */
  spreadShare: number;
  /** Four most used moves. */
  moves: string[];
  /** Most used damaging moves (≤ 4), for damage calcs. */
  attacks: string[];
  /** Speed stat of that spread at level 50. */
  speed: number;
}

export interface MetaSetLookups {
  species(id: string): Pick<Species, 'id' | 'name' | 'types' | 'base' | 'abilities' | 'megaOf' | 'requiredItem'> | undefined;
  move(id: string): Pick<Move, 'category'> | undefined;
}

export function metaSetFromUsage(row: UsageEntry, lookups: MetaSetLookups): MetaSet | null {
  const species = lookups.species(row.id);
  if (!species) return null;
  const spread = row.spreads[0];
  const sp = spread ? ([...spread.sp] as SpTuple) : emptySp();
  const nature: Nature = spread?.nature ?? 'Serious';
  const known = row.moves.filter((m) => lookups.move(m.id));
  const attacks = known.filter((m) => lookups.move(m.id)?.category !== 'Status').slice(0, 4).map((m) => m.id);
  const item = species.megaOf && species.requiredItem ? species.requiredItem : row.items[0]?.id;
  const ability = row.abilities[0]?.id ?? species.abilities[0];
  const set: MetaSet = {
    id: species.id,
    base: species.megaOf ?? species.id,
    name: species.name,
    rank: row.rank,
    usage: row.usage,
    types: [...species.types],
    nature,
    sp,
    spreadShare: spread?.share ?? 0,
    moves: known.slice(0, 4).map((m) => m.id),
    attacks,
    speed: finalStats(species.base, sp, nature).spe,
  };
  if (item) set.item = item;
  if (ability) set.ability = ability;
  return set;
}

/** The top `limit` usage rows as common sets (rows whose species is unknown are skipped). */
export function metaSets(rows: readonly UsageEntry[], lookups: MetaSetLookups, limit = 50): MetaSet[] {
  const out: MetaSet[] = [];
  for (const row of rows) {
    if (out.length >= limit) break;
    const set = metaSetFromUsage(row, lookups);
    if (set) out.push(set);
  }
  return out;
}
