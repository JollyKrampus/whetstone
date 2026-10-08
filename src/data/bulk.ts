import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { CardIndex } from '../core/cards.js';
import {
  COLORS,
  RARITIES,
  type CardFace,
  type CardRecord,
  type Color,
  type IndexMeta,
  type Rarity,
} from '../core/types.js';
import type { ScryfallClient } from './scryfall.js';

const SCHEMA_VERSION = '1';

/** Layouts that are never deck cards. */
const SKIP_LAYOUTS = new Set([
  'token',
  'double_faced_token',
  'emblem',
  'art_series',
  'planar',
  'scheme',
  'vanguard',
  'reversible_card',
]);

const RARITY_MAP: Record<string, Rarity> = {
  common: 'common',
  uncommon: 'uncommon',
  rare: 'rare',
  mythic: 'mythic',
  special: 'rare',
  bonus: 'rare',
};

/* eslint-disable @typescript-eslint/no-explicit-any */
type RawCard = Record<string, any>;

function lowerRarity(a: Rarity | null, b: Rarity): Rarity {
  if (a === null) return b;
  return RARITIES.indexOf(b) < RARITIES.indexOf(a) ? b : a;
}

function colorsOf(list: unknown): Color[] {
  const set = new Set(Array.isArray(list) ? list : []);
  return COLORS.filter((c) => set.has(c));
}

function faceOf(f: RawCard): CardFace {
  return {
    name: f.name,
    manaCost: f.mana_cost ?? '',
    typeLine: f.type_line ?? '',
    oracleText: f.oracle_text ?? '',
    ...(f.power !== undefined ? { power: f.power, toughness: f.toughness } : {}),
  };
}

function fromPrinting(c: RawCard): CardRecord {
  const faces: CardFace[] = Array.isArray(c.card_faces) ? c.card_faces.map(faceOf) : [];
  const front = faces[0];
  const faceColors = faces.length ? colorsOf(c.card_faces.flatMap((f: RawCard) => f.colors ?? [])) : [];
  const pt =
    c.power !== undefined
      ? { power: c.power, toughness: c.toughness }
      : front?.power !== undefined
        ? { power: front.power, toughness: front.toughness }
        : {};
  return {
    oracleId: c.oracle_id,
    name: c.name,
    layout: c.layout,
    manaCost: c.mana_cost ?? front?.manaCost ?? '',
    cmc: typeof c.cmc === 'number' ? c.cmc : 0,
    typeLine: c.type_line ?? faces.map((f) => f.typeLine).join(' // '),
    oracleText: c.oracle_text ?? faces.map((f) => f.oracleText).join('\n//\n'),
    faces,
    colors: c.colors ? colorsOf(c.colors) : faceColors,
    colorIdentity: colorsOf(c.color_identity),
    producedMana: Array.isArray(c.produced_mana) ? [...c.produced_mana].sort() : [],
    keywords: Array.isArray(c.keywords) ? [...c.keywords].sort() : [],
    legalities: c.legalities ?? {},
    ...pt,
    rarity: RARITY_MAP[c.rarity] ?? 'rare',
    arenaRarity: null,
    onArena: false,
    arenaIds: [],
    releasedAt: c.released_at,
    latestReleasedAt: c.released_at,
    edhrecRank: null,
    gameChanger: Boolean(c.game_changer),
  };
}

/**
 * Folds every printing in a Scryfall bulk file (one JSON object per line) into one record
 * per oracle ID. Arena availability, Arena IDs and the cheapest Arena rarity are
 * aggregated across printings.
 */
export async function aggregateCards(lines: AsyncIterable<string> | Iterable<string>): Promise<CardRecord[]> {
  const byOracle = new Map<string, CardRecord>();
  const latestAny = new Map<string, string>();
  for await (const raw of lines) {
    const line = raw.trim().replace(/,$/, '');
    if (!line || line === '[' || line === ']') continue;
    const c = JSON.parse(line) as RawCard;
    if (!c.oracle_id || SKIP_LAYOUTS.has(c.layout)) continue;
    if (c.set_type === 'memorabilia' || c.set_type === 'token') continue;

    let rec = byOracle.get(c.oracle_id);
    if (!rec) {
      rec = fromPrinting(c);
      byOracle.set(c.oracle_id, rec);
    }
    const rarity = RARITY_MAP[c.rarity] ?? 'rare';
    rec.rarity = lowerRarity(rec.rarity, rarity);
    if (c.released_at < rec.releasedAt) rec.releasedAt = c.released_at;
    if (c.released_at > (latestAny.get(c.oracle_id) ?? '')) latestAny.set(c.oracle_id, c.released_at);
    if (typeof c.edhrec_rank === 'number') {
      rec.edhrecRank = rec.edhrecRank === null ? c.edhrec_rank : Math.min(rec.edhrecRank, c.edhrec_rank);
    }
    const games: string[] = c.games ?? [];
    if (games.includes('arena')) {
      if (!rec.onArena || c.released_at > rec.latestReleasedAt) rec.latestReleasedAt = c.released_at;
      rec.onArena = true;
      rec.arenaRarity = lowerRarity(rec.arenaRarity, rarity);
      if (typeof c.arena_id === 'number' && !rec.arenaIds.includes(c.arena_id)) rec.arenaIds.push(c.arena_id);
    }
  }
  const out = [...byOracle.values()];
  for (const rec of out) {
    rec.arenaIds.sort((a, b) => a - b);
    if (!rec.onArena) rec.latestReleasedAt = latestAny.get(rec.oracleId) ?? rec.releasedAt;
  }
  return out.sort(byNameThenId);
}

function byNameThenId(a: CardRecord, b: CardRecord): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.oracleId < b.oracleId ? -1 : a.oracleId > b.oracleId ? 1 : 0;
}

export function writeIndex(dbPath: string, records: CardRecord[], meta: Omit<IndexMeta, 'cardCount'>) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const tmp = `${dbPath}.tmp-${process.pid}`;
  rmSync(tmp, { force: true });
  const db = new DatabaseSync(tmp);
  try {
    db.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE cards (oracle_id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL);
    `);
    db.exec('BEGIN');
    const insert = db.prepare('INSERT INTO cards (oracle_id, name, data) VALUES (?, ?, ?)');
    for (const r of records) insert.run(r.oracleId, r.name, JSON.stringify(r));
    const setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    setMeta.run('schema', SCHEMA_VERSION);
    setMeta.run('snapshot', meta.snapshot);
    setMeta.run('builtAt', meta.builtAt);
    setMeta.run('source', meta.source);
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  rmSync(dbPath, { force: true });
  renameSync(tmp, dbPath);
}

export function readIndex(dbPath: string): CardIndex | null {
  if (!existsSync(dbPath)) return null;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const metaRows = db.prepare('SELECT key, value FROM meta').all() as { key: string; value: string }[];
    const m = Object.fromEntries(metaRows.map((r) => [r.key, r.value]));
    if (m.schema !== SCHEMA_VERSION) return null;
    const rows = db.prepare('SELECT data FROM cards').all() as { data: string }[];
    const records = rows.map((r) => JSON.parse(r.data) as CardRecord).sort(byNameThenId);
    return new CardIndex(records, {
      snapshot: m.snapshot ?? 'unknown',
      builtAt: m.builtAt ?? 'unknown',
      source: m.source ?? 'unknown',
      cardCount: records.length,
    });
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/** Lines of a JSONL stream, gunzipping first when asked. */
export async function* jsonLines(input: NodeJS.ReadableStream, gzipped: boolean): AsyncGenerator<string> {
  const stream = gzipped ? input.pipe(zlib.createGunzip()) : input;
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of rl) yield line;
}

interface BulkDataObject {
  type: string;
  updated_at: string;
  jsonl_download_uri?: string;
  download_uri?: string;
}

export interface EnsureIndexOptions {
  client: ScryfallClient;
  dir: string;
  maxAgeMs?: number;
  offline?: boolean;
  log?: (msg: string) => void;
  now?: () => Date;
}

/**
 * Returns the local card index, downloading Scryfall's `default_cards` bulk file (every
 * English printing; each carries `games` and `arena_id`) when the index is missing or
 * older than `maxAgeMs`. A failed refresh falls back to the stale index if there is one.
 */
export async function ensureIndex(opts: EnsureIndexOptions): Promise<CardIndex> {
  const { client, dir, log = () => {}, now = () => new Date() } = opts;
  const maxAgeMs = opts.maxAgeMs ?? 24 * 60 * 60 * 1000;
  const dbPath = path.join(dir, 'cards.sqlite');
  const existing = readIndex(dbPath);
  const age = existing ? now().getTime() - Date.parse(existing.meta.builtAt) : Infinity;
  if (existing && (opts.offline || age < maxAgeMs)) return existing;
  if (opts.offline) throw new Error(`No card index at ${dbPath} and offline mode is on.`);

  try {
    const bulk = await client.getJson<BulkDataObject>('/bulk-data/default_cards');
    const builtAt = now().toISOString();
    if (existing && existing.meta.snapshot === bulk.updated_at) {
      writeIndex(dbPath, existing.records, { ...existing.meta, builtAt });
      return readIndex(dbPath) ?? existing;
    }
    const url = bulk.jsonl_download_uri ?? bulk.download_uri;
    if (!url) throw new Error('bulk-data object has no download URI');
    log(`grindstone: downloading Scryfall bulk data (${bulk.updated_at})…`);
    const res = await client.download(url);
    const body = Readable.fromWeb(res.body as unknown as WebReadableStream);
    const records = await aggregateCards(jsonLines(body, url.endsWith('.gz')));
    writeIndex(dbPath, records, { snapshot: bulk.updated_at, builtAt, source: url });
    log(`grindstone: indexed ${records.length} cards.`);
    const fresh = readIndex(dbPath);
    if (!fresh) throw new Error('index written but could not be read back');
    return fresh;
  } catch (err) {
    if (existing) {
      log(`grindstone: refresh failed (${(err as Error).message}); using index built ${existing.meta.builtAt}.`);
      return existing;
    }
    throw err;
  }
}
