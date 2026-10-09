/**
 * Type matchups for the builder's weakness matrix, offensive coverage and the team-preview
 * scorer. Pure: the chart comes from the dex (dex/typechart.json), so a rebalance in a future
 * regulation flows in with the data.
 *
 * A few abilities change what a type does to their holder (Levitate, Flash Fire, absorb
 * abilities, Thick Fat…). They are applied as an explicit, labelled adjustment, never silently.
 */
import type { Move, PokemonType, TypeChart } from '../../schema.ts';
import { POKEMON_TYPES } from './vocab.ts';

export const TYPES: readonly PokemonType[] = POKEMON_TYPES;

/** Damage multiplier of one attacking type against a (possibly dual) type. */
export function effectiveness(chart: TypeChart, attack: PokemonType, defender: readonly PokemonType[]): number {
  const row = chart.damage[attack];
  if (!row) return 1;
  return defender.reduce((m, t) => m * (row[t] ?? 1), 1);
}

/** Defensive ability adjustments: attacking type → multiplier applied on top of the chart. */
export const DEFENSIVE_ABILITIES: Readonly<Record<string, Partial<Record<PokemonType, number>>>> = {
  levitate: { Ground: 0 },
  eartheater: { Ground: 0 },
  flashfire: { Fire: 0 },
  wellbakedbody: { Fire: 0 },
  waterabsorb: { Water: 0 },
  stormdrain: { Water: 0 },
  dryskin: { Water: 0, Fire: 1.25 },
  voltabsorb: { Electric: 0 },
  lightningrod: { Electric: 0 },
  motordrive: { Electric: 0 },
  sapsipper: { Grass: 0 },
  thickfat: { Fire: 0.5, Ice: 0.5 },
  heatproof: { Fire: 0.5 },
  waterbubble: { Fire: 0.5 },
  purifyingsalt: { Ghost: 0.5 },
  fluffy: { Fire: 2 },
};

/** Abilities that turn Normal-type moves into another type (offense). */
export const TYPE_CHANGING_ABILITIES: Readonly<Record<string, PokemonType>> = {
  aerilate: 'Flying',
  pixilate: 'Fairy',
  refrigerate: 'Ice',
  galvanize: 'Electric',
  dragonize: 'Dragon',
};

export interface DefenseCell {
  type: PokemonType;
  /** Final multiplier (chart × ability). */
  multiplier: number;
  /** The ability changed the chart's value. */
  byAbility: boolean;
}

export function defenseProfile(chart: TypeChart, types: readonly PokemonType[], ability?: string): DefenseCell[] {
  const adjust = ability ? DEFENSIVE_ABILITIES[ability] : undefined;
  return TYPES.map((type) => {
    const base = effectiveness(chart, type, types);
    const extra = adjust?.[type];
    return { type, multiplier: extra === undefined ? base : base * extra, byAbility: extra !== undefined && base * extra !== base };
  });
}

/** Groups for "Weak to / Resists / Immune to" lists, strongest first. */
export function groupDefense(cells: readonly DefenseCell[]): { label: string; multiplier: number; cells: DefenseCell[] }[] {
  const groups = new Map<number, DefenseCell[]>();
  for (const c of cells) {
    if (c.multiplier === 1) continue;
    const list = groups.get(c.multiplier) ?? [];
    list.push(c);
    groups.set(c.multiplier, list);
  }
  return [...groups.entries()]
    .sort((a, b) => (a[0] === 0 ? 1 : b[0] === 0 ? -1 : b[0] - a[0]))
    .map(([multiplier, list]) => ({ label: multiplierLabel(multiplier), multiplier, cells: list }));
}

/** "×4", "×2", "×½", "×¼", "×0"; plain text so it reads well aloud too. */
export function multiplierLabel(m: number): string {
  if (m === 0) return '×0';
  if (m === 0.25) return '×¼';
  if (m === 0.5) return '×½';
  if (m === 0.625) return '×⅝';
  return `×${Number.isInteger(m) ? m : m.toFixed(2).replace(/0+$/, '')}`;
}

export interface MemberTyping {
  id: string;
  name: string;
  types: readonly PokemonType[];
  ability?: string;
}

export interface MatrixRow {
  type: PokemonType;
  cells: { id: string; multiplier: number; byAbility: boolean }[];
  weak: number;
  resist: number;
  immune: number;
}

/** 18 attacking types × team members, with weak / resist / immune counts per type. */
export function teamDefenseMatrix(chart: TypeChart, members: readonly MemberTyping[]): MatrixRow[] {
  const profiles = members.map((m) => ({ id: m.id, cells: defenseProfile(chart, m.types, m.ability) }));
  return TYPES.map((type, t) => {
    const cells = profiles.map((p) => ({ id: p.id, multiplier: p.cells[t]!.multiplier, byAbility: p.cells[t]!.byAbility }));
    return {
      type,
      cells,
      weak: cells.filter((c) => c.multiplier > 1).length,
      resist: cells.filter((c) => c.multiplier > 0 && c.multiplier < 1).length,
      immune: cells.filter((c) => c.multiplier === 0).length,
    };
  });
}

/** A team-wide hole: at least `minWeak` members weak and nobody resisting or immune. */
export function sharedWeaknesses(rows: readonly MatrixRow[], minWeak = 2): MatrixRow[] {
  return rows.filter((r) => r.weak >= minWeak && r.resist + r.immune === 0);
}

export interface AttackMove {
  /** Member id (slot key). */
  member: string;
  move: Pick<Move, 'id' | 'name' | 'type' | 'category' | 'basePower'>;
  /** Type after -ate abilities. */
  type: PokemonType;
  stab: boolean;
}

/** Damaging moves of one member with their effective type and STAB flag. */
export function attackMoves(
  member: string,
  moves: readonly Pick<Move, 'id' | 'name' | 'type' | 'category' | 'basePower'>[],
  types: readonly PokemonType[],
  ability?: string,
): AttackMove[] {
  const changeTo = ability ? TYPE_CHANGING_ABILITIES[ability] : undefined;
  return moves
    .filter((m) => m.category !== 'Status')
    .map((move) => {
      const type = changeTo && move.type === 'Normal' ? changeTo : move.type;
      return { member, move, type, stab: types.includes(type) };
    });
}

export interface CoverageCell {
  type: PokemonType;
  best: number;
  /** Moves reaching `best` (member + move), for the "via" line. */
  via: AttackMove[];
}

/** Best multiplier the team's damaging moves reach against each single type. */
export function teamCoverage(chart: TypeChart, attacks: readonly AttackMove[]): CoverageCell[] {
  return TYPES.map((type) => {
    let best = attacks.length ? 0 : 1;
    let via: AttackMove[] = [];
    for (const a of attacks) {
      const m = effectiveness(chart, a.type, [type]);
      if (m > best) {
        best = m;
        via = [a];
      } else if (m === best) via.push(a);
    }
    return { type, best, via };
  });
}

/** Does any of `attacks` hit `defender` super-effectively? Returns the best multiplier. */
export function bestAgainst(chart: TypeChart, attacks: readonly AttackMove[], defender: readonly PokemonType[], ability?: string): number {
  const adjust = ability ? DEFENSIVE_ABILITIES[ability] : undefined;
  let best = 0;
  for (const a of attacks) {
    const m = effectiveness(chart, a.type, defender) * (adjust?.[a.type] ?? 1);
    if (m > best) best = m;
  }
  return best;
}

/** CSS custom property name for a type's chip colour (decorative only; the name is always shown). */
export function typeVar(type: PokemonType): string {
  return `--pk-type-${type.toLowerCase()}`;
}
