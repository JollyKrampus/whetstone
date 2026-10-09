/**
 * Team legality for Champions VGC Doubles (Showdown's "Flat Rules" for the Champions mod plus the
 * in-game registration rules):
 *
 * - every Pokémon, Mega forme and held item must be in the regulation's roster;
 * - Species Clause: no two Pokémon with the same National Dex number (formes collide);
 * - Item Clause: no duplicate held items (Mega Stones count);
 * - abilities must be one the species can have, moves must be in its Champions learnset;
 * - Stat Points: at most 32 per stat and 66 in total;
 * - register 4–6 Pokémon (Showdown's Champions formats ask for exactly 6);
 * - only one Pokémon may Mega Evolve per battle (several stones can still be registered).
 */
import { formeLabel, type DexIndex } from './dex.ts';
import { checkSp, SP_MAX_TOTAL } from './stats.ts';
import { MOVES_PER_SET, TEAM_SIZE, type Team } from './team.ts';

export type LegalityLevel = 'error' | 'warning';

export type LegalityCode =
  | 'size'
  | 'roster'
  | 'mega-roster'
  | 'item-roster'
  | 'species-clause'
  | 'item-clause'
  | 'ability'
  | 'moves'
  | 'learnset'
  | 'stat-points'
  | 'stone'
  | 'one-mega'
  | 'unknown';

export interface LegalityIssue {
  level: LegalityLevel;
  code: LegalityCode;
  /** 0-based slots the issue is about (empty for team-wide issues). */
  slots: number[];
  message: string;
}

export interface LegalityReport {
  ok: boolean;
  errors: number;
  warnings: number;
  issues: LegalityIssue[];
  /** Ids of every Mega forme the team can reach. */
  megas: string[];
}

export function checkTeam(team: Team, dex: DexIndex, regulation: string = dex.regulation): LegalityReport {
  const issues: LegalityIssue[] = [];
  const add = (level: LegalityLevel, code: LegalityCode, slots: number[], message: string) => issues.push({ level, code, slots, message });
  const megas: string[] = [];

  if (team.length < 4) add('error', 'size', [], `Register at least 4 Pokémon for Doubles (you have ${team.length}).`);
  else if (team.length < TEAM_SIZE) add('warning', 'size', [], `Showdown's Champions VGC formats need all 6 slots filled (you have ${team.length}).`);

  const byNum = new Map<number, number[]>();
  const byItem = new Map<string, number[]>();

  team.forEach((set, i) => {
    const species = dex.speciesById(set.species);
    if (!species) {
      add('error', 'unknown', [i], `Slot ${i + 1}: unknown Pokémon "${set.species}".`);
      return;
    }
    const name = species.name;
    if (species.megaOf) add('error', 'unknown', [i], `${name} is a Mega forme: register ${dex.speciesName(species.megaOf)} with its stone.`);
    if (!species.legal.includes(regulation)) add('error', 'roster', [i], `${name} isn't in the Regulation ${regulation} roster.`);
    byNum.set(species.num, [...(byNum.get(species.num) ?? []), i]);

    if (set.item) {
      const item = dex.item(set.item);
      if (!item) add('error', 'unknown', [i], `${name}: unknown item "${set.item}".`);
      else {
        if (!item.legal.includes(regulation)) add('error', 'item-roster', [i], `${name}: ${item.name} isn't allowed in Regulation ${regulation}.`);
        byItem.set(item.id, [...(byItem.get(item.id) ?? []), i]);
        if (item.mega) {
          const mega = dex.megaFor(species.id, item.id);
          if (!mega) add('warning', 'stone', [i], `${name} can't Mega Evolve with ${item.name}; it only works for ${dex.speciesName(item.mega.base)}.`);
          else {
            megas.push(mega.id);
            if (!mega.legal.includes(regulation)) add('error', 'mega-roster', [i], `${formeLabel(mega)} isn't allowed in Regulation ${regulation}.`);
          }
        }
      }
    }

    if (!set.ability) add('error', 'ability', [i], `${name} needs an ability.`);
    else if (!species.abilities.includes(set.ability)) {
      add('error', 'ability', [i], `${name} can't have ${dex.abilityName(set.ability)} (options: ${species.abilities.map((a) => dex.abilityName(a)).join(', ')}).`);
    }

    if (set.moves.length === 0) add('error', 'moves', [i], `${name} needs at least one move.`);
    if (set.moves.length > MOVES_PER_SET) add('error', 'moves', [i], `${name} has more than ${MOVES_PER_SET} moves.`);
    if (new Set(set.moves).size !== set.moves.length) add('error', 'moves', [i], `${name} has the same move twice.`);
    const learnset = new Set(dex.learnset(species.id));
    for (const m of set.moves) {
      if (!dex.move(m)) add('error', 'unknown', [i], `${name}: unknown move "${m}".`);
      else if (!learnset.has(m)) add('error', 'learnset', [i], `${name} can't learn ${dex.moveName(m)} in Champions.`);
    }

    const sp = checkSp(set.sp);
    if (sp.overTotal) add('error', 'stat-points', [i], `${name} has ${sp.total} Stat Points; the limit is ${SP_MAX_TOTAL}.`);
    if (sp.badStats.length) add('error', 'stat-points', [i], `${name}: each stat takes 0–32 Stat Points.`);
  });

  for (const slots of byNum.values()) {
    if (slots.length > 1) {
      const names = slots.map((s) => dex.speciesName(team[s]!.species));
      add('error', 'species-clause', slots, `Species Clause: ${names.join(' and ')} share a Pokédex number.`);
    }
  }
  for (const [item, slots] of byItem) {
    if (slots.length > 1) add('error', 'item-clause', slots, `Item Clause: ${slots.length} Pokémon hold ${dex.itemName(item)}.`);
  }
  if (megas.length > 1) {
    add('warning', 'one-mega', [], `${megas.length} Mega Stones registered: only one Pokémon can Mega Evolve per battle, so choose at Team Preview.`);
  }

  const errors = issues.filter((x) => x.level === 'error').length;
  return { ok: errors === 0, errors, warnings: issues.length - errors, issues, megas };
}

/** Issues touching one slot (for per-slot markers). */
export function issuesForSlot(report: LegalityReport, slot: number): LegalityIssue[] {
  return report.issues.filter((x) => x.slots.includes(slot));
}
