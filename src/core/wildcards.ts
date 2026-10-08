import { isBasicLand, wildcardRarity } from './cards.js';
import { allEntries, type ResolvedDeck } from './deck.js';
import { RARITIES, type CardRecord, type Rarity } from './types.js';

export type WildcardCounts = Record<Rarity, number>;

export const zeroWildcards = (): WildcardCounts => ({ common: 0, uncommon: 0, rare: 0, mythic: 0 });

/** Arena's collection tops out at 4 copies, which also covers "any number" cards. */
export const ARENA_MAX_COPIES = 4;

export interface WildcardReport {
  byRarity: WildcardCounts;
  total: number;
  cards: { name: string; qty: number; rarity: Rarity }[];
  unavailable: string[];
  notes: string[];
}

/**
 * Wildcards needed to craft the deck from nothing: copies across main, sideboard, commander
 * and companion (capped at 4 per card), each at its cheapest Arena rarity. Basic lands are free.
 */
export function wildcardCost(deck: ResolvedDeck): WildcardReport {
  const totals = new Map<string, { qty: number; card: CardRecord }>();
  for (const { zone, e } of allEntries(deck)) {
    if (zone === 'companion' && deck.side.some((s) => s.oracleId === e.oracleId)) continue;
    const t = totals.get(e.oracleId) ?? { qty: 0, card: e.card };
    t.qty += e.qty;
    totals.set(e.oracleId, t);
  }
  const byRarity = zeroWildcards();
  const cards: WildcardReport['cards'] = [];
  const unavailable: string[] = [];
  for (const { qty, card } of totals.values()) {
    if (isBasicLand(card)) continue;
    if (!card.onArena) {
      unavailable.push(card.name);
      continue;
    }
    const n = Math.min(qty, ARENA_MAX_COPIES);
    const rarity = wildcardRarity(card);
    byRarity[rarity] += n;
    cards.push({ name: card.name, qty: n, rarity });
  }
  cards.sort((a, b) => RARITIES.indexOf(b.rarity) - RARITIES.indexOf(a.rarity) || (a.name < b.name ? -1 : 1));
  return {
    byRarity,
    total: RARITIES.reduce((s, r) => s + byRarity[r], 0),
    cards,
    unavailable: unavailable.sort(),
    notes: [
      "Counts every copy as uncrafted; Grindstone can't see your collection.",
      'Each card is priced at its lowest-rarity Arena printing. Basic lands are free.',
    ],
  };
}
