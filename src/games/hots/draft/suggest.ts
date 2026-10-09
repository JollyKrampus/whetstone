/**
 * Ranked, explained suggestions for the step on the clock (SPEC §7): picks are scored for the
 * team that picks; bans are scored as threats (the opponent's view via asOpponent). Sort modes
 * are the core weight presets (heroescounters parity); role guardrail warnings stay visible in
 * every mode, even when the mode gives roles no weight.
 */
import {
  WEIGHT_PRESETS,
  asOpponent,
  scoreCandidates,
  type DraftContext,
  type PresetId,
  type Ranked,
  type SignalKey,
  type Weights,
} from '../../../core/draft.ts';
import type { Reason } from '../../../core/game.ts';
import type { DraftData, DraftHero } from './data.ts';
import { banProviders, pickProviders, type ProviderOptions } from './providers.ts';
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

export function suggest(req: SuggestRequest): Suggestion[] {
  const ban = req.ctx.action === 'ban';
  const providerOpts: ProviderOptions = { ...req, data: req.data };
  const providers = ban ? banProviders(providerOpts) : pickProviders(providerOpts);
  const weights = req.weights ?? (ban ? banWeights(req.preset) : pickWeights(req.preset));
  const context = ban ? asOpponent(req.ctx) : req.ctx;
  const ranked = scoreCandidates({ candidates: req.candidates, context }, providers, weights);
  const out: Suggestion[] = [];
  for (const r of ranked) {
    const hero = req.data.byId.get(r.id);
    if (!hero) continue;
    const keyOf = new Map<Reason, SignalKey>();
    for (const s of r.signals) for (const reason of s.reasons) if (!keyOf.has(reason)) keyOf.set(reason, s.key);
    // Guardrails outrank the mode: an impossible composition is always the warning shown, and
    // any notable role problem is shown when the mode found nothing else to warn about.
    let warning = r.warning;
    const role = r.signals.filter((s) => s.key === 'role' && s.value < ROLE_WARN_BELOW).sort((a, b) => a.value - b.value)[0];
    if (role?.reasons[0] && (!warning || role.value <= -ROLE_HARD)) warning = role.reasons[0];
    const entry: Suggestion = { ...r, hero, keyOf };
    if (warning) entry.warning = warning;
    else delete entry.warning;
    out.push(entry);
  }
  return out;
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
  }
}

/** Does any shown reason rest on Heroes Profile numbers (inline credit needed)? */
export function usesStats(list: readonly Suggestion[]): boolean {
  return list.some((s) => s.signals.some((sig) => sig.reasons.some((r) => r.kind === 'stat')));
}
