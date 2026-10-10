export type Rarity = 'common' | 'uncommon' | 'rare' | 'mythic';
export const RARITIES: Rarity[] = ['common', 'uncommon', 'rare', 'mythic'];
export type Color = 'W' | 'U' | 'B' | 'R' | 'G';
export const COLORS: Color[] = ['W', 'U', 'B', 'R', 'G'];

export interface CardFace {
  name: string;
  manaCost: string;
  typeLine: string;
  oracleText: string;
  power?: string;
  toughness?: string;
}

/** One gameplay card (one Scryfall oracle ID), aggregated over all its printings. */
export interface CardRecord {
  oracleId: string;
  name: string;
  layout: string;
  manaCost: string;
  cmc: number;
  typeLine: string;
  oracleText: string;
  faces: CardFace[];
  colors: Color[];
  colorIdentity: Color[];
  producedMana: string[];
  keywords: string[];
  legalities: Record<string, string>;
  power?: string;
  toughness?: string;
  /** Lowest rarity among all printings. */
  rarity: Rarity;
  /** Lowest rarity among Arena printings (what a wildcard costs), or null if not on Arena. */
  arenaRarity: Rarity | null;
  onArena: boolean;
  arenaIds: number[];
  /** Earliest printing date (YYYY-MM-DD). */
  releasedAt: string;
  /** Latest printing date; Arena printings only when the card is on Arena. */
  latestReleasedAt: string;
  edhrecRank: number | null;
  gameChanger: boolean;
  /**
   * Cheapest paper price in USD across printings (nonfoil, else foil), from the snapshot.
   * Arena has no prices; this is only a tiebreak for "prefer premium" cards.
   */
  priceUsd: number | null;
}

export interface IndexMeta {
  /** Scryfall bulk `updated_at` the index was built from: the data snapshot ID. */
  snapshot: string;
  builtAt: string;
  source: string;
  cardCount: number;
}
