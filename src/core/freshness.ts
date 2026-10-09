/**
 * Data freshness for the badge and the staleness banner (SPEC §1.8). Pure: callers pass `now`
 * (the build time on the server, Date.now() after hydration), so SSR output is reproducible.
 */
import type { GameMeta, SourceState } from './game.ts';
import { hoursBetween, relativeTime, toTime, type TimeInput } from './format.ts';

export type FreshnessLevel = 'fresh' | 'aging' | 'stale' | 'broken';
export type SourceLevel = FreshnessLevel | 'disabled';

export interface FreshnessThresholds {
  /** Younger than this is fresh (the daily job plus a few hours of slack). */
  freshHours: number;
  /** Younger than this is aging; older is stale (one missed run). */
  agingHours: number;
}

export const FRESHNESS: Readonly<FreshnessThresholds> = Object.freeze({ freshHours: 30, agingHours: 54 });

export interface SourceFreshness {
  id: string;
  name: string;
  status: SourceState;
  fetchedAt: string | null;
  /** null when the source has never been fetched. */
  ageHours: number | null;
  level: SourceLevel;
  label: string;
  detail?: string;
}

export interface Freshness {
  generatedAt: string;
  /** Hours since generatedAt (≥ 0); Infinity when it cannot be parsed. */
  ageHours: number;
  level: FreshnessLevel;
  label: string;
  sources: SourceFreshness[];
  /** Ids of sources that failed and have never produced data. */
  broken: string[];
  /** Ids of sources whose latest fetch failed but last-good data is being shown. */
  degraded: string[];
  disabled: string[];
}

const RANK: Record<FreshnessLevel, number> = { fresh: 0, aging: 1, stale: 2, broken: 3 };

export function levelForAge(ageHours: number, thresholds: FreshnessThresholds = FRESHNESS): 'fresh' | 'aging' | 'stale' {
  if (!Number.isFinite(ageHours)) return 'stale';
  if (ageHours < thresholds.freshHours) return 'fresh';
  if (ageHours < thresholds.agingHours) return 'aging';
  return 'stale';
}

function ageOf(when: TimeInput | null, now: TimeInput): number {
  if (when === null) return Number.POSITIVE_INFINITY;
  const h = hoursBetween(when, now);
  if (!Number.isFinite(h)) return Number.POSITIVE_INFINITY;
  return Math.max(0, h);
}

export interface FreshnessOptions {
  thresholds?: Partial<FreshnessThresholds>;
  /** SourceRef.id → display name (GameMeta only carries ids). */
  names?: Readonly<Record<string, string>>;
}

export function freshness(meta: Pick<GameMeta, 'generatedAt' | 'sources'>, now: TimeInput, opts: FreshnessOptions = {}): Freshness {
  const thresholds = { ...FRESHNESS, ...opts.thresholds };
  const name = (id: string): string => opts.names?.[id] ?? id;

  const sources: SourceFreshness[] = meta.sources.map((s) => {
    const base = { id: s.id, name: name(s.id), status: s.status, fetchedAt: s.fetchedAt };
    const extra = s.detail !== undefined ? { detail: s.detail } : {};
    if (s.status === 'disabled') {
      return { ...base, ageHours: null, level: 'disabled' as const, label: 'Disabled', ...extra };
    }
    const valid = s.fetchedAt !== null && Number.isFinite(toTime(s.fetchedAt));
    if (!valid) {
      const failed = s.status === 'failed' || s.status === 'stale';
      return {
        ...base,
        ageHours: null,
        level: failed ? ('broken' as const) : ('stale' as const),
        label: failed ? 'Failed, no data yet' : 'Never updated',
        ...extra,
      };
    }
    const age = ageOf(s.fetchedAt, now);
    let level: FreshnessLevel = levelForAge(age, thresholds);
    const degraded = s.status === 'failed' || s.status === 'stale';
    // Showing last-good data after a failed fetch is never "fresh".
    if (degraded && RANK[level] < RANK.aging) level = 'aging';
    const when = relativeTime(s.fetchedAt!, now);
    return {
      ...base,
      ageHours: age,
      level,
      label: degraded ? `Last good data ${when} (latest fetch failed)` : `Updated ${when}`,
      ...extra,
    };
  });

  const broken = sources.filter((s) => s.level === 'broken').map((s) => s.id);
  const degraded = sources.filter((s) => s.ageHours !== null && (s.status === 'failed' || s.status === 'stale')).map((s) => s.id);
  const disabled = sources.filter((s) => s.level === 'disabled').map((s) => s.id);

  const ageHours = ageOf(meta.generatedAt, now);
  let level: FreshnessLevel = levelForAge(ageHours, thresholds);
  if (broken.length > 0) level = 'broken';

  let label: string;
  if (level === 'broken') {
    label = `Some data is unavailable: ${broken.map(name).join(', ')}`;
  } else if (!Number.isFinite(ageHours)) {
    label = 'Update time unknown';
  } else if (level === 'stale') {
    label = `Data may be out of date (updated ${relativeTime(meta.generatedAt, now)})`;
  } else {
    label = `Updated ${relativeTime(meta.generatedAt, now)}`;
  }

  return { generatedAt: meta.generatedAt, ageHours, level, label, sources, broken, degraded, disabled };
}
