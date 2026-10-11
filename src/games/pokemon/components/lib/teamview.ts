/**
 * Pure glue between a team (team.ts), the dex index (dex.ts), the common sets (metasets.ts) and
 * the calc worker's results: battle formes, final stats, calc and team-preview inputs, the
 * builder's threat list and its speed ladder. Browser-safe; every island goes through here so the
 * rules live in one tested place.
 *
 * Threat list rule (documented on /pokemon/about/): for each common set of the top Pokémon, its
 * best move into each of your Pokémon (Doubles field, spread moves at 0.75×) gives the hits it
 * needs. A KO the calc rates below 50 % likely counts one hit later, so "OHKO" means "KOs in one
 * hit at least half the time". Pressure = OHKOs + 0.4 × 2HKOs; an "answer" is one of your
 * Pokémon that 2HKOs it back (same rule).
 */
import type { Move, Species } from '../../schema.ts';
import type { CalcMon, MoveResult, PairSummary } from '../../worker/protocol.ts';
import { formeLabel, type DexIndex } from './dex.ts';
import type { MetaSet } from './metasets.ts';
import type { DamageCell, DamageTable, PreviewMon, PreviewMove } from './preview.ts';
import { effectiveSpeed, finalStats, speedItemLabel, statValue, type StatTable } from './stats.ts';
import type { PokemonSet, Team } from './team.ts';

/** The forme a set battles in: its Mega when it holds the matching stone. */
export function battleForme(dex: DexIndex, set: Pick<PokemonSet, 'species' | 'item'>): Species | undefined {
  return dex.megaFor(set.species, set.item) ?? dex.speciesById(set.species);
}

/**
 * Ability in battle after Mega Evolution: a Mega forme has its own (first) ability. Use it for
 * damage and type logic; switch-in effects use entryAbility.
 */
export function battleAbility(dex: DexIndex, set: Pick<PokemonSet, 'species' | 'item' | 'ability'>): string | undefined {
  const mega = dex.megaFor(set.species, set.item);
  return mega ? mega.abilities[0] : set.ability;
}

/**
 * Ability when the Pokémon first comes in: the registered one, even with a Mega Stone, because a
 * Pokémon enters in its base forme and Mega Evolves when it first acts. Intimidate, weather and
 * terrain setters on a Mega Stone holder still trigger on the lead.
 */
export function entryAbility(set: Pick<PokemonSet, 'ability'>): string | undefined {
  return set.ability;
}

/** Speed in battle: the battle forme's stat with the held item (Choice Scarf ×1.5). */
export function setSpeed(dex: DexIndex, set: PokemonSet): number | null {
  const stats = setStats(dex, set);
  return stats ? effectiveSpeed(stats.spe, set.item) : null;
}

/** Level-50 stats of the battle forme, or null for an unknown species. */
export function setStats(dex: DexIndex, set: PokemonSet): StatTable | null {
  const forme = battleForme(dex, set);
  return forme ? finalStats(forme.base, set.sp, set.nature) : null;
}

/** Display name of the battle forme ("Mega Salamence"). */
export function setDisplayName(dex: DexIndex, set: Pick<PokemonSet, 'species' | 'item'>): string {
  const forme = battleForme(dex, set);
  return forme ? formeLabel(forme) : set.species;
}

/** The calc's view of a set (battle forme, Stat Points). */
export function setToCalcMon(dex: DexIndex, set: PokemonSet): CalcMon {
  const forme = battleForme(dex, set);
  const mon: CalcMon = { species: forme?.id ?? set.species, nature: set.nature, sp: [...set.sp] };
  if (set.item) mon.item = set.item;
  const ability = battleAbility(dex, set);
  if (ability) mon.ability = ability;
  return mon;
}

export function metaToCalcMon(meta: MetaSet): CalcMon {
  const mon: CalcMon = { species: meta.id, nature: meta.nature, sp: [...meta.sp] };
  if (meta.item) mon.item = meta.item;
  if (meta.ability) mon.ability = meta.ability;
  return mon;
}

/**
 * A common set as an editable set, registered under its base species. A Mega's row carries the
 * Mega's ability, so the base species' first ability is used when a dex is given.
 */
export function metaToSet(meta: MetaSet, dex?: Pick<DexIndex, 'speciesById'>): PokemonSet {
  const set: PokemonSet = { species: meta.base, nature: meta.nature, sp: [...meta.sp], moves: [...meta.moves] };
  if (meta.item) set.item = meta.item;
  const ability = meta.base === meta.id ? meta.ability : dex?.speciesById(meta.base)?.abilities[0];
  if (ability) set.ability = ability;
  return set;
}

function previewMoves(dex: DexIndex, ids: readonly string[]): PreviewMove[] {
  return ids.map((id) => dex.move(id)).filter((m): m is Move => m !== undefined);
}

/** Your Pokémon for the team-preview scorer. */
export function previewFromSet(dex: DexIndex, set: PokemonSet, key: string): PreviewMon | null {
  const forme = battleForme(dex, set);
  if (!forme) return null;
  const mon: PreviewMon = {
    key,
    species: forme.id,
    base: set.species,
    name: formeLabel(forme),
    types: forme.types,
    speed: effectiveSpeed(finalStats(forme.base, set.sp, set.nature).spe, set.item),
    moves: previewMoves(dex, set.moves),
  };
  if (set.item && speedItemLabel(set.item)) mon.speedItem = set.item;
  const ability = battleAbility(dex, set);
  if (ability) mon.ability = ability;
  const entry = entryAbility(set);
  if (entry && entry !== ability) mon.entryAbility = entry;
  return mon;
}

/** Common sets grouped by the species that registers them, most used first. */
export function metaByBase(sets: readonly MetaSet[]): Map<string, MetaSet[]> {
  const out = new Map<string, MetaSet[]>();
  for (const m of sets) out.set(m.base, [...(out.get(m.base) ?? []), m]);
  for (const list of out.values()) list.sort((a, b) => b.usage - a.usage || a.rank - b.rank);
  return out;
}

/**
 * Their Pokémon for the scorer. A known sheet (moves present, e.g. open team sheets) is used as
 * is; otherwise the species' most used common set stands in (`assumed`); without one, only its
 * types and an uninvested Speed are known. `usage` sums the base species and its Megas.
 */
export function previewTheirs(dex: DexIndex, entry: PokemonSet, key: string, byBase: ReadonlyMap<string, readonly MetaSet[]>): PreviewMon | null {
  const species = dex.speciesById(entry.species);
  if (!species) return null;
  const formes = byBase.get(entry.species) ?? [];
  const usage = Math.min(1, formes.reduce((s, m) => s + m.usage, 0));
  if (entry.moves.length > 0) {
    const mon = previewFromSet(dex, entry, key);
    if (!mon) return null;
    if (usage > 0) mon.usage = usage;
    return mon;
  }
  const wantMega = entry.item ? dex.megaFor(entry.species, entry.item)?.id : undefined;
  const meta = (wantMega ? formes.find((m) => m.id === wantMega) : undefined) ?? formes[0];
  if (meta) {
    const forme = dex.speciesById(meta.id) ?? species;
    const mon: PreviewMon = {
      key,
      species: meta.id,
      base: entry.species,
      name: formeLabel(forme),
      types: meta.types,
      speed: meta.speed,
      moves: previewMoves(dex, meta.moves),
      assumed: true,
    };
    if (meta.speedItem) mon.speedItem = meta.speedItem;
    if (meta.ability) mon.ability = meta.ability;
    if (usage > 0) mon.usage = usage;
    return mon;
  }
  const forme = (wantMega && dex.speciesById(wantMega)) || species;
  const mon: PreviewMon = {
    key,
    species: forme.id,
    base: entry.species,
    name: formeLabel(forme),
    types: forme.types,
    speed: effectiveSpeed(statValue('spe', forme.base.spe, 0), entry.item),
    moves: [],
    assumed: true,
  };
  if (entry.item && speedItemLabel(entry.item)) mon.speedItem = entry.item;
  if (forme.abilities.length === 1) mon.ability = forme.abilities[0]!;
  return mon;
}

/** The calc's view of their Pokémon (the set the scorer assumed). */
export function theirCalcMon(dex: DexIndex, entry: PokemonSet, byBase: ReadonlyMap<string, readonly MetaSet[]>): { mon: CalcMon; moves: string[] } | null {
  if (entry.moves.length > 0) {
    const attacks = entry.moves.filter((m) => {
      const mv = dex.move(m);
      return mv !== undefined && mv.category !== 'Status';
    });
    return { mon: setToCalcMon(dex, entry), moves: attacks };
  }
  const formes = byBase.get(entry.species) ?? [];
  const wantMega = entry.item ? dex.megaFor(entry.species, entry.item)?.id : undefined;
  const meta = (wantMega ? formes.find((m) => m.id === wantMega) : undefined) ?? formes[0];
  return meta ? { mon: metaToCalcMon(meta), moves: [...meta.attacks] } : null;
}

// ---- calc results -------------------------------------------------------------------------------

/**
 * Hits a result needs to KO in practice: the calc's count, or one more when that KO is less than
 * 50 % likely. 0 = no KO within four hits.
 */
export function effectiveHits(r: Pick<MoveResult, 'koN' | 'koChance'> | null | undefined): number {
  if (!r || r.koN <= 0) return 0;
  if (r.koChance >= 0.5) return r.koN;
  return r.koN + 1 <= 4 ? r.koN + 1 : 0;
}

export function toDamageCell(r: MoveResult): DamageCell {
  return { move: r.move, moveName: r.moveName, minPct: r.minPct, maxPct: r.maxPct, koN: r.koN, koChance: r.koChance };
}

/** Matrix pairs → the preview scorer's damage table. */
export function damageTable(mine: readonly PairSummary[], theirs: readonly PairSummary[]): DamageTable {
  const table: DamageTable = { mine: {}, theirs: {} };
  for (const p of mine) {
    (table.mine[p.attacker] ??= {})[p.defender] = p.best ? toDamageCell(p.best) : null;
  }
  for (const p of theirs) {
    (table.theirs[p.attacker] ??= {})[p.defender] = p.best ? toDamageCell(p.best) : null;
  }
  return table;
}

export interface ThreatHit {
  /** Your slot key. */
  member: string;
  result: MoveResult;
  hits: number;
}

export interface ThreatRow {
  /** Common set id (battle forme). */
  id: string;
  name: string;
  rank: number;
  usage: number;
  /** Your Pokémon it KOs in one hit (at least half the time). */
  ohko: number;
  /** …in two hits (not counting OHKOs). */
  twoHko: number;
  /** Its best hit into each of your Pokémon. */
  hits: ThreatHit[];
  /** The single most damaging of those. */
  worst: ThreatHit | null;
  /** Your Pokémon that 2HKO it back, with their best move. */
  answers: ThreatHit[];
  /** How many of yours it outspeeds (Speed in battle with items, no field effects). */
  outspeeds: number;
  pressure: number;
  /** Pressure on two or more of yours and nothing that 2HKOs it back. */
  unanswered: boolean;
}

export interface ThreatSummary {
  rows: ThreatRow[];
  /** Common sets the calc couldn't evaluate (unknown to @smogon/calc). */
  skipped: string[];
}

/**
 * Turn the two calc matrices (their sets into your team, your team into their sets) into the
 * builder's threat list, most dangerous first: pressure, then unanswered, then usage.
 */
export function summarizeThreats(
  sets: readonly MetaSet[],
  members: readonly { key: string; speed: number }[],
  theirsIntoMine: readonly PairSummary[],
  mineIntoTheirs: readonly PairSummary[],
): ThreatSummary {
  const into = new Map<string, PairSummary[]>();
  for (const p of theirsIntoMine) into.set(p.attacker, [...(into.get(p.attacker) ?? []), p]);
  const back = new Map<string, PairSummary[]>();
  for (const p of mineIntoTheirs) back.set(p.defender, [...(back.get(p.defender) ?? []), p]);
  const skipped: string[] = [];
  const rows: ThreatRow[] = [];
  for (const set of sets) {
    const pairs = into.get(set.id) ?? [];
    if (pairs.length > 0 && pairs.every((p) => p.error !== undefined)) {
      skipped.push(set.id);
      continue;
    }
    const hits: ThreatHit[] = [];
    for (const p of pairs) if (p.best) hits.push({ member: p.defender, result: p.best, hits: effectiveHits(p.best) });
    const ohko = hits.filter((h) => h.hits === 1).length;
    const twoHko = hits.filter((h) => h.hits === 2).length;
    const worst = hits.reduce<ThreatHit | null>((w, h) => (!w || h.result.maxPct > w.result.maxPct ? h : w), null);
    const answers: ThreatHit[] = [];
    for (const p of back.get(set.id) ?? []) {
      if (!p.best) continue;
      const n = effectiveHits(p.best);
      if (n === 1 || n === 2) answers.push({ member: p.attacker, result: p.best, hits: n });
    }
    answers.sort((a, b) => a.hits - b.hits || b.result.maxPct - a.result.maxPct || (a.member < b.member ? -1 : 1));
    const pressure = ohko + 0.4 * twoHko;
    rows.push({
      id: set.id,
      name: set.name,
      rank: set.rank,
      usage: set.usage,
      ohko,
      twoHko,
      hits,
      worst,
      answers,
      outspeeds: members.filter((m) => set.speed > m.speed).length,
      pressure,
      unanswered: ohko + twoHko >= 2 && answers.length === 0,
    });
  }
  rows.sort(
    (a, b) =>
      b.pressure - a.pressure ||
      Number(b.unanswered) - Number(a.unanswered) ||
      b.usage - a.usage ||
      (a.id < b.id ? -1 : 1),
  );
  return { rows, skipped };
}

// ---- speed ladder -------------------------------------------------------------------------------

export interface LadderRow {
  key: string;
  name: string;
  /** Speed in battle (item and, for your side, Tailwind applied). */
  speed: number;
  /** The held item that changed it ('choicescarf'), for "(Scarf)" labels. */
  item?: string;
  mine: boolean;
}

/**
 * Your Pokémon merged into the top Pokémon's common sets: fastest first (slowest first under
 * Trick Room). Members give their Speed stat and held item; Choice Scarf and Tailwind (your side
 * only) are chained like the simulator, so a Scarf user under Tailwind gets exactly ×3. Common
 * sets come with their Speed in battle (MetaSet.speed). Ties list yours first.
 */
export function speedLadder(
  members: readonly { key: string; name: string; speed: number; item?: string | undefined }[],
  sets: readonly Pick<MetaSet, 'id' | 'name' | 'speed' | 'speedItem'>[],
  opts: { tailwind?: boolean; trickRoom?: boolean } = {},
): LadderRow[] {
  const row = (r: Omit<LadderRow, 'item'>, item: string | undefined): LadderRow => (item && speedItemLabel(item) ? { ...r, item } : r);
  const rows: LadderRow[] = [
    ...members.map((m) => row({ key: m.key, name: m.name, speed: effectiveSpeed(m.speed, m.item, { tailwind: Boolean(opts.tailwind) }), mine: true }, m.item)),
    ...sets.map((s) => row({ key: `meta-${s.id}`, name: s.name, speed: s.speed, mine: false }, s.speedItem)),
  ];
  const dir = opts.trickRoom ? 1 : -1;
  return rows.sort((a, b) => dir * (a.speed - b.speed) || Number(b.mine) - Number(a.mine) || (a.key < b.key ? -1 : 1));
}

/** "Moves before 31 of 50": how many of the others act after this one, and ties. */
export function ladderPosition(rows: readonly LadderRow[], key: string, trickRoom = false): { before: number; ties: number; total: number } {
  const me = rows.find((r) => r.key === key);
  const others = rows.filter((r) => !r.mine);
  if (!me) return { before: 0, ties: 0, total: others.length };
  const before = others.filter((r) => (trickRoom ? me.speed < r.speed : me.speed > r.speed)).length;
  const ties = others.filter((r) => r.speed === me.speed).length;
  return { before, ties, total: others.length };
}

/**
 * A starting six from the most used common sets: highest usage first, skipping a second Pokémon
 * of the same species, a repeated item and a second Mega. A starting point, not a recommendation.
 */
export function sampleTeam(sets: readonly MetaSet[], dex?: Pick<DexIndex, 'speciesById'>, size = 6): Team {
  const team: Team = [];
  const species = new Set<string>();
  const items = new Set<string>();
  let mega = false;
  for (const m of [...sets].sort((a, b) => a.rank - b.rank)) {
    if (team.length >= size) break;
    const isMega = m.id !== m.base;
    if (species.has(m.base) || (m.item && items.has(m.item)) || (isMega && mega)) continue;
    species.add(m.base);
    if (m.item) items.add(m.item);
    mega ||= isMega;
    team.push(metaToSet(m, dex));
  }
  return team;
}

/** Slot keys for a team ("s0".."s5"), stable while slots keep their order. */
export function slotKeys(team: Team): string[] {
  return team.map((_, i) => `s${i}`);
}
