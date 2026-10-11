/**
 * 17Lands ratings for the Limited table: compact rows (built at page-build time), filtering,
 * sorting and the shareable view state in the URL hash. Browser-safe, no DOM.
 */
import { createHashCodec, field } from '../../../core/urlstate.ts';
import type { Rarity } from '../worker/protocol.ts';

/** One card of a set's ratings, as the table island receives it. Rates are fractions. */
export interface LimitedRow {
  name: string;
  /** Colours in WUBRG order, '' for colourless. */
  colors: string;
  rarity: Rarity;
  gih: number;
  gp: number;
  gpWr: number | null;
  gihWr: number | null;
  ohWr: number | null;
  gdWr: number | null;
  gnsWr: number | null;
  /** Percentage points. */
  iwd: number | null;
  alsa: number | null;
  ata: number | null;
  /** Newest Arena printing, for the card image (absent when the card index lacks it). */
  scryfallId?: string;
  set?: string;
  cn?: string;
}

export const SORT_KEYS = ['name', 'colors', 'rarity', 'gihWr', 'ohWr', 'gdWr', 'gnsWr', 'iwd', 'alsa', 'ata', 'gih', 'gpWr'] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export type SortDir = 'asc' | 'desc';

export const MIN_GAMES = [0, 100, 500, 1000, 2500] as const;
/** Rows with fewer games in hand than this are marked as low sample. */
export const LOW_SAMPLE = 500;

/**
 * Win-rate columns. Sorting by one of them lists low-sample rows (fewer than LOW_SAMPLE games in
 * hand) after all the others, so a card with a lucky handful of games never tops the table.
 */
export const WIN_RATE_KEYS: ReadonlySet<SortKey> = new Set<SortKey>(['gihWr', 'ohWr', 'gdWr', 'gnsWr', 'iwd', 'gpWr']);

/** Lower average pick numbers are better, so they sort ascending by default. */
export const DEFAULT_DIR: Readonly<Record<SortKey, SortDir>> = {
  name: 'asc',
  colors: 'asc',
  rarity: 'desc',
  gihWr: 'desc',
  ohWr: 'desc',
  gdWr: 'desc',
  gnsWr: 'desc',
  iwd: 'desc',
  alsa: 'asc',
  ata: 'asc',
  gih: 'desc',
  gpWr: 'desc',
};

const RARITY_ORDER: Readonly<Record<Rarity, number>> = { common: 0, uncommon: 1, rare: 2, mythic: 3 };
const WUBRG = 'WUBRG';

export interface LimitedView {
  sort: SortKey;
  dir: SortDir;
  /** Deck colours (subset of WUBRG): show cards castable in them; '' = every card. */
  colors: string;
  /** Rarity initials (c u r m); '' = every rarity. */
  rarities: string;
  minGames: number;
  query: string;
}

export const limitedCodec = createHashCodec({
  version: 1,
  maxLength: 200,
  fields: {
    sort: field.enum('s', SORT_KEYS, 'gihWr'),
    dir: field.enum('d', ['asc', 'desc'] as const, 'desc'),
    colors: field.str('c', '', { maxLength: 5, pattern: /^W?U?B?R?G?$/ }),
    rarities: field.str('r', '', { maxLength: 4, pattern: /^c?u?r?m?$/ }),
    minGames: field.int('m', 0, { min: 0, max: 100_000 }),
    query: field.str('q', '', { maxLength: 60 }),
  },
});

/** Canonical WUBRG order of a set of colour letters ("RW" → "WR"). */
export function normColors(letters: string): string {
  return [...WUBRG].filter((c) => letters.toUpperCase().includes(c)).join('');
}

/** Canonical c-u-r-m order of rarity initials. */
export function normRarities(letters: string): string {
  return [...'curm'].filter((c) => letters.toLowerCase().includes(c)).join('');
}

function value(row: LimitedRow, key: SortKey): number | string | null {
  switch (key) {
    case 'name':
      return row.name.toLowerCase();
    case 'colors':
      // Colourless last, then by number of colours, then WUBRG order.
      return row.colors === '' ? '9' : `${row.colors.length}${[...row.colors].map((c) => WUBRG.indexOf(c)).join('')}`;
    case 'rarity':
      return RARITY_ORDER[row.rarity];
    default:
      return row[key];
  }
}

/**
 * Filter and sort; missing numbers always sort last, ties break by name. When sorting by a win
 * rate, low-sample rows come after every other row (in the same order among themselves).
 */
export function viewRows(rows: readonly LimitedRow[], v: LimitedView): LimitedRow[] {
  const deck = normColors(v.colors);
  const rar = normRarities(v.rarities);
  const q = v.query.trim().toLowerCase();
  const out = rows.filter(
    (r) =>
      r.gih >= v.minGames &&
      (deck === '' || [...r.colors].every((c) => deck.includes(c))) &&
      (rar === '' || rar.includes(r.rarity[0] ?? '')) &&
      (q === '' || r.name.toLowerCase().includes(q)),
  );
  const sign = v.dir === 'asc' ? 1 : -1;
  const lowLast = WIN_RATE_KEYS.has(v.sort);
  return out.sort((a, b) => {
    if (lowLast) {
      const la = a.gih < LOW_SAMPLE;
      const lb = b.gih < LOW_SAMPLE;
      if (la !== lb) return la ? 1 : -1;
    }
    const x = value(a, v.sort);
    const y = value(b, v.sort);
    if (x === null && y === null) return a.name.localeCompare(b.name);
    if (x === null) return 1;
    if (y === null) return -1;
    if (x < y) return -sign;
    if (x > y) return sign;
    return a.name.localeCompare(b.name);
  });
}

/** Games-in-hand weighted mean GIH WR of the rows (the set's baseline), or null. */
export function averageGihWr(rows: readonly LimitedRow[]): number | null {
  let n = 0;
  let w = 0;
  for (const r of rows) {
    if (r.gihWr === null || r.gih <= 0) continue;
    n += r.gih;
    w += r.gihWr * r.gih;
  }
  return n > 0 ? w / n : null;
}

/** Tint bucket of a win rate against the baseline (the number is always shown too). */
export function wrBand(wr: number | null, avg: number | null): 'hi2' | 'hi1' | 'mid' | 'lo1' | 'lo2' | 'none' {
  if (wr === null || avg === null) return 'none';
  const d = (wr - avg) * 100;
  if (d >= 4) return 'hi2';
  if (d >= 1.5) return 'hi1';
  if (d > -1.5) return 'mid';
  if (d > -4) return 'lo1';
  return 'lo2';
}

/** Human labels for the event types 17Lands publishes. */
export const LIMITED_FORMAT_LABEL: Readonly<Record<string, string>> = {
  PremierDraft: 'Premier Draft',
  TradDraft: 'Traditional Draft',
  QuickDraft: 'Quick Draft',
  Sealed: 'Sealed',
  TradSealed: 'Traditional Sealed',
  PickTwoDraft: 'Pick-Two Draft',
  PickTwoTradDraft: 'Pick-Two Traditional Draft',
};

/** URL segment of a Limited format: 'PremierDraft' → 'premier-draft'. */
export function formatSlug(format: string): string {
  return format.replace(/([a-z])([A-Z])/g, '$1-$2').toLowerCase();
}
