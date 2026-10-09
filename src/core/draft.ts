/**
 * Generic draft engine (SPEC §7): a sequential order engine (Storm League style), a free mode
 * (heroescounters style: any team, any order) and a scorer that combines provider signals with
 * weight presets into ranked, explained suggestions. Game rules (orders, 2-slot entities, role
 * guardrails, providers) live in the game folders and are passed in as data.
 *
 * All states are immutable plain objects; every transition returns a new state.
 */
import type { Reason } from './game.ts';
import { SCORE_SCALE_PP } from './stats.ts';

export type Team = 'A' | 'B';
export type DraftAction = 'ban' | 'pick';

export interface DraftStep {
  readonly team: Team;
  readonly action: DraftAction;
}

export const otherTeam = (team: Team): Team => (team === 'A' ? 'B' : 'A');

/**
 * Parse an order written as "A-ban B-ban A-pick …" (space or comma separated). Throws on a bad
 * token: orders are configuration, so a typo should fail loudly at build time.
 */
export function parseOrder(spec: string): DraftStep[] {
  return spec
    .split(/[\s,]+/)
    .filter(Boolean)
    .map((token) => {
      const m = /^([AB])[-:](ban|pick)$/i.exec(token);
      if (!m) throw new Error(`Bad draft step "${token}" (expected e.g. "A-ban" or "B-pick")`);
      return { team: m[1]!.toUpperCase() as Team, action: m[2]!.toLowerCase() as DraftAction };
    });
}

/** Swap the teams of an order (e.g. to view it from the second-pick side). */
export function swapTeams(steps: readonly DraftStep[]): DraftStep[] {
  return steps.map((s) => ({ team: otherTeam(s.team), action: s.action }));
}

export interface EntityRule {
  /**
   * Pick steps this entity consumes (default 1). They must be consecutive picks of the same
   * team starting at the current step. Bans always cost one step.
   */
  slots?: number;
  /** 0-based step indices where a pick of this entity may start. Bans ignore it. */
  allowedSteps?: readonly number[];
}

export type EntityRules = Readonly<Record<string, EntityRule>>;

export type IllegalReason = 'complete' | 'taken' | 'slots' | 'step' | 'skip' | 'full' | 'bans' | 'invalid';

export interface Illegal {
  ok: false;
  reason: IllegalReason;
  message: string;
}

export type Legality = { ok: true } | Illegal;
export type DraftResult<S> = { ok: true; state: S } | Illegal;

const illegal = (reason: IllegalReason, message: string): Illegal => ({ ok: false, reason, message });
const OK: Legality = Object.freeze({ ok: true });

function slotsOf(rules: EntityRules | undefined, id: string): number {
  const slots = rules?.[id]?.slots ?? 1;
  return Number.isInteger(slots) && slots >= 1 ? slots : 1;
}

// ---- sequential order engine ------------------------------------------------------------------

export interface SequentialConfig {
  steps: readonly DraftStep[];
  rules?: EntityRules;
  /** Which steps accept a null choice (a missed ban, an unknown enemy pick). Default 'ban'. */
  allowSkip?: 'none' | 'ban' | 'any';
}

export interface FilledStep {
  step: number;
  team: Team;
  action: DraftAction;
  /** null = skipped. A 2-slot pick fills consecutive steps with the same id. */
  id: string | null;
  /** Index into `choices` that filled this step. */
  choice: number;
}

export interface SequentialState {
  readonly config: SequentialConfig;
  /** One entry per decision, in order; this is what URLs store. */
  readonly choices: readonly (string | null)[];
  readonly filled: readonly FilledStep[];
  /** Next step index; equals steps.length when complete. */
  readonly step: number;
  readonly complete: boolean;
  /** Every picked or banned id. */
  readonly taken: ReadonlySet<string>;
}

export function startSequential(config: SequentialConfig): SequentialState {
  return { config, choices: [], filled: [], step: 0, complete: config.steps.length === 0, taken: new Set() };
}

/** The step waiting for a decision, or null when the draft is complete. */
export function currentStep(state: SequentialState): (DraftStep & { index: number }) | null {
  const s = state.config.steps[state.step];
  return s ? { team: s.team, action: s.action, index: state.step } : null;
}

/** Can `id` (or null = skip) be chosen at the current step? */
export function checkSequential(state: SequentialState, id: string | null): Legality {
  const { steps, rules } = state.config;
  const step = steps[state.step];
  if (state.complete || !step) return illegal('complete', 'The draft is complete.');
  if (id === null) {
    const skip = state.config.allowSkip ?? 'ban';
    if (skip === 'any' || (skip === 'ban' && step.action === 'ban')) return OK;
    return illegal('skip', `Step ${state.step + 1} cannot be skipped.`);
  }
  if (typeof id !== 'string' || id === '') return illegal('invalid', 'Missing id.');
  if (state.taken.has(id)) return illegal('taken', `${id} is already picked or banned.`);
  if (step.action === 'ban') return OK;
  const allowed = rules?.[id]?.allowedSteps;
  if (allowed && !allowed.includes(state.step)) {
    return illegal('step', `${id} cannot be picked at step ${state.step + 1}.`);
  }
  const slots = slotsOf(rules, id);
  for (let i = 0; i < slots; i++) {
    const s = steps[state.step + i];
    if (!s || s.team !== step.team || s.action !== 'pick') {
      return illegal('slots', `${id} needs ${slots} consecutive picks for team ${step.team}.`);
    }
  }
  return OK;
}

export function chooseSequential(state: SequentialState, id: string | null): DraftResult<SequentialState> {
  const check = checkSequential(state, id);
  if (!check.ok) return check;
  const step = state.config.steps[state.step]!;
  const span = id !== null && step.action === 'pick' ? slotsOf(state.config.rules, id) : 1;
  const choice = state.choices.length;
  const filled = [...state.filled];
  for (let i = 0; i < span; i++) {
    const s = state.config.steps[state.step + i]!;
    filled.push({ step: state.step + i, team: s.team, action: s.action, id, choice });
  }
  const taken = new Set(state.taken);
  if (id !== null) taken.add(id);
  const next = state.step + span;
  return {
    ok: true,
    state: {
      config: state.config,
      choices: [...state.choices, id],
      filled,
      step: next,
      complete: next >= state.config.steps.length,
      taken,
    },
  };
}

/**
 * Apply choices in order, stopping at the first illegal one (for URL/state restore: bad input
 * degrades to the longest legal prefix instead of throwing).
 */
export function replaySequential(
  config: SequentialConfig,
  choices: readonly (string | null)[],
): { state: SequentialState; applied: number; error?: Illegal } {
  let state = startSequential(config);
  for (let i = 0; i < choices.length; i++) {
    const r = chooseSequential(state, choices[i] ?? null);
    if (!r.ok) return { state, applied: i, error: r };
    state = r.state;
  }
  return { state, applied: choices.length };
}

/** Remove the last decision (a 2-slot pick is undone as one decision). */
export function undoSequential(state: SequentialState): SequentialState {
  if (state.choices.length === 0) return state;
  return replaySequential(state.config, state.choices.slice(0, -1)).state;
}

function idsWhere(filled: readonly FilledStep[], team: Team, action: DraftAction): string[] {
  const out: string[] = [];
  let last = -1;
  for (const f of filled) {
    if (f.team !== team || f.action !== action || f.id === null || f.choice === last) continue;
    last = f.choice;
    out.push(f.id);
  }
  return out;
}

export const picksOf = (state: SequentialState, team: Team): string[] => idsWhere(state.filled, team, 'pick');
export const bansOf = (state: SequentialState, team: Team): string[] => idsWhere(state.filled, team, 'ban');

/** Steps of `action` still open for `team`, counting the current one. */
export function remainingSteps(state: SequentialState, team: Team, action: DraftAction): number {
  let n = 0;
  for (let i = state.step; i < state.config.steps.length; i++) {
    const s = state.config.steps[i]!;
    if (s.team === team && s.action === action) n++;
  }
  return n;
}

/** Candidates (in input order) that are legal at the current step. */
export function legalCandidates(state: SequentialState, ids: readonly string[]): string[] {
  return ids.filter((id) => checkSequential(state, id).ok);
}

// ---- free mode --------------------------------------------------------------------------------

export interface FreeConfig {
  teamSize: number;
  /** Bans per team. */
  maxBans: number;
  /** Slot costs apply; allowedSteps is ignored (there are no steps). */
  rules?: EntityRules;
}

export interface FreeMove {
  team: Team;
  action: DraftAction;
  id: string;
}

export interface FreeState {
  readonly config: FreeConfig;
  readonly moves: readonly FreeMove[];
  readonly taken: ReadonlySet<string>;
}

export interface FreeTeam {
  picks: string[];
  bans: string[];
  /** Pick slots used, counting multi-slot entities. */
  slotsUsed: number;
}

export function startFree(config: FreeConfig): FreeState {
  return { config, moves: [], taken: new Set() };
}

export function freeTeam(state: FreeState, team: Team): FreeTeam {
  const out: FreeTeam = { picks: [], bans: [], slotsUsed: 0 };
  for (const m of state.moves) {
    if (m.team !== team) continue;
    if (m.action === 'ban') out.bans.push(m.id);
    else {
      out.picks.push(m.id);
      out.slotsUsed += slotsOf(state.config.rules, m.id);
    }
  }
  return out;
}

export function checkFree(state: FreeState, move: FreeMove): Legality {
  if (move.team !== 'A' && move.team !== 'B') return illegal('invalid', 'Unknown team.');
  if (move.action !== 'ban' && move.action !== 'pick') return illegal('invalid', 'Unknown action.');
  if (typeof move.id !== 'string' || move.id === '') return illegal('invalid', 'Missing id.');
  if (state.taken.has(move.id)) return illegal('taken', `${move.id} is already picked or banned.`);
  const team = freeTeam(state, move.team);
  if (move.action === 'ban') {
    if (team.bans.length >= state.config.maxBans) return illegal('bans', `Team ${move.team} has no bans left.`);
    return OK;
  }
  const slots = slotsOf(state.config.rules, move.id);
  if (team.slotsUsed + slots > state.config.teamSize) {
    return illegal('full', slots > 1 ? `Not enough slots left for ${move.id}.` : `Team ${move.team} is full.`);
  }
  return OK;
}

export function applyFree(state: FreeState, move: FreeMove): DraftResult<FreeState> {
  const check = checkFree(state, move);
  if (!check.ok) return check;
  const taken = new Set(state.taken);
  taken.add(move.id);
  return { ok: true, state: { config: state.config, moves: [...state.moves, { ...move }], taken } };
}

function rebuildFree(config: FreeConfig, moves: readonly FreeMove[]): FreeState {
  return { config, moves: [...moves], taken: new Set(moves.map((m) => m.id)) };
}

/** Remove an entity wherever it was placed (clicking a filled slot). */
export function removeFree(state: FreeState, id: string): FreeState {
  if (!state.taken.has(id)) return state;
  return rebuildFree(
    state.config,
    state.moves.filter((m) => m.id !== id),
  );
}

export function undoFree(state: FreeState): FreeState {
  if (state.moves.length === 0) return state;
  return rebuildFree(state.config, state.moves.slice(0, -1));
}

export function replayFree(
  config: FreeConfig,
  moves: readonly FreeMove[],
): { state: FreeState; applied: number; error?: Illegal } {
  let state = startFree(config);
  for (let i = 0; i < moves.length; i++) {
    const r = applyFree(state, moves[i]!);
    if (!r.ok) return { state, applied: i, error: r };
    state = r.state;
  }
  return { state, applied: moves.length };
}

// ---- scoring context --------------------------------------------------------------------------

/** What a provider needs to score one candidate. Allies/enemies are from `team`'s side. */
export interface DraftContext {
  team: Team;
  action: DraftAction;
  allies: readonly string[];
  enemies: readonly string[];
  /** Every ban so far (both teams). */
  bans: readonly string[];
  /** Pick slots `team` still has, including the current one. */
  picksLeft: number;
  enemyPicksLeft: number;
  step?: number;
  map?: string;
}

/** Context for the team on the clock, or null when the draft is complete. */
export function sequentialContext(state: SequentialState, extra: { map?: string } = {}): DraftContext | null {
  const step = currentStep(state);
  if (!step) return null;
  const enemy = otherTeam(step.team);
  const ctx: DraftContext = {
    team: step.team,
    action: step.action,
    allies: picksOf(state, step.team),
    enemies: picksOf(state, enemy),
    bans: [...bansOf(state, 'A'), ...bansOf(state, 'B')],
    picksLeft: remainingSteps(state, step.team, 'pick'),
    enemyPicksLeft: remainingSteps(state, enemy, 'pick'),
    step: step.index,
  };
  if (extra.map !== undefined) ctx.map = extra.map;
  return ctx;
}

export function freeContext(state: FreeState, team: Team, action: DraftAction = 'pick', extra: { map?: string } = {}): DraftContext {
  const own = freeTeam(state, team);
  const other = freeTeam(state, otherTeam(team));
  const ctx: DraftContext = {
    team,
    action,
    allies: own.picks,
    enemies: other.picks,
    bans: [...freeTeam(state, 'A').bans, ...freeTeam(state, 'B').bans],
    picksLeft: Math.max(0, state.config.teamSize - own.slotsUsed),
    enemyPicksLeft: Math.max(0, state.config.teamSize - other.slotsUsed),
  };
  if (extra.map !== undefined) ctx.map = extra.map;
  return ctx;
}

/** The same moment seen from the other side: ban providers ask "how good is this for them?". */
export function asOpponent(ctx: DraftContext): DraftContext {
  return {
    ...ctx,
    team: otherTeam(ctx.team),
    allies: ctx.enemies,
    enemies: ctx.allies,
    picksLeft: ctx.enemyPicksLeft,
    enemyPicksLeft: ctx.picksLeft,
  };
}

// ---- scorer -----------------------------------------------------------------------------------

export type SignalKey = 'winrate' | 'counters' | 'synergy' | 'map' | 'tier' | 'theory' | 'votes' | 'role' | 'pool';

export const SIGNAL_KEYS: readonly SignalKey[] = Object.freeze([
  'winrate',
  'counters',
  'synergy',
  'map',
  'tier',
  'theory',
  'votes',
  'role',
  'pool',
]);

/**
 * One piece of evidence about a candidate. `value` is logit-like and roughly −1..1, on the
 * same scale as the 1–100 ring: 1.0 ≈ a 4 pp edge (see valueFromDelta). Providers may return
 * several signals with the same key (e.g. one per enemy) so each carries its own reason.
 * Theory-backed counters/synergies use the 'counters'/'synergy' keys with Reason kind 'theory'.
 */
export interface Signal {
  key: SignalKey;
  value: number;
  reasons: Reason[];
}

export type Provider = (candidate: string, ctx: DraftContext) => Signal | readonly Signal[] | null | undefined;

export type Weights = Readonly<Partial<Record<SignalKey, number>>>;

export type PresetId = 'composite' | 'winrate' | 'counters' | 'synergy' | 'map' | 'tier' | 'community';

/** heroescounters' sort modes as weight presets (critique D7). Data, so games may override. */
export const WEIGHT_PRESETS: Readonly<Record<PresetId, Weights>> = Object.freeze({
  composite: Object.freeze({ winrate: 1, counters: 1, synergy: 0.8, map: 0.6, tier: 0.3, theory: 0.5, votes: 0.5, role: 1, pool: 0.5 }),
  winrate: Object.freeze({ winrate: 1 }),
  counters: Object.freeze({ counters: 1 }),
  synergy: Object.freeze({ synergy: 1 }),
  map: Object.freeze({ map: 1 }),
  tier: Object.freeze({ tier: 1 }),
  community: Object.freeze({ votes: 1 }),
});

export const PRESET_IDS: readonly PresetId[] = Object.freeze(Object.keys(WEIGHT_PRESETS) as PresetId[]);

export interface ScoredSignal extends Signal {
  weight: number;
  /** weight × value. */
  contribution: number;
}

export interface Ranked {
  id: string;
  /** 0–100 display score = round(50 + 50·tanh(raw)). */
  score: number;
  /** Σ weight × value. */
  raw: number;
  signals: ScoredSignal[];
  /** Sum of contributions per key, for a tap-to-open breakdown. */
  byKey: Partial<Record<SignalKey, number>>;
  /** Up to `maxReasons` reasons from the largest positive contributions. */
  reasons: Reason[];
  /** The single most negative contribution's reason, if it is below −warnBelow. */
  warning?: Reason;
}

export interface ScoreState {
  candidates: readonly string[];
  context: DraftContext;
}

export interface ScoreOptions {
  /** Default 3. */
  maxReasons?: number;
  /** Contributions below −warnBelow can produce a warning (default 0.1 ≈ a 0.4 pp edge). */
  warnBelow?: number;
}

/** Signal value for an effect of Δ pp (4 pp → 1.0). */
export function valueFromDelta(deltaPp: number): number {
  return Number.isFinite(deltaPp) ? deltaPp / SCORE_SCALE_PP : 0;
}

/** Inverse of the 1–100 ring mapping: score 88 → ≈1.0, 50 → 0. Clamped to ±3. */
export function valueFromScore(score: number): number {
  if (!Number.isFinite(score)) return 0;
  const x = Math.min(0.995, Math.max(-0.995, (score - 50) / 50));
  return Math.max(-3, Math.min(3, Math.atanh(x)));
}

export function displayScore(raw: number): number {
  if (!Number.isFinite(raw)) return 50;
  return Math.min(100, Math.max(0, Math.round(50 + 50 * Math.tanh(raw))));
}

interface ReasonCandidate {
  reason: Reason;
  contribution: number;
  order: number;
}

/**
 * Score every candidate: run each provider, weight each signal, sum, and pick explanations.
 * Sorted by raw score (desc) then id, so equal scores always come out in the same order.
 */
export function scoreCandidates(
  state: ScoreState,
  providers: readonly Provider[],
  weights: Weights,
  opts: ScoreOptions = {},
): Ranked[] {
  const maxReasons = opts.maxReasons ?? 3;
  const warnBelow = opts.warnBelow ?? 0.1;
  const seen = new Set<string>();
  const ranked: Ranked[] = [];
  for (const id of state.candidates) {
    if (seen.has(id)) continue;
    seen.add(id);
    const signals: ScoredSignal[] = [];
    for (const provider of providers) {
      const out = provider(id, state.context);
      if (!out) continue;
      const list: readonly Signal[] = Array.isArray(out) ? (out as readonly Signal[]) : [out as Signal];
      for (const s of list) {
        if (!Number.isFinite(s.value)) continue;
        const weight = weights[s.key] ?? 0;
        signals.push({ ...s, weight, contribution: weight * s.value });
      }
    }
    let raw = 0;
    const byKey: Partial<Record<SignalKey, number>> = {};
    const pool: ReasonCandidate[] = [];
    signals.forEach((s, i) => {
      raw += s.contribution;
      byKey[s.key] = (byKey[s.key] ?? 0) + s.contribution;
      s.reasons.forEach((reason, j) => pool.push({ reason, contribution: s.contribution, order: i * 1000 + j }));
    });
    const byStrength = (x: ReasonCandidate, y: ReasonCandidate): number =>
      Math.abs(y.contribution) - Math.abs(x.contribution) || x.order - y.order;
    const negatives = pool.filter((p) => p.contribution < -warnBelow).sort(byStrength);
    const reasons: Reason[] = [];
    const texts = new Set<string>();
    for (const p of pool.filter((q) => q.contribution > 1e-9).sort(byStrength)) {
      if (reasons.length >= maxReasons) break;
      if (texts.has(p.reason.text)) continue;
      texts.add(p.reason.text);
      reasons.push(p.reason);
    }
    const entry: Ranked = { id, score: displayScore(raw), raw, signals, byKey, reasons };
    if (negatives[0]) entry.warning = negatives[0].reason;
    ranked.push(entry);
  }
  ranked.sort((x, y) => y.raw - x.raw || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return ranked;
}
