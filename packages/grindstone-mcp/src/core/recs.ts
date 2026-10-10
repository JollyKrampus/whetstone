import { type CardIndex, isLand } from './cards.js';
import type { ResolvedDeck } from './deck.js';
import type { CardRecord } from './types.js';

/*
 * Commander recommendations the user pastes in, e.g. text copied from their commander's
 * EDHREC page. Grindstone never fetches EDHREC itself (its terms forbid automated access);
 * it only reads what the user pastes. Parsing is deliberately forgiving: any line that
 * names a card counts, and "52% of 1234 decks" / "+38% synergy" lines that follow a card
 * are attached to it. Headings and other page text are ignored.
 */

export interface Recommendation {
  name: string;
  oracleId: string;
  /** Order in the pasted text, from 0. */
  rank: number;
  /** Share of decks running it, 0-1, when the paste says so. */
  inclusion?: number;
  /** EDHREC-style synergy, -1 to 1, when the paste says so. */
  synergy?: number;
}

export interface RecommendationList {
  commander?: string;
  source: string;
  cards: Map<string, Recommendation>;
  ignoredLines: number;
}

const INCLUSION = /(\d+(?:\.\d+)?)\s*%\s*(?:of\s*[\d,.]+\s*[km]?\s*decks|inclusion)/i;
const SYNERGY = /([+-]?\d+(?:\.\d+)?)\s*%\s*synergy/i;
const DECKS_ONLY = /^[\d,.]+\s*[km]?\s*decks$/i;

export function parseRecommendations(
  text: string,
  index: CardIndex,
  opts: { commander?: string; source?: string } = {},
): RecommendationList {
  const cards = new Map<string, Recommendation>();
  let last: Recommendation | undefined;
  let ignored = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const inc = INCLUSION.exec(line);
    const syn = SYNERGY.exec(line);
    if (inc || syn) {
      if (last && inc) last.inclusion = Math.min(1, Number(inc[1]) / 100);
      if (last && syn) last.synergy = Math.max(-1, Math.min(1, Number(syn[1]) / 100));
      continue;
    }
    if (DECKS_ONLY.test(line)) continue;
    // "1 Card Name", "1x Card Name", "Card Name (SET) 123", "• Card Name"
    const name = line
      .replace(/^[-•*]\s*/, '')
      .replace(/^\d+\s*x?\s+/i, '')
      .replace(/\s+\([A-Za-z0-9]{2,8}\)(?:\s+\S+)?$/, '')
      .trim();
    const card = index.lookup(name);
    if (!card) {
      ignored++;
      continue;
    }
    if (cards.has(card.oracleId)) {
      last = cards.get(card.oracleId);
      continue;
    }
    last = { name: card.name, oracleId: card.oracleId, rank: cards.size };
    cards.set(card.oracleId, last);
  }
  return {
    ...(opts.commander ? { commander: opts.commander } : {}),
    source: opts.source ?? 'pasted by the user',
    cards,
    ignoredLines: ignored,
  };
}

/**
 * 0 when the card isn't on the list; otherwise 0.6-1, from inclusion and synergy when the
 * paste had them, else from its position in the list.
 */
export function recommendationScore(recs: RecommendationList, card: CardRecord): number {
  const r = recs.cards.get(card.oracleId);
  if (!r) return 0;
  if (r.inclusion === undefined && r.synergy === undefined) {
    return 1 - 0.4 * (r.rank / Math.max(1, recs.cards.size));
  }
  const inclusion = r.inclusion ?? 0.3;
  const synergy = Math.max(0, r.synergy ?? 0);
  return 0.6 + 0.25 * inclusion + 0.15 * Math.min(1, synergy * 2);
}

export function describeRecommendation(recs: RecommendationList, card: CardRecord): string | null {
  const r = recs.cards.get(card.oracleId);
  if (!r) return null;
  const bits: string[] = [];
  if (r.inclusion !== undefined) bits.push(`${Math.round(r.inclusion * 100)}% of decks`);
  if (r.synergy !== undefined) bits.push(`${r.synergy >= 0 ? '+' : ''}${Math.round(r.synergy * 100)}% synergy`);
  const who = recs.commander ? ` for ${recs.commander}` : '';
  return `it's on your recommendation list${who}${bits.length ? ` (${bits.join(', ')})` : ''}`;
}

/** How the pasted list lines up with the deck, for reporting. */
export function recommendationSummary(recs: RecommendationList, deck: ResolvedDeck, index: CardIndex, legalityKey: string) {
  const spells = deck.main.filter((e) => !isLand(e.card));
  const inDeck = spells.filter((e) => recs.cards.has(e.oracleId));
  let unavailable = 0;
  for (const r of recs.cards.values()) {
    const c = index.byOracle.get(r.oracleId);
    if (!c || !c.onArena || !['legal', 'restricted'].includes(c.legalities[legalityKey] ?? '')) unavailable++;
  }
  const notes: string[] = [];
  if (recs.commander && deck.commander && recs.commander.toLowerCase() !== deck.commander.name.toLowerCase()) {
    const front = deck.commander.card.faces[0]?.name.toLowerCase();
    if (recs.commander.toLowerCase() !== front) {
      notes.push(`The recommendations are for ${recs.commander}, but this deck's commander is ${deck.commander.name}.`);
    }
  }
  return {
    source: recs.source,
    cardsRecognized: recs.cards.size,
    linesIgnored: recs.ignoredLines,
    alreadyInDeck: inDeck.length,
    notOnArenaOrNotLegal: unavailable,
    notes,
  };
}
