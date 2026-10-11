/**
 * Community signals: what public discussion says about an entity, in our own words, with links
 * (SPEC §13.3, §13.6). Browser-safe types only. Two producers feed the same shape:
 *   - curated consensus (curated/<game>/consensus.yaml, class A) written by people, with citations;
 *   - the community miner (class D, rebuilt daily, never committed) aggregating forum posts.
 */
import type { Cite, GameId } from './game.ts';

export type CommunityClaimKind = 'counters' | 'countered-by' | 'synergy' | 'strength' | 'build' | 'patch' | 'general';

export interface CommunitySignal {
  /** Stable id: `${game}:${kind}:${subject}:${object ?? ''}`. */
  id: string;
  game: GameId;
  kind: CommunityClaimKind;
  /** Entity id the claim is about (hero, killer, perk, card, Pokémon, Bloodsworn …). */
  subject: string;
  /** Second entity for pair claims (counters, synergy). */
  object?: string;
  /** Lean of the claim, −1 (strongly negative) … +1 (strongly positive); capped (SPEC §13.3). */
  lean: number;
  /** Distinct posters behind the claim (curated claims count their citations). */
  posters: number;
  /** Players disagree materially. */
  contested: boolean;
  /** One sentence in our own words. Never a quote. */
  summary: string;
  /** Up to 5 links to the discussions it came from. */
  cites: Cite[];
  /** 'curated' = consensus.yaml, 'mined' = community miner. */
  origin: 'curated' | 'mined';
  /** ISO date the signal was last confirmed. */
  updatedAt: string;
}
