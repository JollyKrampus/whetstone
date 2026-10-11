/**
 * Champions stat math (browser-safe, pure). Pokémon Champions replaces EVs with Stat Points (SP):
 * at most 32 in one stat and 66 in total, every Pokémon is level 50 and IVs are fixed at 31.
 *
 *   HP    = base + SP + 75
 *   other = floor((base + SP + 20) × nature)        nature = 1.1, 1.0 or 0.9
 *
 * That is the mainline level-50 formula with 31 IVs where one SP is worth about 8 EVs. Nature
 * multiplication uses integer maths (×110/100, ×90/100) like the simulator, so 150 × 1.1 can
 * never come out as 164.999….
 *
 * HOME → Champions conversion (first visit): 4 EVs buy the first point in a stat and every
 * further 8 EVs buy one more, capped at 32: sp = ev < 4 ? 0 : min(32, 1 + floor((ev − 4) / 8)).
 */
import type { Nature } from '../../schema.ts';

export const STAT_IDS = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'] as const;
export type StatId = (typeof STAT_IDS)[number];
export type StatTable = Record<StatId, number>;
/** HP/Atk/Def/SpA/SpD/Spe, the order Smogon spreads and the `EVs:` line use. */
export type SpTuple = [number, number, number, number, number, number];

export const STAT_LABEL: Readonly<Record<StatId, string>> = {
  hp: 'HP',
  atk: 'Atk',
  def: 'Def',
  spa: 'SpA',
  spd: 'SpD',
  spe: 'Spe',
};

export const STAT_NAME: Readonly<Record<StatId, string>> = {
  hp: 'HP',
  atk: 'Attack',
  def: 'Defense',
  spa: 'Sp. Atk',
  spd: 'Sp. Def',
  spe: 'Speed',
};

export const SP_MAX_STAT = 32;
export const SP_MAX_TOTAL = 66;
export const LEVEL = 50;

/** Nature → [raised stat, lowered stat]; neutral natures are absent. */
const NATURE_EFFECT: Readonly<Partial<Record<Nature, readonly [StatId, StatId]>>> = {
  Lonely: ['atk', 'def'],
  Brave: ['atk', 'spe'],
  Adamant: ['atk', 'spa'],
  Naughty: ['atk', 'spd'],
  Bold: ['def', 'atk'],
  Relaxed: ['def', 'spe'],
  Impish: ['def', 'spa'],
  Lax: ['def', 'spd'],
  Timid: ['spe', 'atk'],
  Hasty: ['spe', 'def'],
  Jolly: ['spe', 'spa'],
  Naive: ['spe', 'spd'],
  Modest: ['spa', 'atk'],
  Mild: ['spa', 'def'],
  Quiet: ['spa', 'spe'],
  Rash: ['spa', 'spd'],
  Calm: ['spd', 'atk'],
  Gentle: ['spd', 'def'],
  Sassy: ['spd', 'spe'],
  Careful: ['spd', 'spa'],
};

/** Raised and lowered stat of a nature, or null for the five neutral natures. */
export function natureEffect(nature: Nature): { plus: StatId; minus: StatId } | null {
  const e = NATURE_EFFECT[nature];
  return e ? { plus: e[0], minus: e[1] } : null;
}

/** 110, 100 or 90 (percent) for one stat. HP is never affected. */
export function natureMultiplier(nature: Nature, stat: StatId): 90 | 100 | 110 {
  const e = NATURE_EFFECT[nature];
  if (!e || stat === 'hp') return 100;
  if (e[0] === stat) return 110;
  if (e[1] === stat) return 90;
  return 100;
}

/** "Adamant (+Atk −SpA)" or "Serious (neutral)". */
export function natureLabel(nature: Nature): string {
  const e = natureEffect(nature);
  return e ? `${nature} (+${STAT_LABEL[e.plus]} −${STAT_LABEL[e.minus]})` : `${nature} (neutral)`;
}

/** The nature that raises `plus` and lowers `minus`, or a neutral one when they match. */
export function natureFor(plus: StatId | null, minus: StatId | null): Nature {
  if (!plus || !minus || plus === minus || plus === 'hp' || minus === 'hp') return 'Serious';
  for (const [name, e] of Object.entries(NATURE_EFFECT) as [Nature, readonly [StatId, StatId]][]) {
    if (e[0] === plus && e[1] === minus) return name;
  }
  return 'Serious';
}

const clampInt = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.trunc(Number.isFinite(x) ? x : 0)));

/** One stat at level 50 with 31 IVs. */
export function statValue(stat: StatId, base: number, sp: number, nature: Nature = 'Serious'): number {
  const points = clampInt(sp, 0, SP_MAX_STAT);
  if (stat === 'hp') return base === 1 ? 1 : base + points + 75;
  return Math.floor(((base + points + 20) * natureMultiplier(nature, stat)) / 100);
}

export function spTupleToTable(sp: readonly number[]): StatTable {
  return {
    hp: sp[0] ?? 0,
    atk: sp[1] ?? 0,
    def: sp[2] ?? 0,
    spa: sp[3] ?? 0,
    spd: sp[4] ?? 0,
    spe: sp[5] ?? 0,
  };
}

export function tableToSpTuple(t: Partial<StatTable>): SpTuple {
  return [t.hp ?? 0, t.atk ?? 0, t.def ?? 0, t.spa ?? 0, t.spd ?? 0, t.spe ?? 0];
}

/** All six stats at level 50. */
export function finalStats(base: StatTable, sp: readonly number[], nature: Nature = 'Serious'): StatTable {
  const points = spTupleToTable(sp);
  const out = {} as StatTable;
  for (const id of STAT_IDS) out[id] = statValue(id, base[id], points[id], nature);
  return out;
}

export function spTotal(sp: readonly number[]): number {
  return sp.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}

export interface SpCheck {
  ok: boolean;
  total: number;
  /** Indices (0..5) above 32 or not whole numbers ≥ 0. */
  badStats: number[];
  overTotal: boolean;
}

export function checkSp(sp: readonly number[]): SpCheck {
  const badStats: number[] = [];
  sp.forEach((v, i) => {
    if (!Number.isInteger(v) || v < 0 || v > SP_MAX_STAT) badStats.push(i);
  });
  const total = spTotal(sp);
  const overTotal = total > SP_MAX_TOTAL;
  return { ok: badStats.length === 0 && !overTotal && sp.length === 6, total, badStats, overTotal };
}

/**
 * Set one stat's points, keeping the spread legal: the value is clamped to 0..32 and to what the
 * 66-point budget still allows.
 */
export function setSp(sp: readonly number[], index: number, value: number): SpTuple {
  const next = tableToSpTuple(spTupleToTable(sp));
  const others = spTotal(next) - (next[index] ?? 0);
  next[index] = clampInt(value, 0, Math.min(SP_MAX_STAT, Math.max(0, SP_MAX_TOTAL - others)));
  return next;
}

/** HOME conversion of one stat's EVs to Stat Points. */
export function evToSp(ev: number): number {
  if (!Number.isFinite(ev) || ev < 4) return 0;
  return Math.min(SP_MAX_STAT, 1 + Math.floor((Math.trunc(ev) - 4) / 8));
}

/** Smallest EV count that converts to `sp` points (for exporting to mainline tools). */
export function spToEv(sp: number): number {
  const points = clampInt(sp, 0, SP_MAX_STAT);
  if (points === 0) return 0;
  return Math.min(252, 4 + (points - 1) * 8);
}

/**
 * A set total above this many points is read as EVs even when no single stat is above 32. A
 * mistyped Stat Point spread (67–130, e.g. 4/32/32 from converting 4/252/252 by eye) stays Stat
 * Points and is reported as over the budget; real EV spreads total about 500.
 */
export const EV_TOTAL_EVIDENCE = 130;

/**
 * Does an `EVs:` line hold real EVs rather than Stat Points? Showdown's Champions formats write
 * Stat Points into the EVs line, so values are read as SP unless the evidence is strong: one
 * stat above 32, or a total above 130 (EV_TOTAL_EVIDENCE), neither of which a Stat Point spread
 * can come close to. Decided per set, so one odd set never converts the rest of a paste.
 */
export function looksLikeEvs(values: readonly number[]): boolean {
  return values.some((v) => v > SP_MAX_STAT) || spTotal(values) > EV_TOTAL_EVIDENCE;
}

/**
 * Speed modifiers. Stages apply to the stat first; Tailwind, Choice Scarf and Iron Ball are
 * chained 4096-based modifiers rounded once (as the simulator and @smogon/calc's getFinalSpeed
 * do); paralysis halves the result last.
 */
export interface SpeedMods {
  scarf?: boolean;
  /** Iron Ball halves Speed (×0.5 chained, like Scarf's ×1.5). */
  ironBall?: boolean;
  tailwind?: boolean;
  paralysis?: boolean;
  /** Stat stages −6..+6 (Icy Wind, Electroweb: −1). */
  stage?: number;
}

/** [numerator, denominator] of a stat stage: +1 = 3/2, −1 = 2/3, … */
export function stageFraction(stage: number): [number, number] {
  const s = clampInt(stage, -6, 6);
  return s >= 0 ? [2 + s, 2] : [2, 2 - s];
}

export function stageMultiplier(stage: number): number {
  const [num, den] = stageFraction(stage);
  return num / den;
}

/** Game Freak's rounding: halves round down, anything above .5 rounds up. */
export function pokeRound(x: number): number {
  return x % 1 > 0.5 ? Math.ceil(x) : Math.floor(x);
}

/** Chain one 4096-based modifier onto another (the simulator's chainModify). */
export function chainModifier(m: number, mod: number): number {
  return mod === 4096 ? m : (m * mod + 2048) >> 12;
}

export function modifiedSpeed(speed: number, mods: SpeedMods = {}): number {
  const [num, den] = stageFraction(mods.stage ?? 0);
  let s = Math.floor((Math.max(0, Math.trunc(speed)) * num) / den);
  let m = 4096;
  if (mods.tailwind) m = chainModifier(m, 8192);
  if (mods.scarf) m = chainModifier(m, 6144);
  else if (mods.ironBall) m = chainModifier(m, 2048);
  m = Math.min(131_172, Math.max(410, m));
  s = pokeRound((s * m) / 4096);
  if (mods.paralysis) s = Math.floor((s * 50) / 100);
  return Math.max(0, s);
}

/** Held items that change Speed, with the short label shown next to a Speed number. */
export const SPEED_ITEMS: Readonly<Record<string, string>> = {
  choicescarf: 'Scarf',
  ironball: 'Iron Ball',
};

/** "Scarf" when the item changes Speed, else undefined. */
export function speedItemLabel(item: string | undefined): string | undefined {
  return item ? SPEED_ITEMS[item] : undefined;
}

/**
 * Speed in battle with the held item (Choice Scarf ×1.5, Iron Ball ×0.5) and any other
 * modifiers, chained and rounded like the simulator.
 */
export function effectiveSpeed(stat: number, item: string | undefined, mods: Omit<SpeedMods, 'scarf' | 'ironBall'> = {}): number {
  return modifiedSpeed(stat, { ...mods, scarf: item === 'choicescarf', ironBall: item === 'ironball' });
}

/** "195 (Scarf)" or "130". */
export function speedText(speed: number, item?: string): string {
  const label = speedItemLabel(item);
  return label ? `${speed} (${label})` : String(speed);
}
