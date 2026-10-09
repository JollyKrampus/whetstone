/**
 * Calibration constants of the theory engine (SPEC §5.1.6). Browser-safe.
 *
 *   x(a, b) = Σ rule weight × side factors  +  curated pair weight,   clamped to ±X_CLAMP
 *   score   = round(50 + 50 · tanh(x))
 *
 * A single strong rule (weight 0.35-0.4) lands at 67-69; three stacked strong rules reach about
 * 90, and the clamp keeps everything inside 2..98.
 */
import type { z } from 'zod';
import type { ConfidenceSchema } from '../schema.ts';

export type Confidence = z.infer<typeof ConfidenceSchema>;

/** Default weight of a curated pair by confidence. */
export const CONFIDENCE_WEIGHT: Readonly<Record<Confidence, number>> = Object.freeze({ low: 0.2, medium: 0.4, high: 0.6 });

export const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = Object.freeze({ low: 0, medium: 1, high: 2 });

/**
 * A tag the hero only gets from a talent (or from one of several Heroic choices) counts at this
 * fraction of a rule's weight, per side.
 */
export const OPTIONAL_FACTOR = 0.6;

/** |x| never exceeds this before tanh (score 2..98). */
export const X_CLAMP = 2;

/** Score of an accumulated x: round(50 + 50·tanh(clamp(x))), always within 1..100. */
export function theoryScore(x: number): number {
  const clamped = Math.max(-X_CLAMP, Math.min(X_CLAMP, x));
  return Math.max(1, Math.min(100, Math.round(50 + 50 * Math.tanh(clamped))));
}
