/**
 * Prop shapes shared by the site-wide components. Browser-safe (types plus tiny pure helpers),
 * so islands and game pages can import them freely.
 */
import type { EdgeSource, Reason } from '../core/game.ts';

export type Tone = 'neutral' | 'accent' | 'positive' | 'negative' | 'warning' | 'info' | 'theory' | 'stats';

export interface BadgeSpec {
  label: string;
  tone?: Tone;
  /** Longer explanation, rendered as visible text for screen readers and as a title. */
  title?: string;
}

/** One tile of an EntityGrid (hero, map, card, Pokémon...). */
export interface EntityTile {
  id: string;
  name: string;
  /** Base-prefixed URL, e.g. navHref('hots', 'hero/abathur/'). */
  href: string;
  /** Base-prefixed image URL. Decorative: the name is always rendered next to it. */
  image?: string;
  subtitle?: string;
  /** Extra search terms: aliases, nicknames, localized names. */
  aliases?: string[];
  /** Facet values keyed by facet id, e.g. { role: 'Tank', franchise: ['Warcraft'] }. */
  facets?: Record<string, string | string[]>;
  badges?: BadgeSpec[];
  /** Grey the tile without hiding it (e.g. not owned, not in pool). */
  dimmed?: boolean;
}

/** A filter dimension rendered as chips. Options default to the distinct values found on the tiles. */
export interface FacetSpec {
  id: string;
  label: string;
  options?: { value: string; label?: string }[];
}

/** Facet as handed to the EntityFilter island (options resolved, with counts). */
export interface ResolvedFacet {
  id: string;
  label: string;
  options: { value: string; label: string; count: number }[];
}

/** One row of a MatchupList (strong against / weak against / good with). */
export interface MatchupRow {
  id: string;
  name: string;
  href?: string;
  image?: string;
  /** 1..100, 50 = neutral. */
  score: number;
  /** Effect in percentage points. */
  delta?: number;
  /** Sample size behind the score. */
  n?: number;
  source: EdgeSource;
  /** Overrides the default label derived from `source` (e.g. "Heroes Profile"). */
  sourceLabel?: string;
  reasons?: Reason[];
  /** Force the greyed low-sample style; by default derived from n via the SPEC §6 gates. */
  lowSample?: boolean;
}

/** One entry of a TierList. */
export interface TierItem {
  id: string;
  name: string;
  href?: string;
  image?: string;
  /** Short metric shown under the name, e.g. "52.4%" or "+1.8 pp". */
  value?: string;
  badges?: BadgeSpec[];
}

export interface TierRow {
  id: string;
  /** Short label in the tier block, e.g. "T1". */
  label: string;
  /** Long label, e.g. "Best". */
  title?: string;
  note?: string;
  items: TierItem[];
}

export interface TabSpec {
  /** Also the panel's element id and URL hash, so keep it stable (e.g. 'counters', 'maps'). */
  id: string;
  label: string;
  /** Small count or note shown after the label. */
  meta?: string;
}

export interface PeriodSpec {
  id: string;
  label: string;
  /** Visible helper text, e.g. "since 2.57 (28 Sep)". */
  note?: string;
}

const EDGE_SOURCE_LABEL: Record<EdgeSource, string> = {
  stats: 'Stats',
  theory: 'Theory',
  curated: 'Curated',
  votes: 'Votes',
  usage: 'Usage',
  replays: 'Replays',
};

const EDGE_SOURCE_TONE: Record<EdgeSource, Tone> = {
  stats: 'stats',
  theory: 'theory',
  curated: 'theory',
  votes: 'neutral',
  usage: 'stats',
  replays: 'stats',
};

export function edgeSourceLabel(source: EdgeSource): string {
  return EDGE_SOURCE_LABEL[source];
}

export function edgeSourceTone(source: EdgeSource): Tone {
  return EDGE_SOURCE_TONE[source];
}
