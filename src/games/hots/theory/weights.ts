/**
 * Calibration constants of the theory engine (SPEC §5.1.6). Browser-safe.
 *
 *   x(a, b) = cap(Σ rule weight × min(side factors))  +  curated pair weight,   clamped to ±X_CLAMP
 *   score   = round(50 + 50 · tanh(x))
 *
 * A single strong rule (weight 0.3-0.4) lands at 65-69; stacked generic rules stop at RULE_CAP
 * (77), a curated pair on top reaches 83-92, and the clamp keeps everything inside 2..98.
 */
import type { z } from 'zod';
import type { ConfidenceSchema } from '../schema.ts';

export type Confidence = z.infer<typeof ConfidenceSchema>;

/** Default weight of a curated pair by confidence. */
export const CONFIDENCE_WEIGHT: Readonly<Record<Confidence, number>> = Object.freeze({ low: 0.2, medium: 0.4, high: 0.6 });

export const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = Object.freeze({ low: 0, medium: 1, high: 2 });

/**
 * A rule counts at this fraction of its weight when a side only matches through a tag the hero
 * gets from a talent (or from one of several Heroic choices). Not compounded across sides.
 */
export const OPTIONAL_FACTOR = 0.6;

/**
 * The generic rules of one pair (or one hero on one map) add up to at most this much (score 77),
 * so a hero with many generic weaknesses does not look hard-countered by everyone and a curated
 * pair (0.2-0.6) still moves the score (SPEC §5.1.6: "each rule counted once per pair, capped").
 */
export const RULE_CAP = 0.6;

/** |x| never exceeds this before tanh (score 2..98). */
export const X_CLAMP = 2;

/**
 * Generic-rule edges scoring within this many points of 50 (46..54: a single mild rule reached only
 * through a talent, or rules that cancel out) are left out of theory.json and the draft shard.
 * Curated pairs are always kept. Pages list theory edges only from THEORY_GATES.listMinScore
 * (load.ts), so pruning changes nothing they list and roughly halves the file.
 */
export const PRUNE_MARGIN = 4;

/** True when a generic-rule edge is too close to neutral to keep (see PRUNE_MARGIN). */
export function negligible(score: number): boolean {
  return Math.abs(score - 50) <= PRUNE_MARGIN;
}

/** Σ rule contributions limited to ±RULE_CAP. */
export function capRules(sum: number): number {
  return Math.max(-RULE_CAP, Math.min(RULE_CAP, sum));
}

/** Score of an accumulated x: round(50 + 50·tanh(clamp(x))), always within 1..100. */
export function theoryScore(x: number): number {
  const clamped = Math.max(-X_CLAMP, Math.min(X_CLAMP, x));
  return Math.max(1, Math.min(100, Math.round(50 + 50 * Math.tanh(clamped))));
}
