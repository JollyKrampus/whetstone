/**
 * Badge vocabulary on top of src/core/freshness.ts (which owns the thresholds and the source
 * model). Shared by FreshnessBadge (server) and freshnessClient (browser) so both say the same.
 */
import type { FreshnessLevel } from '../core/freshness.ts';

export type BadgeState = FreshnessLevel | 'unknown';

/** Short word shown next to the time; colour is never the only cue. Empty when fresh. */
export const STATE_WORD: Readonly<Record<BadgeState, string>> = {
  fresh: '',
  aging: 'aging',
  stale: 'stale',
  broken: 'partial',
  unknown: 'no data yet',
};
