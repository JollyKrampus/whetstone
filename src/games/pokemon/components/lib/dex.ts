/**
 * In-browser index over the Champions dex shard (public/dex.json): lookups by id, name → id
 * resolution for pastes, battle formes and learnsets. Pure and browser-safe; the shard itself is
 * fetched by the islands from the staged URL their page passes in.
 */
import type { DexShard, Item, Move, PokemonAbility, PokemonType, Species, TypeChart } from '../../schema.ts';

/** Showdown toID: lowercase alphanumerics ("Indeedee-F" → "indeedeef"). */
export function toId(text: string | null | undefined): string {
  return (text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

export interface DexIndex {
  readonly regulation: string;
  readonly species: readonly Species[];
  readonly moves: readonly Move[];
  readonly items: readonly Item[];
  readonly abilities: readonly PokemonAbility[];
  readonly typechart: TypeChart;
  speciesById(id: string): Species | undefined;
  move(id: string): Move | undefined;
  item(id: string): Item | undefined;
  ability(id: string): PokemonAbility | undefined;
  /** Legal move ids (Megas use their base species' list). */
  learnset(speciesId: string): readonly string[];
  /** The species a forme belongs to (itself for base species). */
  baseOf(speciesId: string): Species | undefined;
  /** Mega forme the item turns `speciesId` into, if any. */
  megaFor(speciesId: string, itemId: string | undefined): Species | undefined;
  /** Display name for any id kind, falling back to the id. */
  speciesName(id: string): string;
  moveName(id: string): string;
  itemName(id: string): string;
  abilityName(id: string): string;
  /** Base species that can be registered (not Mega formes), sorted by name. */
  teamSpecies(): Species[];
}

function byId<T extends { id: string }>(list: readonly T[]): Map<string, T> {
  return new Map(list.map((x) => [x.id, x]));
}

export function createDexIndex(shard: Pick<DexShard, 'regulation' | 'species' | 'moves' | 'items' | 'abilities' | 'learnsets' | 'typechart'>): DexIndex {
  const species = byId(shard.species);
  const moves = byId(shard.moves);
  const items = byId(shard.items);
  const abilities = byId(shard.abilities);

  const baseOf = (id: string): Species | undefined => {
    const s = species.get(id);
    if (!s) return undefined;
    if (s.megaOf) return species.get(s.megaOf) ?? s;
    if (s.baseSpecies) return species.get(toId(s.baseSpecies)) ?? s;
    return s;
  };

  const learnset = (id: string): readonly string[] => {
    const own = shard.learnsets[id];
    if (own) return own;
    const s = species.get(id);
    const base = s?.megaOf ?? (s?.baseSpecies ? toId(s.baseSpecies) : undefined);
    return (base && shard.learnsets[base]) || [];
  };

  const megaFor = (id: string, itemId: string | undefined): Species | undefined => {
    if (!itemId) return undefined;
    const mega = items.get(itemId)?.mega;
    if (!mega || mega.base !== id) return undefined;
    return species.get(mega.forme);
  };

  return {
    regulation: shard.regulation,
    species: shard.species,
    moves: shard.moves,
    items: shard.items,
    abilities: shard.abilities,
    typechart: shard.typechart,
    speciesById: (id) => species.get(id),
    move: (id) => moves.get(id),
    item: (id) => items.get(id),
    ability: (id) => abilities.get(id),
    learnset,
    baseOf,
    megaFor,
    speciesName: (id) => species.get(id)?.name ?? id,
    moveName: (id) => moves.get(id)?.name ?? id,
    itemName: (id) => items.get(id)?.name ?? id,
    abilityName: (id) => abilities.get(id)?.name ?? id,
    teamSpecies: () =>
      shard.species.filter((s) => !s.megaOf).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}

/** Types of the forme a set battles in (the Mega forme when holding its stone). */
export function battleTypes(dex: DexIndex, speciesId: string, itemId?: string): readonly PokemonType[] {
  const forme = dex.megaFor(speciesId, itemId) ?? dex.speciesById(speciesId);
  return forme?.types ?? [];
}

/** "Mega Salamence", "Mega Garchomp Z", "Mega Charizard Y"; other formes keep their name. */
export function formeLabel(s: Pick<Species, 'name' | 'forme' | 'megaOf' | 'baseSpecies'>): string {
  if (!s.megaOf || !s.forme) return s.name;
  const base = s.baseSpecies ?? s.name.split('-')[0] ?? s.name;
  const suffix = s.forme.replace(/^Mega-?/, '').replace(/-/g, ' ').trim();
  return suffix ? `Mega ${base} ${suffix}` : `Mega ${base}`;
}
