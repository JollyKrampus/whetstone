/**
 * Raw dex export (export.ts) → the dex files of POKEMON_FILES. Pure and deterministic: every
 * list is sorted by id, every learnset by move id.
 */
import { compareStrings } from '../../../../../pipeline/hash.ts';
import { POKEMON_TYPES, type Item, type Learnsets, type Move, type PokemonAbility, type PokemonType, type Species, type TypeChart } from '../../schema.ts';
import { toId } from '../ids.ts';
import type { RawDexExport, RawSpecies } from './raw.ts';

export interface DexFiles {
  species: Species[];
  moves: Move[];
  items: Item[];
  abilities: PokemonAbility[];
  typechart: TypeChart;
  learnsets: Learnsets;
}

export interface DexTransform {
  files: DexFiles;
  /** Showdown sprite id per species id (img/sprites/<id>.webp is fetched from it). */
  spriteIds: Record<string, string>;
  /** Per regulation that exists in the Showdown tree: legal species (without Megas), Megas, items. */
  legalCounts: Record<string, { species: number; megas: number; items: number }>;
  /** Regulations the tree has no format for (not yet added, or long retired). */
  missingRegulations: string[];
  warnings: string[];
}

/** Showdown's damageTaken codes: 0 neutral, 1 weak, 2 resists, 3 immune. */
const DAMAGE_CODE: Record<number, 0 | 0.5 | 1 | 2> = { 0: 1, 1: 2, 2: 0.5, 3: 0 };
const ABILITY_SLOTS = ['0', '1', 'H', 'S'] as const;
const byId = <T extends { id: string }>(a: T, b: T): number => compareStrings(a.id, b.id);

function isType(t: string): t is PokemonType {
  return (POKEMON_TYPES as readonly string[]).includes(t);
}

export function transformDex(raw: RawDexExport): DexTransform {
  const warnings: string[] = [];
  const existing = raw.regulations.filter((r) => r.exists);
  const missingRegulations = raw.regulations.filter((r) => !r.exists).map((r) => r.id);
  const legalIn = (id: string, kind: 'species' | 'items'): string[] =>
    existing.filter((r) => (kind === 'items' ? r.items.includes(id) : r.species.includes(id) || r.megas.includes(id))).map((r) => r.id);

  // Mega Stone → (base, forme), only for formes we export.
  const exported = new Set(raw.species.map((s) => s.id));
  const stoneOf = new Map<string, { base: string; forme: string }>();
  for (const item of raw.items) {
    const link = item.megaStone.find((m) => exported.has(m.forme));
    if (link) stoneOf.set(item.id, link);
  }
  const megaBase = new Map<string, string>();
  for (const link of stoneOf.values()) megaBase.set(link.forme, link.base);

  const species: Species[] = [];
  const spriteIds: Record<string, string> = {};
  for (const s of raw.species) {
    const types = s.types.filter(isType);
    if (types.length !== s.types.length || types.length === 0) {
      warnings.push(`${s.id}: unknown type in ${s.types.join('/')}; skipped`);
      continue;
    }
    const abilities = [...new Set(ABILITY_SLOTS.map((k) => s.abilities[k]).filter((a): a is string => Boolean(a)).map(toId))].slice(0, 3);
    const out: Species = {
      id: s.id,
      name: s.name,
      num: s.num,
      types: types.length === 1 ? [types[0] as PokemonType] : [types[0] as PokemonType, types[1] as PokemonType],
      base: { hp: s.baseStats.hp, atk: s.baseStats.atk, def: s.baseStats.def, spa: s.baseStats.spa, spd: s.baseStats.spd, spe: s.baseStats.spe },
      abilities,
      weightkg: s.weightkg,
      legal: legalIn(s.id, 'species'),
    };
    if (s.forme) {
      out.baseSpecies = s.baseSpecies;
      out.forme = s.forme;
    }
    if (s.isMega) {
      const base = megaBase.get(s.id) ?? toId(s.changesFrom ?? s.baseSpecies);
      const stone = s.requiredItem ? toId(s.requiredItem) : null;
      if (!stone || !exported.has(base)) {
        warnings.push(`${s.id}: Mega without a usable stone or base species; skipped`);
        continue;
      }
      out.megaOf = base;
      out.requiredItem = stone;
    }
    if (s.tier && s.tier !== 'Illegal') out.tier = s.tier;
    species.push(out);
    spriteIds[s.id] = s.spriteid;
  }
  const kept = new Set(species.map((s) => s.id));
  const megasOf = new Map<string, string[]>();
  for (const s of species) if (s.megaOf) megasOf.set(s.megaOf, [...(megasOf.get(s.megaOf) ?? []), s.id]);
  const rawById = new Map<string, RawSpecies>(raw.species.map((s) => [s.id, s]));
  for (const s of species) {
    const r = rawById.get(s.id) as RawSpecies;
    const megas = megasOf.get(s.id);
    if (megas) s.megas = megas.sort(compareStrings);
    const other = r.otherFormes.filter((f) => kept.has(f) && !species.some((x) => x.id === f && x.megaOf));
    if (!s.megaOf && other.length > 0) s.otherFormes = [...new Set(other)].sort(compareStrings);
    const cosmetic = r.cosmeticFormes.filter((c) => !kept.has(c));
    if (cosmetic.length > 0) s.cosmeticFormes = [...new Set(cosmetic)].sort(compareStrings);
  }
  species.sort(byId);

  const learnsets: Learnsets = {};
  const moveIds = new Set(raw.moves.map((m) => m.id));
  for (const s of species) {
    if (s.megaOf) continue;
    const list = raw.learnsets[s.id];
    if (!list) warnings.push(`${s.id}: no learnset in the export`);
    learnsets[s.id] = [...new Set((list ?? []).filter((m) => moveIds.has(m)))].sort(compareStrings);
  }

  const moves: Move[] = [];
  for (const m of raw.moves) {
    if (!isType(m.type)) {
      warnings.push(`move ${m.id}: unknown type ${m.type}; skipped`);
      continue;
    }
    const move: Move = {
      id: m.id,
      name: m.name,
      type: m.type,
      category: m.category,
      basePower: m.basePower,
      accuracy: m.accuracy,
      pp: m.pp,
      priority: m.priority,
      target: m.target,
      flags: [...m.flags].sort(compareStrings),
    };
    if (m.shortDesc) move.desc = m.shortDesc;
    moves.push(move);
  }
  moves.sort(byId);

  const items: Item[] = raw.items
    .map((i) => {
      const item: Item = { id: i.id, name: i.name, legal: legalIn(i.id, 'items') };
      const mega = stoneOf.get(i.id);
      if (mega) item.mega = { base: mega.base, forme: mega.forme };
      if (i.shortDesc) item.desc = i.shortDesc;
      return item;
    })
    .sort(byId);

  const abilities: PokemonAbility[] = raw.abilities
    .map((a) => {
      const ability: PokemonAbility = { id: a.id, name: a.name };
      if (a.shortDesc) ability.desc = a.shortDesc;
      return ability;
    })
    .sort(byId);

  const damage = {} as TypeChart['damage'];
  const taken = new Map(raw.types.map((t) => [t.name, t.damageTaken]));
  for (const attack of POKEMON_TYPES) {
    const row = {} as TypeChart['damage'][PokemonType];
    for (const defend of POKEMON_TYPES) {
      const code = taken.get(defend)?.[attack];
      const mult = code === undefined ? undefined : DAMAGE_CODE[code];
      if (mult === undefined) throw new Error(`type chart: no entry for ${attack} → ${defend}`);
      row[defend] = mult;
    }
    damage[attack] = row;
  }

  const legalCounts: DexTransform['legalCounts'] = {};
  for (const r of existing) legalCounts[r.id] = { species: r.species.length, megas: r.megas.length, items: r.items.length };

  return {
    files: { species, moves, items, abilities, typechart: { types: [...POKEMON_TYPES], damage }, learnsets },
    spriteIds,
    legalCounts,
    missingRegulations,
    warnings,
  };
}
