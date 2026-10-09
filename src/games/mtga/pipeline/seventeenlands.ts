/**
 * 17Lands public datasets (CC BY 4.0) → per-set Limited card ratings.
 *
 * Only the published S3 files are used (game data and draft data CSV.gz, plus cards.csv), never
 * the 17Lands web API. Each CSV is decompressed and aggregated as a stream:
 *
 *   game data  → GP/OH/GD/GNS/GIH counts and win rates, IWD, colour-pair win rates
 *   draft data → ATA (average pick taken), ALSA (average pick last seen), number of drafts
 *
 * Definitions (all per game, counting a card once per game however many copies were seen):
 *   GP  = games with the card in the main deck          GIH = OH + GD
 *   OH  = games with it in the opening hand             GNS = in the deck, never drawn or tutored
 *   GD  = games where it was drawn but not in the opening hand
 *   IWD = GIH WR − GNS WR, in percentage points
 * Node-only.
 */
import type { CardIndex } from '#vendor/grindstone/core.js';
import { COLORS, limitedFile, type CardRating, type LimitedFormat, type LimitedIndex, type LimitedRatings } from '../schema.ts';
import { intAt, parseCsvLine, readCsvObjects, scanFields, truthyAt } from './csv.ts';

export const S3_BASE = 'https://17lands-public.s3.amazonaws.com/analysis_data';
export const DATASETS_PAGE = 'https://www.17lands.com/public_datasets';
export const CC_BY = 'https://creativecommons.org/licenses/by/4.0/';

export const ATTRIBUTION = {
  source: '17lands',
  text: 'Limited ratings derived from 17Lands public datasets',
  url: DATASETS_PAGE,
  license: 'CC BY 4.0',
  licenseUrl: CC_BY,
} as const;

export function gameDataUrl(set: string, format: LimitedFormat): string {
  return `${S3_BASE}/game_data/game_data_public.${set}.${format}.csv.gz`;
}
export function draftDataUrl(set: string, format: LimitedFormat): string {
  return `${S3_BASE}/draft_data/draft_data_public.${set}.${format}.csv.gz`;
}
export const CARDS_CSV_URL = `${S3_BASE}/cards/cards.csv`;

const RARITY: Record<string, CardRating['rarity']> = {
  common: 'common',
  basic: 'common',
  token: 'common',
  uncommon: 'uncommon',
  rare: 'rare',
  special: 'rare',
  bonus: 'rare',
  mythic: 'mythic',
};

const BASIC_NAMES = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest', 'Wastes']);

/** Colours in WUBRG order without duplicates ('' for colourless). Unknown letters are dropped. */
export function wubrg(text: string): string {
  const upper = text.toUpperCase();
  return COLORS.filter((c) => upper.includes(c)).join('');
}

const round = (n: number, digits: number): number => {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
};
const rate = (wins: number, games: number): number | null => (games > 0 ? round(wins / games, 4) : null);

// ---- cards.csv ---------------------------------------------------------------------------

export interface CardMeta {
  rarity: CardRating['rarity'];
  colors: string;
  arenaIds: number[];
  basic: boolean;
}

/** cards.csv → expansion (upper case) → card name → rarity, colours and Arena ids. */
export async function parseCardsCsv(lines: AsyncIterable<string> | Iterable<string>): Promise<Map<string, Map<string, CardMeta>>> {
  const out = new Map<string, Map<string, CardMeta>>();
  for (const row of await readCsvObjects(lines)) {
    const set = (row.expansion ?? '').toUpperCase();
    const name = row.name ?? '';
    if (!set || !name) continue;
    let bySet = out.get(set);
    if (!bySet) out.set(set, (bySet = new Map()));
    const id = Number(row.id);
    const prev = bySet.get(name);
    if (prev) {
      if (Number.isInteger(id) && id > 0 && !prev.arenaIds.includes(id)) prev.arenaIds.push(id);
      continue;
    }
    bySet.set(name, {
      rarity: RARITY[(row.rarity ?? '').toLowerCase()] ?? 'common',
      colors: wubrg(row.color_identity ?? ''),
      arenaIds: Number.isInteger(id) && id > 0 ? [id] : [],
      basic: /^basic\b/i.test(row.types ?? '') || BASIC_NAMES.has(name),
    });
  }
  for (const bySet of out.values()) for (const m of bySet.values()) m.arenaIds.sort((a, b) => a - b);
  return out;
}

// ---- game data ---------------------------------------------------------------------------

const K_WON = 1;
const K_MAIN = 2;
const K_SPLASH = 3;
const K_OH = 10;
const K_DRAWN = 11;
const K_TUTORED = 12;
const K_DECK = 13;
const CARD_PREFIX: [string, number][] = [
  ['opening_hand_', K_OH],
  ['drawn_', K_DRAWN],
  ['tutored_', K_TUTORED],
  ['deck_', K_DECK],
];

export interface GameAggregate {
  games: number;
  /** Card names in header order. */
  names: string[];
  gp: Int32Array;
  gpW: Int32Array;
  oh: Int32Array;
  ohW: Int32Array;
  gd: Int32Array;
  gdW: Int32Array;
  gns: Int32Array;
  gnsW: Int32Array;
  pairs: Map<string, { games: number; wins: number }>;
}

/** Streaming aggregator over game_data rows (feed the header first). */
export function createGameAggregator() {
  let kinds: Int8Array | null = null;
  let cardOf: Int32Array | null = null;
  const names: string[] = [];
  let agg: GameAggregate | null = null;
  // Per-row scratch.
  let oh = new Int32Array(0);
  let drawn = new Int32Array(0);
  let tutored = new Int32Array(0);
  let inDeck: number[] = [];

  function header(line: string): void {
    const cols = parseCsvLine(line);
    kinds = new Int8Array(cols.length);
    cardOf = new Int32Array(cols.length).fill(-1);
    const index = new Map<string, number>();
    const cardIndex = (name: string): number => {
      let i = index.get(name);
      if (i === undefined) {
        i = names.length;
        names.push(name);
        index.set(name, i);
      }
      return i;
    };
    cols.forEach((raw, c) => {
      const col = raw.trim();
      if (col === 'won') kinds![c] = K_WON;
      else if (col === 'main_colors') kinds![c] = K_MAIN;
      else if (col === 'splash_colors') kinds![c] = K_SPLASH;
      else {
        for (const [prefix, kind] of CARD_PREFIX) {
          if (col.startsWith(prefix) && col.length > prefix.length) {
            kinds![c] = kind;
            cardOf![c] = cardIndex(col.slice(prefix.length));
            break;
          }
        }
      }
    });
    if (!kinds.includes(K_WON)) throw new Error('17Lands game data header has no "won" column');
    if (names.length === 0) throw new Error('17Lands game data header has no card columns');
    const n = names.length;
    const z = () => new Int32Array(n);
    agg = { games: 0, names, gp: z(), gpW: z(), oh: z(), ohW: z(), gd: z(), gdW: z(), gns: z(), gnsW: z(), pairs: new Map() };
    oh = z();
    drawn = z();
    tutored = z();
  }

  function row(line: string): void {
    if (!agg || !kinds || !cardOf) throw new Error('header first');
    const k = kinds;
    const card = cardOf;
    let won = false;
    let main = '';
    let splash = '';
    inDeck = [];
    scanFields(line, (col, start, end, quoted) => {
      const kind = k[col];
      if (!kind) return;
      if (kind >= K_OH) {
        // Fast path: most card cells are "0".
        if (quoted === null && (start === end || (end - start === 1 && line.charCodeAt(start) === 48))) return;
        const v = quoted === null ? intAt(line, start, end) : Number(quoted);
        if (!(v > 0)) return;
        const i = card[col]!;
        if (kind === K_DECK) inDeck.push(i);
        else if (kind === K_OH) oh[i] = v;
        else if (kind === K_DRAWN) drawn[i] = v;
        else tutored[i] = v;
        return;
      }
      const text = quoted ?? line.slice(start, end);
      if (kind === K_WON) won = truthyAt(text, 0, text.length);
      else if (kind === K_MAIN) main = text;
      else if (kind === K_SPLASH) splash = text;
    });
    agg.games++;
    const w = won ? 1 : 0;
    for (const i of inDeck) {
      agg.gp[i]!++;
      agg.gpW[i]! += w;
      if (oh[i]! > 0) {
        agg.oh[i]!++;
        agg.ohW[i]! += w;
      } else if (drawn[i]! > 0) {
        agg.gd[i]!++;
        agg.gdW[i]! += w;
      } else if (tutored[i] === 0) {
        agg.gns[i]!++;
        agg.gnsW[i]! += w;
      }
    }
    // Clear the per-row scratch (a memset; cheaper than tracking touched cells).
    oh.fill(0);
    drawn.fill(0);
    tutored.fill(0);
    const colors = wubrg(main);
    if (colors) {
      const key = `${colors}|${wubrg(splash) ? 1 : 0}`;
      const p = agg.pairs.get(key) ?? { games: 0, wins: 0 };
      p.games++;
      p.wins += w;
      agg.pairs.set(key, p);
    }
  }

  return {
    header,
    row,
    result(): GameAggregate {
      if (!agg) throw new Error('17Lands game data had no header');
      return agg;
    },
  };
}

/** Aggregate a whole game_data file given its lines. */
export async function aggregateGames(lines: AsyncIterable<string> | Iterable<string>): Promise<GameAggregate> {
  const g = createGameAggregator();
  let first = true;
  for await (const line of lines) {
    if (line === '') continue;
    if (first) {
      g.header(line);
      first = false;
    } else g.row(line);
  }
  return g.result();
}

// ---- draft data --------------------------------------------------------------------------

export interface DraftAggregate {
  drafts: number;
  picks: Map<string, { n: number; sum: number }>;
  lastSeen: Map<string, { n: number; sum: number }>;
}

/** Streaming aggregator over draft_data rows: ATA from `pick`, ALSA from `pack_card_*`. */
export function createDraftAggregator() {
  let draftCol = -1;
  let packCol = -1;
  let pickNoCol = -1;
  let pickCol = -1;
  let cardOf: Int32Array = new Int32Array(0);
  const names: string[] = [];
  const out: DraftAggregate = { drafts: 0, picks: new Map(), lastSeen: new Map() };
  let current = '';
  let currentPack = -1;
  // Last pick (1-based) at which each card was seen in the current pack round.
  let seen = new Int32Array(0);
  let touched: number[] = [];

  function flushPack(): void {
    for (const i of touched) {
      const name = names[i]!;
      const s = out.lastSeen.get(name) ?? { n: 0, sum: 0 };
      s.n++;
      s.sum += seen[i]!;
      out.lastSeen.set(name, s);
      seen[i] = 0;
    }
    touched = [];
  }

  function header(line: string): void {
    const cols = parseCsvLine(line).map((c) => c.trim());
    draftCol = cols.indexOf('draft_id');
    packCol = cols.indexOf('pack_number');
    pickNoCol = cols.indexOf('pick_number');
    pickCol = cols.indexOf('pick');
    if (draftCol < 0 || packCol < 0 || pickNoCol < 0 || pickCol < 0) throw new Error('17Lands draft data header lacks draft_id/pack_number/pick_number/pick');
    cardOf = new Int32Array(cols.length).fill(-1);
    cols.forEach((col, c) => {
      if (col.startsWith('pack_card_') && col.length > 10) {
        cardOf[c] = names.length;
        names.push(col.slice(10));
      }
    });
    seen = new Int32Array(names.length);
  }

  function row(line: string): void {
    let draft = '';
    let pack = -1;
    let pickNo = -1;
    let pick = '';
    const present: number[] = [];
    scanFields(line, (col, start, end, quoted) => {
      if (col === draftCol) draft = quoted ?? line.slice(start, end);
      else if (col === packCol) pack = quoted === null ? intAt(line, start, end) : Number(quoted);
      else if (col === pickNoCol) pickNo = quoted === null ? intAt(line, start, end) : Number(quoted);
      else if (col === pickCol) pick = quoted ?? line.slice(start, end);
      else {
        const i = cardOf[col];
        if (i === undefined || i < 0) return;
        if (quoted === null && (start === end || (end - start === 1 && line.charCodeAt(start) === 48))) return;
        const v = quoted === null ? intAt(line, start, end) : Number(quoted);
        if (v > 0) present.push(i);
      }
    });
    if (!draft || !(pickNo >= 0)) return;
    if (draft !== current || pack !== currentPack) {
      flushPack();
      if (draft !== current) out.drafts++;
      current = draft;
      currentPack = pack;
    }
    const pickNumber = pickNo + 1;
    for (const i of present) {
      if (seen[i] === 0) touched.push(i);
      if (pickNumber > seen[i]!) seen[i] = pickNumber;
    }
    if (pick) {
      const p = out.picks.get(pick) ?? { n: 0, sum: 0 };
      p.n++;
      p.sum += pickNumber;
      out.picks.set(pick, p);
    }
  }

  return {
    header,
    row,
    result(): DraftAggregate {
      flushPack();
      return out;
    },
  };
}

export async function aggregateDrafts(lines: AsyncIterable<string> | Iterable<string>): Promise<DraftAggregate> {
  const d = createDraftAggregator();
  let first = true;
  for await (const line of lines) {
    if (line === '') continue;
    if (first) {
      d.header(line);
      first = false;
    } else d.row(line);
  }
  return d.result();
}

// ---- ratings -----------------------------------------------------------------------------

export interface RatingsInput {
  set: string;
  format: LimitedFormat;
  games: GameAggregate;
  drafts: DraftAggregate | null;
  cards: Map<string, Map<string, CardMeta>> | null;
  index: CardIndex | null;
  gameData: string;
  draftData: string | null;
  lastModified: string;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Find a card's metadata: the set's own row first, then any other expansion (bonus sheets). */
function metaFor(cards: RatingsInput['cards'], set: string, name: string): CardMeta | undefined {
  if (!cards) return undefined;
  const own = cards.get(set)?.get(name);
  if (own) return own;
  for (const [code, bySet] of [...cards.entries()].sort(([a], [b]) => cmp(a, b))) {
    if (code === set) continue;
    const hit = bySet.get(name);
    if (hit) return hit;
  }
  return undefined;
}

/** Build the LimitedRatings file from the aggregates (basic lands dropped, cards sorted by name). */
export function buildRatings(input: RatingsInput): LimitedRatings {
  const g = input.games;
  const cards: CardRating[] = [];
  g.names.forEach((name, i) => {
    const meta = metaFor(input.cards, input.set, name);
    const record = input.index?.lookup(name);
    if (meta?.basic || BASIC_NAMES.has(name) || /\bBasic\b/.test(record?.typeLine ?? '')) return;
    const gp = g.gp[i]!;
    const oh = g.oh[i]!;
    const gd = g.gd[i]!;
    const gih = oh + gd;
    const gihW = g.ohW[i]! + g.gdW[i]!;
    const gihWr = rate(gihW, gih);
    const gnsWr = rate(g.gnsW[i]!, g.gns[i]!);
    const iwd = gih > 0 && g.gns[i]! > 0 ? round((gihW / gih - g.gnsW[i]! / g.gns[i]!) * 100, 2) : null;
    const pick = input.drafts?.picks.get(name);
    const last = input.drafts?.lastSeen.get(name);
    const colors = meta?.colors ?? (record ? record.colors.join('') : '');
    const rarity = meta?.rarity ?? record?.rarity ?? 'common';
    const row: CardRating = {
      name,
      colors: wubrg(colors),
      rarity,
      gp,
      gih,
      oh,
      gd,
      gns: g.gns[i]!,
      gpWr: rate(g.gpW[i]!, gp),
      gihWr,
      ohWr: rate(g.ohW[i]!, oh),
      gdWr: rate(g.gdW[i]!, gd),
      gnsWr,
      iwd,
      alsa: last && last.n > 0 ? round(last.sum / last.n, 2) : null,
      ata: pick && pick.n > 0 ? round(pick.sum / pick.n, 2) : null,
    };
    if (record) row.oracleId = record.oracleId;
    if (meta && meta.arenaIds.length > 0) row.arenaIds = meta.arenaIds;
    if (pick) row.picks = pick.n;
    cards.push(row);
  });
  cards.sort((a, b) => cmp(a.name, b.name));

  const colorPairs = [...g.pairs.entries()]
    .map(([key, p]) => {
      const [colors, splash] = key.split('|') as [string, string];
      return { colors, splash: splash === '1', games: p.games, wins: p.wins, wr: rate(p.wins, p.games) };
    })
    .sort((a, b) => a.colors.length - b.colors.length || cmp(a.colors, b.colors) || Number(a.splash) - Number(b.splash));

  const out: LimitedRatings = {
    set: input.set,
    format: input.format,
    attribution: { ...ATTRIBUTION },
    dataset: { gameData: input.gameData, lastModified: input.lastModified },
    totals: { games: g.games },
    cards,
    colorPairs,
  };
  if (input.draftData) out.dataset.draftData = input.draftData;
  if (input.drafts) out.totals.drafts = input.drafts.drafts;
  return out;
}

/** limited/index.json entries for the given ratings, newest set first (set order given), then format order. */
export function buildLimitedIndex(ratings: readonly LimitedRatings[], setOrder: readonly string[], formatOrder: readonly LimitedFormat[]): LimitedIndex {
  const rank = (set: string) => {
    const i = setOrder.indexOf(set);
    return i < 0 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...ratings]
    .sort((a, b) => rank(a.set) - rank(b.set) || cmp(a.set, b.set) || formatOrder.indexOf(a.format) - formatOrder.indexOf(b.format))
    .map((r) => ({
      set: r.set,
      format: r.format,
      file: limitedFile(r.set, r.format),
      games: r.totals.games,
      lastModified: r.dataset.lastModified,
      ...(r.synthetic ? { synthetic: true as const } : {}),
    }));
}
