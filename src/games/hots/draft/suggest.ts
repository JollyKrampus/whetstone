/**
 * Ranked, explained suggestions for the step on the clock (SPEC §7): picks are scored for the
 * team that picks; bans are scored as threats (the opponent's view via asOpponent). Sort modes
 * are the core weight presets (heroescounters parity); role guardrail warnings stay visible in
 * every mode, even when the mode gives roles no weight.
 *
 * On top of the core scorer this module decides what each suggestion shows: one line per edge
 * (the edge's headline, never two paraphrases of it), one line per rule template (the same rule
 * for another enemy is not a new reason), statistics below the list bar only in the breakdown.
 * Exact score ties are ordered by any provider tie-break (uncapped ban breadth), then by display
 * name, never by the internal attribute id.
 */
import {
  WEIGHT_PRESETS,
  asOpponent,
  scoreCandidates,
  type DraftContext,
  type PresetId,
  type Ranked,
  type ScoredSignal,
  type SignalKey,
  type Weights,
} from '../../../core/draft.ts';
import type { Reason } from '../../../core/game.ts';
import type { DraftData, DraftHero } from './data.ts';
import { banProviders, pickProviders, type DraftReason, type DraftSignal, type ProviderOptions } from './providers.ts';
import type { RoleConfig } from './roles.ts';

export interface PresetInfo {
  id: PresetId;
  label: string;
  /** False when the data this mode sorts by is missing. */
  enabled: boolean;
  /** Why it is disabled: missing statistics or no map chosen (shown as text, never only on hover). */
  why?: 'stats' | 'map';
  /** Visible at all ("Community" only exists with votes data). */
  visible: boolean;
}

export const PRESET_LABEL: Readonly<Record<PresetId, string>> = {
  composite: 'Composite',
  winrate: 'Win rate',
  counters: 'Counters',
  synergy: 'Synergies',
  map: 'Map',
  tier: 'Tier',
  community: 'Community',
};

const ORDER: readonly PresetId[] = ['composite', 'winrate', 'counters', 'synergy', 'map', 'tier', 'community'];

export function presetInfo(opts: { stats: boolean; map: string; votes?: boolean }): PresetInfo[] {
  return ORDER.map((id) => {
    const base = { id, label: PRESET_LABEL[id], enabled: true, visible: true };
    if (id === 'community') return { ...base, enabled: !!opts.votes, visible: !!opts.votes };
    if ((id === 'winrate' || id === 'tier') && !opts.stats) {
      return { ...base, enabled: false, why: 'stats' as const };
    }
    if (id === 'map' && !opts.map) return { ...base, enabled: false, why: 'map' as const };
    return base;
  });
}

/** One sentence explaining every disabled mode, e.g. "Win rate and Tier need match statistics …". */
export function disabledNote(list: readonly PresetInfo[]): string {
  const visible = list.filter((p) => p.visible && !p.enabled);
  const stats = visible.filter((p) => p.why === 'stats').map((p) => p.label);
  const parts: string[] = [];
  if (stats.length) parts.push(`${stats.join(' and ')} need${stats.length === 1 ? 's' : ''} match statistics, which are not available right now.`);
  if (visible.some((p) => p.why === 'map')) parts.push('Choose a map to sort by map fit.');
  return parts.join(' ');
}

/** Weights of a sort mode for pick steps. */
export function pickWeights(preset: PresetId): Weights {
  return WEIGHT_PRESETS[preset];
}

/** Bans: role needs count half (they shape the enemy's draft less than ours), the pool not at all. */
export function banWeights(preset: PresetId): Weights {
  const w = WEIGHT_PRESETS[preset];
  return { ...w, role: (w.role ?? 0) * 0.5, pool: 0 };
}

export interface SuggestRequest extends Omit<ProviderOptions, 'data'> {
  data: DraftData;
  /** Context of the team on the clock (unswapped). */
  ctx: DraftContext;
  /** Legal candidates for this step, any order. */
  candidates: readonly string[];
  preset: PresetId;
  roles?: RoleConfig;
  /** Override the mode's weights (ARAM). */
  weights?: Weights;
}

export interface Suggestion extends Ranked {
  hero: DraftHero;
  /** Signal key behind each shown reason/warning, for labels ("Theory", "Your pool"). */
  keyOf: ReadonlyMap<Reason, SignalKey>;
}

/** Guardrail warnings stronger than this show even when the sort mode ignores roles. */
const ROLE_WARN_BELOW = -0.2;
/** Role signals at or below −this are composition-breaking (infeasible) and always win the warning slot. */
const ROLE_HARD = 0.6;
/** Reasons shown per suggestion (SPEC §7). */
export const MAX_REASONS = 3;
/** Contributions below −this can be the warning (≈ a 0.4 pp edge, as in the core scorer). */
const WARN_BELOW = 0.1;

interface PoolEntry {
  reason: Reason;
  contribution: number;
  order: number;
}

function keysOf(r: Reason): string[] {
  const key = (r as DraftReason).dedupeKey;
  return key ? [key, `text:${r.text}`] : [`text:${r.text}`];
}

/**
 * The reasons a suggestion shows: from the largest positive contributions, headline lines only
 * (DraftReason.detail stays in the breakdown), at most one per dedupe key or text. The warning
 * is the most negative contribution's headline line.
 */
export function pickReasons(signals: readonly ScoredSignal[], max = MAX_REASONS): { reasons: Reason[]; warning?: Reason } {
  const pool: PoolEntry[] = [];
  signals.forEach((s, i) =>
    s.reasons.forEach((reason, j) => {
      if (!(reason as DraftReason).detail) pool.push({ reason, contribution: s.contribution, order: i * 1000 + j });
    }),
  );
  const byStrength = (x: PoolEntry, y: PoolEntry): number => Math.abs(y.contribution) - Math.abs(x.contribution) || x.order - y.order;
  const reasons: Reason[] = [];
  const seen = new Set<string>();
  for (const p of pool.filter((q) => q.contribution > 1e-9).sort(byStrength)) {
    if (reasons.length >= max) break;
    const keys = keysOf(p.reason);
    if (keys.some((k) => seen.has(k))) continue;
    for (const k of keys) seen.add(k);
    reasons.push(p.reason);
  }
  const negative = pool.filter((q) => q.contribution < -WARN_BELOW).sort(byStrength)[0];
  return negative ? { reasons, warning: negative.reason } : { reasons };
}

/** Sum of the signals' tie-break values (e.g. uncapped ban breadth). */
function tiebreakOf(r: Ranked): number {
  return r.signals.reduce((s, sig) => s + ((sig as DraftSignal).tiebreak ?? 0), 0);
}

const collator = new Intl.Collator('en', { sensitivity: 'base' });

/** Final order: total, then the tie-break, then display name (ids only if two names were equal). */
export function compareSuggestions(x: Suggestion, y: Suggestion): number {
  return y.raw - x.raw || tiebreakOf(y) - tiebreakOf(x) || collator.compare(x.hero.name, y.hero.name) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
}

export function suggest(req: SuggestRequest): Suggestion[] {
  const ban = req.ctx.action === 'ban';
  const providerOpts: ProviderOptions = { ...req, data: req.data };
  const providers = ban ? banProviders(providerOpts) : pickProviders(providerOpts);
  const weights = req.weights ?? (ban ? banWeights(req.preset) : pickWeights(req.preset));
  const context = ban ? asOpponent(req.ctx) : req.ctx;
  const ranked = scoreCandidates({ candidates: req.candidates, context }, providers, weights, { maxReasons: 0 });
  const out: Suggestion[] = [];
  for (const r of ranked) {
    const hero = req.data.byId.get(r.id);
    if (!hero) continue;
    const keyOf = new Map<Reason, SignalKey>();
    for (const s of r.signals) for (const reason of s.reasons) if (!keyOf.has(reason)) keyOf.set(reason, s.key);
    const picked = pickReasons(r.signals);
    // Guardrails outrank the mode: an impossible composition is always the warning shown, and
    // any notable role problem is shown when the mode found nothing else to warn about.
    let warning = picked.warning;
    const role = r.signals.filter((s) => s.key === 'role' && s.value < ROLE_WARN_BELOW).sort((a, b) => a.value - b.value)[0];
    if (role?.reasons[0] && (!warning || role.value <= -ROLE_HARD)) warning = role.reasons[0];
    const entry: Suggestion = { ...r, reasons: picked.reasons, hero, keyOf };
    if (warning) entry.warning = warning;
    else delete entry.warning;
    out.push(entry);
  }
  return out.sort(compareSuggestions);
}

/** Display-score spread at or below which the top of a list counts as flat. */
export const FLAT_SPREAD = 2;

/**
 * Is the top of the list flat: do the first `shown` suggestions (at least three) all sit within
 * FLAT_SPREAD display points? Then the order says little, and the UI says so.
 */
export function isFlatTop(list: readonly Ranked[], shown: number): boolean {
  const n = Math.min(shown, list.length);
  if (n < 3) return false;
  return list[0]!.score - list[n - 1]!.score <= FLAT_SPREAD;
}

// ---- breakdown -----------------------------------------------------------------------------------

export const SIGNAL_LABEL: Readonly<Record<SignalKey, string>> = {
  winrate: 'Win rate',
  counters: 'Counters',
  synergy: 'Synergy',
  map: 'Map',
  tier: 'Tier and bans',
  theory: 'Theory (next to stats)',
  votes: 'Votes',
  role: 'Roles',
  pool: 'Your pool',
};

export interface BreakdownRow {
  key: SignalKey;
  label: string;
  weight: number;
  /** Σ value of this key's signals. */
  value: number;
  /** weight × value. */
  contribution: number;
  reasons: { reason: Reason; value: number }[];
}

/** Per-signal rows for the tap-to-open breakdown, strongest contribution first. */
export function breakdown(s: Ranked, weights: Weights): BreakdownRow[] {
  const rows = new Map<SignalKey, BreakdownRow>();
  for (const sig of s.signals) {
    let row = rows.get(sig.key);
    if (!row) {
      const weight = weights[sig.key] ?? 0;
      row = { key: sig.key, label: SIGNAL_LABEL[sig.key], weight, value: 0, contribution: 0, reasons: [] };
      rows.set(sig.key, row);
    }
    row.value += sig.value;
    row.contribution += sig.contribution;
    for (const reason of sig.reasons) row.reasons.push({ reason, value: sig.value });
  }
  return [...rows.values()].sort(
    (a, b) => Math.abs(b.contribution) - Math.abs(a.contribution) || Math.abs(b.value) - Math.abs(a.value) || (a.key < b.key ? -1 : 1),
  );
}

/** Label for a reason line: what kind of evidence it is. */
export function reasonLabel(reason: Reason, key: SignalKey | undefined): string {
  if (key === 'pool') return 'Pool';
  switch (reason.kind) {
    case 'stat':
      return 'Stat';
    case 'theory':
    case 'curated':
      return 'Theory';
    case 'role':
      return 'Role';
    case 'map':
      return 'Map';
    case 'votes':
      return 'Votes';
    case 'pro':
      return 'Pro';
    case 'usage':
      return 'Usage';
    case 'community':
      return 'Community';
    case 'personal':
      return 'Yours';
  }
}

/**
 * The conditions of a reason as one sentence run ("Anduin takes Lightbomb."), shown after an
 * "Only when" label; null when the reason always holds.
 */
export function conditionsText(reason: Reason): string | null {
  const list = (reason.conditions ?? []).map((c) => c.trim()).filter(Boolean);
  if (list.length === 0) return null;
  return list.map((c) => (/[.!?]$/.test(c) ? c : `${c}.`)).join(' ');
}

/** Does any suggestion rest on match statistics (their source must be credited inline)? */
export function usesStats(list: readonly Suggestion[]): boolean {
  return list.some((s) => s.signals.some((sig) => sig.reasons.some((r) => r.kind === 'stat')));
}

/** SourceRef ids behind the given suggestions' weighted signals (for inline credits), first seen first. */
export function sourcesUsed(list: readonly Suggestion[]): string[] {
  const out = new Set<string>();
  for (const s of list) {
    for (const sig of s.signals) {
      if (sig.weight === 0) continue;
      for (const r of sig.reasons) if (r.source) out.add(r.source);
    }
  }
  return [...out];
}
