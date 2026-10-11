/**
 * Scryfall `default_cards` bulk data → the analyzer's card shards and sets.json.
 *
 * Every printing is folded by grindstone-mcp's own `aggregateCards` (the exact records the MCP
 * server builds), filtered to Arena, with legalities trimmed to the Arena formats. Alongside the
 * fold we read each printing once more for what grindstone does not keep: the newest Arena
 * printing (so the site can hotlink its image from cards.scryfall.io without an API call) and
 * per-set statistics for sets.json. Node-only.
 */
import { aggregateCards, type CardRecord } from 'grindstone-mcp/core';
import { ARENA_FORMATS, type CardShard, type CompactCardRecord, type MtgSet } from '../schema.ts';

export const SCRYFALL_BULK_URL = 'https://api.scryfall.com/bulk-data/default_cards';
export const SCRYFALL_HEADERS = { accept: 'application/json' } as const;

/** Mirrors grindstone's aggregate filters so set statistics count the same printings. */
const SKIP_LAYOUTS = new Set(['token', 'double_faced_token', 'emblem', 'art_series', 'planar', 'scheme', 'vanguard', 'reversible_card']);
const SKIP_SET_TYPES = new Set(['memorabilia', 'token']);
/** Set types whose sets can be Standard sets. */
const STANDARD_KINDS = new Set(['expansion', 'core']);
/** Share of a set's Arena cards that must be Standard-legal (or banned) for the set to count as a Standard set. */
const STANDARD_SHARE = 0.8;
const IN_STANDARD = new Set(['legal', 'restricted', 'banned']);

/** The `default_cards` entry of Scryfall's bulk-data API. */
export interface BulkInfo {
  updatedAt: string;
  downloadUri: string;
  compressedSize: number | null;
}

/** Validate the bulk-data response and fail loudly on schema drift (download_uri is already gone). */
export function parseBulkInfo(json: unknown): BulkInfo {
  const o = (json ?? {}) as Record<string, unknown>;
  const updatedAt = o.updated_at;
  const uri = o.jsonl_download_uri ?? o.download_uri;
  if (typeof updatedAt !== 'string' || Number.isNaN(Date.parse(updatedAt))) {
    throw new Error('Scryfall bulk-data response has no valid updated_at');
  }
  if (typeof uri !== 'string' || !/^https:\/\/[a-z0-9.-]*scryfall\.io\//.test(uri)) {
    throw new Error(`Scryfall bulk-data response has no usable jsonl_download_uri (got ${JSON.stringify(uri)})`);
  }
  return { updatedAt, downloadUri: uri, compressedSize: typeof o.compressed_size === 'number' ? o.compressed_size : null };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type RawCard = Record<string, any>;

interface Printing {
  id: string;
  set: string;
  cn: string;
  releasedAt: string;
  hasImage: boolean;
}

interface SetAcc {
  code: string;
  name: string;
  kind: string;
  dates: Map<string, number>;
  arena: Set<string>;
  standard: Set<string>;
}

export interface FoldResult {
  /** grindstone CardRecords for every card (Arena or not), sorted by name then oracle id. */
  records: CardRecord[];
  /** Newest Arena printing per oracle id. */
  printings: Map<string, Printing>;
  sets: Map<string, SetAcc>;
  printingCount: number;
}

function hasImage(c: RawCard): boolean {
  const status = c.image_status;
  return status !== 'missing' && status !== 'placeholder' && (c.image_uris !== undefined || Array.isArray(c.card_faces));
}

/** Better printing for images: has an image, then newest, then set code and collector number (deterministic). */
function better(a: Printing, b: Printing): boolean {
  if (a.hasImage !== b.hasImage) return a.hasImage;
  if (a.releasedAt !== b.releasedAt) return a.releasedAt > b.releasedAt;
  if (a.set !== b.set) return a.set < b.set;
  if (a.cn !== b.cn) return a.cn < b.cn;
  return a.id < b.id;
}

/** Fold a stream of bulk JSONL lines (grindstone's aggregate plus Whetstone's extras). */
export async function foldBulk(lines: AsyncIterable<string> | Iterable<string>): Promise<FoldResult> {
  const printings = new Map<string, Printing>();
  const sets = new Map<string, SetAcc>();
  let printingCount = 0;

  async function* observe(): AsyncGenerator<string> {
    for await (const raw of lines) {
      const line = raw.trim().replace(/,$/, '');
      if (!line || line === '[' || line === ']') continue;
      const c = JSON.parse(line) as RawCard;
      printingCount++;
      if (c.oracle_id && !SKIP_LAYOUTS.has(c.layout) && !SKIP_SET_TYPES.has(c.set_type) && typeof c.set === 'string') {
        const onArena = Array.isArray(c.games) && c.games.includes('arena');
        let acc = sets.get(c.set);
        if (!acc) {
          acc = { code: c.set, name: String(c.set_name ?? c.set), kind: String(c.set_type ?? 'unknown'), dates: new Map(), arena: new Set(), standard: new Set() };
          sets.set(c.set, acc);
        }
        if (typeof c.released_at === 'string') acc.dates.set(c.released_at, (acc.dates.get(c.released_at) ?? 0) + 1);
        if (onArena) {
          acc.arena.add(c.oracle_id);
          if (IN_STANDARD.has(c.legalities?.standard)) acc.standard.add(c.oracle_id);
          const p: Printing = { id: c.id, set: c.set, cn: String(c.collector_number ?? ''), releasedAt: c.released_at ?? '', hasImage: hasImage(c) };
          const prev = printings.get(c.oracle_id);
          if (!prev || better(p, prev)) printings.set(c.oracle_id, p);
        }
      }
      yield line;
    }
  }

  const records = await aggregateCards(observe());
  return { records, printings, sets, printingCount };
}

const SET_RE = /^[a-z0-9]{2,6}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A grindstone record as stored in a shard: Arena legalities only, `not_legal` omitted, no null price, image extras added. */
export function toShardRecord(r: CardRecord, printing: Printing | undefined): CompactCardRecord {
  const legalities: Partial<Record<(typeof ARENA_FORMATS)[number], 'legal' | 'not_legal' | 'banned' | 'restricted'>> = {};
  for (const f of ARENA_FORMATS) {
    const v = r.legalities[f];
    if (v === 'legal' || v === 'banned' || v === 'restricted') legalities[f] = v;
  }
  const { priceUsd, ...rest } = r;
  // A missing price stays out of the shard (hydration restores null).
  const out: CompactCardRecord = { ...rest, legalities, ...(priceUsd !== null ? { priceUsd } : {}) };
  if (printing && UUID_RE.test(printing.id) && SET_RE.test(printing.set) && printing.cn !== '') {
    out.scryfallId = printing.id;
    out.set = printing.set;
    out.cn = printing.cn;
  }
  return out;
}

function modeDate(dates: Map<string, number>): string {
  let best = '';
  let count = -1;
  for (const [d, n] of [...dates.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (n > count) {
      best = d;
      count = n;
    }
  }
  return best;
}

/** sets.json: every set with an Arena printing, newest first. */
export function buildSets(fold: Pick<FoldResult, 'sets'>, today: string): MtgSet[] {
  const out: MtgSet[] = [];
  for (const acc of fold.sets.values()) {
    if (acc.arena.size === 0) continue;
    const code = acc.code.toUpperCase();
    if (!/^[A-Z0-9]{2,6}$/.test(code)) continue;
    const releasedAt = modeDate(acc.dates);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(releasedAt)) continue;
    const standard = STANDARD_KINDS.has(acc.kind) && releasedAt <= today && acc.standard.size / acc.arena.size >= STANDARD_SHARE;
    out.push({ code, name: acc.name, releasedAt, kind: acc.kind, arena: true, standard, cardCount: acc.arena.size });
  }
  return out.sort((a, b) => (a.releasedAt !== b.releasedAt ? (a.releasedAt < b.releasedAt ? 1 : -1) : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

export interface ShardOptions {
  snapshot: string;
  source: string;
  grindstone: string;
}

function shard(format: 'standard' | 'arena', cards: CompactCardRecord[], o: ShardOptions): CardShard {
  return {
    schema: 1,
    format,
    meta: { snapshot: o.snapshot, builtAt: o.snapshot, source: o.source, cardCount: cards.length },
    grindstone: o.grindstone,
    // Hydrated by the schema on read; the shard stores the compact form.
    cards: cards as CardShard['cards'],
  };
}

export interface CardData {
  arena: CardShard;
  standard: CardShard;
  sets: MtgSet[];
}

/** Arena and Standard shards plus sets.json from a fold. Records keep grindstone's order (byNameThenId). */
export function buildCardData(fold: FoldResult, o: ShardOptions & { today: string }): CardData {
  const arena = fold.records.filter((r) => r.onArena).map((r) => toShardRecord(r, fold.printings.get(r.oracleId)));
  const standard = arena.filter((c) => c.legalities.standard !== undefined);
  return { arena: shard('arena', arena, o), standard: shard('standard', standard, o), sets: buildSets(fold, o.today) };
}

/** Standard sets newest first, and the set that labels this data version. */
export function versionOf(sets: readonly MtgSet[], today = '9999-12-31'): { latest: MtgSet | null; standardSets: string[] } {
  const standardSets = sets.filter((s) => s.standard);
  const released = sets.filter((s) => s.releasedAt <= today);
  const latest = standardSets[0] ?? released.find((s) => s.kind === 'expansion') ?? released[0] ?? null;
  return { latest, standardSets: standardSets.map((s) => s.code) };
}
