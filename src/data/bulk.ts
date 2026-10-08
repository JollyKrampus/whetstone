import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { CardIndex } from '../core/cards.js';
import { aggregateCards, byNameThenId } from '../core/aggregate.js';
import type { CardRecord, IndexMeta } from '../core/types.js';
import type { ScryfallClient } from './scryfall.js';

const SCHEMA_VERSION = '1';

export { aggregateCards };

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
