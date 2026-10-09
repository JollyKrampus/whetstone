/**
 * Damage calculations on @smogon/calc's Champions generation (Generations.get(0)): level 50,
 * Stat Points in the `evs` slot, Champions move and item changes. Pure functions of plain JSON so
 * the worker, the unit tests and a no-worker fallback all share one implementation.
 *
 * @smogon/calc compares items and abilities by display name, so every id is resolved through its
 * own tables first; an id it doesn't know is reported, never guessed.
 */
import { Field, Generations, Move, Pokemon, calculate, toID } from '@smogon/calc';
import type {
  BoostStat,
  CalcField,
  CalcMon,
  CalcRequest,
  CalcResponse,
  MatrixRequest,
  MatrixResponse,
  MoveResult,
  PairSummary,
} from './protocol.ts';

const gen = Generations.get(0);

const STAT_KEYS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
const BOOST_KEYS: readonly BoostStat[] = ['atk', 'def', 'spa', 'spd', 'spe'];

function speciesName(id: string): string {
  const s = gen.species.get(toID(id));
  if (!s) throw new Error(`The calc doesn't know the Pokémon "${id}" yet.`);
  return s.name;
}

function itemName(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return gen.items.get(toID(id))?.name;
}

function abilityName(id: string | undefined): string | undefined {
  if (!id) return undefined;
  return gen.abilities.get(toID(id))?.name;
}

function moveName(id: string): string {
  const m = gen.moves.get(toID(id));
  if (!m) throw new Error(`The calc doesn't know the move "${id}".`);
  return m.name;
}

const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));
const round1 = (x: number): number => Math.round(x * 10) / 10;

/** A calc Pokémon at level 50 with Stat Points, boosts, status and current HP. */
export function buildPokemon(mon: CalcMon): Pokemon {
  const sp = mon.sp ?? [];
  const evs: Record<string, number> = {};
  STAT_KEYS.forEach((k, i) => {
    evs[k] = clamp(Math.trunc(sp[i] ?? 0), 0, 32);
  });
  const boosts: Record<string, number> = {};
  for (const k of BOOST_KEYS) {
    const v = mon.boosts?.[k];
    if (v) boosts[k] = clamp(Math.trunc(v), -6, 6);
  }
  const item = itemName(mon.item);
  const ability = abilityName(mon.ability);
  const options: ConstructorParameters<typeof Pokemon>[2] = { level: 50, nature: mon.nature || 'Serious', evs, boosts };
  if (item) options.item = item;
  if (ability) options.ability = ability;
  if (mon.status) options.status = mon.status;
  const p = new Pokemon(gen, speciesName(mon.species), options);
  if (mon.hpPercent !== undefined && mon.hpPercent < 100) {
    const pct = clamp(mon.hpPercent, 1, 100);
    return new Pokemon(gen, p.name, { ...options, curHP: Math.max(1, Math.floor((p.maxHP() * pct) / 100)) });
  }
  return p;
}

function sideOf(flags: CalcField['attacker']): Record<string, boolean> {
  return {
    isHelpingHand: Boolean(flags?.helpingHand),
    isReflect: Boolean(flags?.reflect),
    isLightScreen: Boolean(flags?.lightScreen),
    isAuroraVeil: Boolean(flags?.auroraVeil),
    isFriendGuard: Boolean(flags?.friendGuard),
    isTailwind: Boolean(flags?.tailwind),
  };
}

export function buildField(field: CalcField): Field {
  const init: ConstructorParameters<typeof Field>[0] = {
    gameType: field.doubles ? 'Doubles' : 'Singles',
    isGravity: Boolean(field.gravity),
    attackerSide: sideOf(field.attacker),
    defenderSide: sideOf(field.defender),
  };
  if (field.weather) init.weather = field.weather;
  if (field.terrain) init.terrain = field.terrain;
  return new Field(init);
}

const SPREAD_TARGETS = new Set(['allAdjacentFoes', 'allAdjacent']);

/** One move from attacker into defender. */
export function calcMove(attacker: Pokemon, defender: Pokemon, moveId: string, field: Field, crit = false): MoveResult {
  const name = moveName(moveId);
  const move = new Move(gen, name, { isCrit: crit });
  const result = calculate(gen, attacker, defender, move, field);
  const [min, max] = result.range();
  const hp = defender.maxHP();
  let koN = 0;
  let koChance = 0;
  let koText = '';
  let desc = '';
  if (max > 0) {
    try {
      const ko = result.kochance();
      koN = ko.n > 0 && ko.n <= 4 ? ko.n : 0;
      koChance = koN ? clamp(ko.chance ?? 0, 0, 1) : 0;
      koText = ko.text;
    } catch {
      koText = '';
    }
    try {
      desc = result.desc();
    } catch {
      desc = '';
    }
  }
  return {
    move: toID(name),
    moveName: name,
    min,
    max,
    minPct: hp ? round1((min / hp) * 100) : 0,
    maxPct: hp ? round1((max / hp) * 100) : 0,
    defenderHp: hp,
    koN,
    koChance,
    koText,
    desc,
    spread: Boolean(field.gameType === 'Doubles' && move.target && SPREAD_TARGETS.has(move.target)),
  };
}

function statsOf(p: Pokemon): Record<string, number> {
  return { ...p.stats, hp: p.maxHP() };
}

export function runCalc(req: CalcRequest): CalcResponse {
  const errors: { move: string; error: string }[] = [];
  let attacker: Pokemon;
  let defender: Pokemon;
  try {
    attacker = buildPokemon(req.attacker);
    defender = buildPokemon(req.defender);
  } catch (err) {
    return { results: [], errors: [{ move: '', error: (err as Error).message }], attackerStats: null, defenderStats: null };
  }
  const field = buildField(req.field);
  const results: MoveResult[] = [];
  for (const m of req.moves) {
    try {
      results.push(calcMove(attacker, defender, m, field, Boolean(req.field.crit)));
    } catch (err) {
      errors.push({ move: m, error: (err as Error).message });
    }
  }
  return { results, errors, attackerStats: statsOf(attacker), defenderStats: statsOf(defender) };
}

/** Rank results: fewer hits to KO first, then higher KO chance, then more damage. */
export function betterResult(a: MoveResult, b: MoveResult): boolean {
  const an = a.koN || 99;
  const bn = b.koN || 99;
  if (an !== bn) return an < bn;
  if (a.koChance !== b.koChance) return a.koChance > b.koChance;
  return a.maxPct > b.maxPct;
}

/** Best move of every attacker into every defender. */
export function runMatrix(req: MatrixRequest): MatrixResponse {
  const field = buildField(req.field);
  const defenders = req.defenders.map((d) => {
    try {
      return { key: d.key, mon: buildPokemon(d.mon), error: undefined as string | undefined };
    } catch (err) {
      return { key: d.key, mon: null, error: (err as Error).message };
    }
  });
  const pairs: PairSummary[] = [];
  for (const a of req.attackers) {
    let attacker: Pokemon | null = null;
    let attackerError: string | undefined;
    try {
      attacker = buildPokemon(a.mon);
    } catch (err) {
      attackerError = (err as Error).message;
    }
    for (const d of defenders) {
      if (!attacker || !d.mon) {
        pairs.push({ attacker: a.key, defender: d.key, best: null, error: attackerError ?? d.error ?? 'Unknown Pokémon' });
        continue;
      }
      let best: MoveResult | null = null;
      for (const m of a.moves) {
        try {
          const r = calcMove(attacker, d.mon, m, field, Boolean(req.field.crit));
          if (r.max > 0 && (!best || betterResult(r, best))) best = r;
        } catch {
          // An unknown move just doesn't count.
        }
      }
      pairs.push({ attacker: a.key, defender: d.key, best });
    }
  }
  return { pairs };
}

/** Does the calc know this species id? (For "calc unavailable" notices.) */
export function knowsSpecies(id: string): boolean {
  return Boolean(gen.species.get(toID(id)));
}
