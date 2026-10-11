/**
 * Build-time loader for community signals (src/core/community.ts). Pages call
 * getCommunitySignals(game, subject); it returns [] until a game ships curated consensus
 * (curated/<game>/consensus.yaml) or the miner's class-D bundle (private/<game>/community.json).
 * The community-miner build fills in the curated reader and gating; the signature is the contract.
 */
import type { CommunitySignal } from '../core/community.ts';
import type { GameId } from '../core/game.ts';
import { readGameJson } from './datadir.ts';

interface CommunityBundle {
  signals: CommunitySignal[];
}

const cache = new Map<GameId, CommunitySignal[]>();

function allSignals(game: GameId): CommunitySignal[] {
  const hit = cache.get(game);
  if (hit) return hit;
  const mined = readMined(game);
  cache.set(game, mined);
  return mined;
}

function readMined(game: GameId): CommunitySignal[] {
  try {
    return readGameJson<CommunityBundle>(game, 'community.json', { optional: true, private: true })?.signals ?? [];
  } catch {
    // A missing or unreadable bundle means "no community layer yet", never a broken page.
    return [];
  }
}

/** Signals about `subject` (as subject or object), strongest first. */
export function getCommunitySignals(game: GameId, subject: string): CommunitySignal[] {
  return allSignals(game)
    .filter((s) => s.subject === subject || s.object === subject)
    .sort((a, b) => Math.abs(b.lean) * b.posters - Math.abs(a.lean) * a.posters || a.id.localeCompare(b.id));
}
