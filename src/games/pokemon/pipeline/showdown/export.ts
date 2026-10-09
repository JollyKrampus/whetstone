/**
 * Raw dex exporter, run as a child process by build.ts against a transpiled Pokémon Showdown
 * tree (only its sim/, lib/, data/ and config/formats are present):
 *
 *   node export.ts <distDir> <outFile> <request.json>
 *
 * request: { regulations: [{ id, format }], dataRegulations }. For every regulation it asks
 * Showdown's own format rules (Dex.forFormat + TeamValidator) which species, Megas and items
 * are legal; the data itself (stats, moves, learnsets, type chart) comes from the mod of the
 * first data regulation the tree has a format for (normally the current one), with its
 * programmatic overrides (Champions PP rules) applied by Showdown.
 *
 * Self-contained on purpose: no project imports, no network, no environment. The parent
 * validates the output (raw.ts) before using it.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Bumped whenever the export shape or its rules change (part of meta.extra.dexKey). */
export const EXPORTER_VERSION = 1;

type Dict<T = unknown> = Record<string, T>;

interface SdSpecies {
  id: string;
  name: string;
  num: number;
  exists: boolean;
  baseSpecies: string;
  forme: string;
  types: string[];
  baseStats: Dict<number>;
  abilities: Dict<string>;
  weightkg: number;
  isMega?: boolean;
  battleOnly?: string | string[];
  requiredItem?: string;
  changesFrom?: string;
  otherFormes?: string[];
  cosmeticFormes?: string[];
  isCosmeticForme?: boolean;
  isNonstandard: string | null;
  tier: string;
  spriteid: string;
}
interface SdMove {
  id: string;
  name: string;
  exists: boolean;
  type: string;
  category: string;
  basePower: number;
  accuracy: number | true;
  pp: number;
  noPPBoosts?: boolean;
  priority: number;
  target: string;
  flags: Dict<number>;
  shortDesc: string;
  isNonstandard: string | null;
}
interface SdItem {
  id: string;
  name: string;
  exists: boolean;
  megaStone?: Dict<string>;
  isNonstandard: string | null;
  shortDesc: string;
}
interface SdAbility {
  id: string;
  name: string;
  exists: boolean;
  shortDesc: string;
  isNonstandard: string | null;
}
interface SdType {
  name: string;
  isNonstandard: string | null;
  damageTaken: Dict<number>;
}
interface SdDex {
  currentMod: string;
  parentMod: string;
  species: { all(): readonly SdSpecies[]; get(name: string): SdSpecies; getMovePool(id: string): Set<string> };
  moves: { get(name: string): SdMove };
  items: { all(): readonly SdItem[]; get(name: string): SdItem };
  abilities: { get(name: string): SdAbility };
  types: { all(): readonly SdType[] };
  data: { Scripts: { calculatePP?: (move: SdMove, ppUps: number) => number } };
  text: { get(effect: SdMove | SdItem | SdAbility): { desc?: string; shortDesc?: string } };
}
interface SdFormat {
  id: string;
  exists: boolean;
  mod: string;
}
interface SdValidator {
  checkSpecies(set: Dict, species: SdSpecies, tierSpecies: SdSpecies, setHas: Dict): string | null;
  checkItem(set: Dict, item: SdItem, setHas: Dict): string | null;
  checkMove(set: Dict, move: SdMove, setHas: Dict): string | null;
}

export interface ExportRequest {
  regulations: { id: string; format: string }[];
  /** Regulations whose format's mod may supply the data, in order of preference (current first). */
  dataRegulations: string[];
}

const toId = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
const sortIds = (ids: Iterable<string>): string[] => [...new Set(ids)].sort();

/**
 * Fields a mod may override without making the inherited one-line description wrong: numbers
 * and labels exported as their own fields (power, accuracy, PP, type, category, flags).
 * Overriding anything else (secondary effects, handlers) drops the description unless the mod
 * has text of its own.
 */
const NEUTRAL_OVERRIDES = new Set(['inherit', 'isNonstandard', 'num', 'gen', 'name', 'desc', 'shortDesc', 'pp', 'basePower', 'accuracy', 'type', 'category', 'flags', 'contestType']);

export function runExport(distDir: string, request: ExportRequest, sha: string): unknown {
  const req = createRequire(path.join(distDir, 'sim', 'index.js'));
  const { Dex } = req('./dex.js') as { Dex: SdDex & { formats: { get(id: string): SdFormat }; forFormat(f: SdFormat): SdDex; mod(id: string): SdDex } };
  const { TeamValidator } = req('./team-validator.js') as { TeamValidator: { get(f: SdFormat): SdValidator } };

  /**
   * A data module as written in the tree. Showdown merges inherited entries into the objects
   * it required, so the cached module no longer shows which entries a mod overrides; evaluate
   * the file afresh instead.
   */
  function fresh(file: string): Dict | null {
    let resolved: string;
    try {
      resolved = req.resolve(file);
    } catch (err) {
      if ((err as { code?: string }).code === 'MODULE_NOT_FOUND') return null;
      throw err;
    }
    delete req.cache[resolved];
    try {
      return req(resolved) as Dict;
    } finally {
      delete req.cache[resolved];
    }
  }

  const blankSet = (name: string): Dict => ({ name, species: name, item: '', ability: '', moves: [], nature: '', evs: {}, ivs: {}, level: 50 });

  /** Mods from `dex` up to (excluding) the base data, whose own files may override mechanics. */
  function overriddenIds(dex: SdDex, table: 'moves' | 'items' | 'abilities'): Set<string> {
    const exportName = table === 'moves' ? 'Moves' : table === 'items' ? 'Items' : 'Abilities';
    const out = new Set<string>();
    let mod = dex.currentMod;
    let parent = dex.parentMod;
    for (let guard = 0; mod && mod !== 'base' && guard < 10; guard++) {
      const data = (fresh(path.join(distDir, 'data', 'mods', mod, table))?.[exportName] ?? {}) as Dict<Dict>;
      for (const [id, entry] of Object.entries(data)) {
        if (Object.keys(entry).some((k) => !NEUTRAL_OVERRIDES.has(k))) out.add(id);
      }
      const parentDex: SdDex = Dex.mod(parent || 'base');
      mod = parent;
      parent = parentDex.parentMod;
    }
    return out;
  }

  /** Raw text table (data/text/<file>), to tell mod-specific descriptions from inherited ones. */
  function rawText(file: 'moves' | 'items' | 'abilities'): Dict<Dict<unknown>> {
    const exportName = file === 'moves' ? 'MovesText' : file === 'items' ? 'ItemsText' : 'AbilitiesText';
    return (fresh(path.join(distDir, 'data', 'text', file))?.[exportName] ?? {}) as Dict<Dict<unknown>>;
  }

  /**
   * One-line description from Showdown's own text (mod-specific entries win). When the mod
   * changes an effect's mechanics and has no text of its own, the inherited text may be wrong
   * (Moonblast's secondary chance, for example), so none is exported.
   */
  function describe(dex: SdDex, effect: SdMove | SdItem | SdAbility, overrides: Set<string>, raw: Dict<Dict<unknown>>): string | null {
    const own = raw[effect.id]?.[dex.currentMod] as { desc?: string; shortDesc?: string } | undefined;
    if (overrides.has(effect.id) && !own?.shortDesc && !own?.desc) return null;
    const text = dex.text.get(effect);
    const line = (text.shortDesc || text.desc || '').trim();
    return line ? line : null;
  }

  const regulations = request.regulations.map((r) => {
    const format = Dex.formats.get(r.format);
    if (!format.exists) return { id: r.id, format: r.format, exists: false as const };
    const dex = Dex.forFormat(format);
    const validator = TeamValidator.get(format);
    const species: string[] = [];
    const megas: string[] = [];
    const items: string[] = [];
    const itemOk = (name: string | undefined): boolean => {
      if (!name) return false;
      const item = dex.items.get(name);
      return item.exists && !item.isNonstandard && !validator.checkItem(blankSet('x'), item, {});
    };
    for (const item of dex.items.all()) if (itemOk(item.name)) items.push(item.id);
    for (const s of dex.species.all()) {
      if (!s.exists || s.isCosmeticForme || s.isNonstandard || s.tier === 'Illegal') continue;
      if (s.isMega) {
        const base = dex.species.get(s.changesFrom ?? s.baseSpecies);
        if (!validator.checkSpecies(blankSet(base.name), base, s, {}) && itemOk(s.requiredItem)) megas.push(s.id);
      } else if (!s.battleOnly && !validator.checkSpecies(blankSet(s.name), s, s, {})) {
        species.push(s.id);
      }
    }
    return { id: r.id, format: format.id, exists: true as const, mod: format.mod, species: sortIds(species), megas: sortIds(megas), items: sortIds(items) };
  });

  const dataReg = request.dataRegulations.map((id) => regulations.find((r) => r.id === id)).find((r) => r?.exists === true);
  if (!dataReg || !dataReg.exists) throw new Error(`none of ${request.dataRegulations.join(', ')} has a format in this Showdown tree`);
  const dex = Dex.forFormat(Dex.formats.get(dataReg.format));
  const validator = TeamValidator.get(Dex.formats.get(dataReg.format));

  const speciesIds = new Set<string>();
  const itemIds = new Set<string>();
  for (const r of regulations) {
    if (!r.exists) continue;
    for (const id of [...r.species, ...r.megas]) speciesIds.add(id);
    for (const id of r.items) itemIds.add(id);
  }

  const species = [...speciesIds].sort().map((id) => {
    const s = dex.species.get(id);
    return {
      id: s.id,
      name: s.name,
      num: s.num,
      baseSpecies: s.baseSpecies,
      forme: s.forme,
      types: s.types,
      baseStats: s.baseStats,
      abilities: s.abilities,
      weightkg: s.weightkg,
      isMega: Boolean(s.isMega),
      requiredItem: s.requiredItem ?? null,
      changesFrom: s.changesFrom ?? null,
      otherFormes: (s.otherFormes ?? []).map(toId),
      cosmeticFormes: (s.cosmeticFormes ?? []).map(toId),
      tier: s.tier,
      spriteid: s.spriteid,
    };
  });

  const moveOverrides = overriddenIds(dex, 'moves');
  const moveText = rawText('moves');
  const learnsets: Dict<string[]> = {};
  const moveIds = new Set<string>();
  const moveOk = new Map<string, boolean>();
  const legalMove = (id: string): boolean => {
    let ok = moveOk.get(id);
    if (ok === undefined) {
      const m = dex.moves.get(id);
      ok = m.exists && !m.isNonstandard && !validator.checkMove(blankSet('x'), m, {});
      moveOk.set(id, ok);
    }
    return ok;
  };
  for (const s of species) {
    if (s.isMega) continue;
    const pool = [...dex.species.getMovePool(s.id)].filter(legalMove);
    learnsets[s.id] = sortIds(pool);
    for (const m of pool) moveIds.add(m);
  }
  const calculatePP = dex.data.Scripts.calculatePP;
  const moves = [...moveIds].sort().map((id) => {
    const m = dex.moves.get(id);
    return {
      id: m.id,
      name: m.name,
      type: m.type,
      category: m.category,
      basePower: m.basePower,
      accuracy: m.accuracy,
      pp: calculatePP ? calculatePP(m, 0) : m.pp,
      priority: m.priority,
      target: m.target,
      flags: Object.keys(m.flags).filter((f) => m.flags[f]).sort(),
      shortDesc: describe(dex, m, moveOverrides, moveText),
    };
  });

  const itemOverrides = overriddenIds(dex, 'items');
  const itemText = rawText('items');
  const items = [...itemIds].sort().map((id) => {
    const it = dex.items.get(id);
    return {
      id: it.id,
      name: it.name,
      megaStone: it.megaStone ? Object.entries(it.megaStone).map(([base, forme]) => ({ base: toId(base), forme: toId(forme) })) : [],
      shortDesc: describe(dex, it, itemOverrides, itemText),
    };
  });

  const abilityOverrides = overriddenIds(dex, 'abilities');
  const abilityText = rawText('abilities');
  const abilityIds = new Set<string>();
  for (const s of species) for (const name of Object.values(s.abilities)) abilityIds.add(toId(name));
  const abilities = [...abilityIds].sort().map((id) => {
    const a = dex.abilities.get(id);
    return { id: a.id, name: a.name, shortDesc: describe(dex, a, abilityOverrides, abilityText) };
  });

  const types = dex.types.all().filter((t) => !t.isNonstandard).map((t) => ({ name: t.name, damageTaken: t.damageTaken }));

  return { exporter: EXPORTER_VERSION, sha, dataRegulation: dataReg.id, dataMod: dex.currentMod, regulations, species, moves, items, abilities, types, learnsets };
}

function main(argv: readonly string[]): void {
  const [distDir, outFile, requestFile, sha] = argv;
  if (!distDir || !outFile || !requestFile || !sha) {
    throw new Error('usage: node export.ts <distDir> <outFile> <request.json> <sha>');
  }
  const request = JSON.parse(readFileSync(requestFile, 'utf8')) as ExportRequest;
  writeFileSync(outFile, JSON.stringify(runExport(path.resolve(distDir), request, sha)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
