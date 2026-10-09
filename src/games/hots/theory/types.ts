/**
 * Shared types of the HotS theory layer (SPEC §5.1). Types only: safe to import anywhere.
 */
import type { Confidence } from './weights.ts';
import type { CuratedMapsFile, Hero, HeroTag, RulesFile } from '../schema.ts';

/** A hero record before the theory layer has added `mechanics` (what the pipeline builds first). */
export type HeroInput = Omit<Hero, 'mechanics'>;

/** One curated trait after loading: which file asserted it and why. */
export interface CuratedTraitEntry {
  tag: HeroTag;
  why: string;
  op: 'add' | 'remove';
  /** Path relative to curated/hots/, e.g. `traits.yaml` or `heroes/abathur.yaml`. */
  source: string;
}

/**
 * One curated matchup after merging every file that mentions it (one per kind and pair).
 * Counters are directed (a counters b); synergies are stored with a < b (slug order).
 */
export interface MergedPair {
  a: string;
  b: string;
  /** Up to two distinct handwritten reasons, in file order. */
  why: string[];
  /** Union of the ability/talent names the reasons rely on. */
  evidence: string[];
  /** Union of talents or situations the matchup depends on. */
  conditions: string[];
  /** Highest confidence any file gave. */
  confidence: Confidence;
  /** Explicit weight when a file set one, else the weight implied by `confidence`. */
  weight: number;
  /** Newest major any file reviewed the pair for. */
  reviewedFor: string;
  /** Files that mention the pair, relative to curated/hots/, sorted. */
  sources: string[];
}

/** Everything the theory engine needs from curated/hots/, validated and merged. */
export interface CuratedBundle {
  rules: RulesFile;
  maps: CuratedMapsFile;
  /** Hero slug → curated traits (traits.yaml first, then per-hero files). */
  traits: Record<string, CuratedTraitEntry[]>;
  /** Directed, sorted by (a, b). */
  counters: MergedPair[];
  /** Undirected (a < b), sorted by (a, b). */
  synergies: MergedPair[];
  /** aliases.yaml hero slugs → extra search aliases (passed through for the pipeline). */
  aliases: Record<string, string[]>;
  /** Per-hero files that were read, relative to curated/hots/, sorted. */
  files: string[];
  /** Non-fatal findings (duplicates, contradictions, stale reviews), sorted. */
  warnings: string[];
}
