/**
 * Messages between the page and the damage-calc worker. Plain JSON only (structured clone), ids
 * everywhere: the worker resolves them to @smogon/calc names itself.
 */

export type StatusId = '' | 'brn' | 'par' | 'psn' | 'tox' | 'slp' | 'frz';
export type WeatherId = '' | 'Sun' | 'Rain' | 'Sand' | 'Snow';
export type TerrainId = '' | 'Electric' | 'Grassy' | 'Psychic' | 'Misty';
export type BoostStat = 'atk' | 'def' | 'spa' | 'spd' | 'spe';

/** One Pokémon as the calc sees it: the forme it battles in (Mega already applied). */
export interface CalcMon {
  /** Battle forme id, e.g. 'salamencemega'. */
  species: string;
  item?: string;
  ability?: string;
  nature: string;
  /** Stat Points, HP/Atk/Def/SpA/SpD/Spe. */
  sp: number[];
  boosts?: Partial<Record<BoostStat, number>>;
  status?: StatusId;
  /** Current HP in percent (1–100); default full. */
  hpPercent?: number;
}

export interface CalcSideFlags {
  helpingHand?: boolean;
  reflect?: boolean;
  lightScreen?: boolean;
  auroraVeil?: boolean;
  friendGuard?: boolean;
  tailwind?: boolean;
}

export interface CalcField {
  doubles: boolean;
  weather?: WeatherId;
  terrain?: TerrainId;
  gravity?: boolean;
  /** Critical hit for every move in the request. */
  crit?: boolean;
  attacker?: CalcSideFlags;
  defender?: CalcSideFlags;
}

export interface MoveResult {
  move: string;
  moveName: string;
  /** Damage in HP points. */
  min: number;
  max: number;
  /** Percent of the defender's max HP. */
  minPct: number;
  maxPct: number;
  defenderHp: number;
  /** Hits to KO (1 = OHKO); 0 when it can't KO within four hits or deals no damage. */
  koN: number;
  /** Chance (0–1) of the KO in koN hits. */
  koChance: number;
  koText: string;
  /** @smogon/calc's one-line description. */
  desc: string;
  /** The move hits both foes (spread damage applied in Doubles). */
  spread: boolean;
}

export interface CalcRequest {
  attacker: CalcMon;
  defender: CalcMon;
  moves: string[];
  field: CalcField;
}

export interface CalcResponse {
  results: MoveResult[];
  /** Moves that could not be calculated, with a reason. */
  errors: { move: string; error: string }[];
  attackerStats: Record<string, number> | null;
  defenderStats: Record<string, number> | null;
}

/** Best move of one attacker into one defender. */
export interface PairSummary {
  attacker: string;
  defender: string;
  best: MoveResult | null;
  error?: string;
}

export interface MatrixAttacker {
  key: string;
  mon: CalcMon;
  moves: string[];
}

export interface MatrixDefender {
  key: string;
  mon: CalcMon;
}

export interface MatrixRequest {
  attackers: MatrixAttacker[];
  defenders: MatrixDefender[];
  field: CalcField;
}

export interface MatrixResponse {
  pairs: PairSummary[];
}

export type WorkerRequest =
  | { id: number; type: 'calc'; payload: CalcRequest }
  | { id: number; type: 'matrix'; payload: MatrixRequest }
  | { id: number; type: 'ping' };

export type WorkerResponse =
  | { id: number; ok: true; type: 'calc'; result: CalcResponse }
  | { id: number; ok: true; type: 'matrix'; result: MatrixResponse }
  | { id: number; ok: true; type: 'ping'; result: { ready: true } }
  | { id: number; ok: false; error: string };
