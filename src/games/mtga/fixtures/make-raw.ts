/**
 * Rebuild the small offline fixtures in ./raw/ from a live run's dev HTTP cache.
 *
 *   node pipeline/run.ts --game mtga          # live run; fills .cache/http
 *   node src/games/mtga/fixtures/make-raw.ts  # trims the cached responses into ./raw/
 *
 * Keeps them small and deterministic: the 48 cards of fixtures/mtga plus a few cards of the
 * newest Limited set (printings stripped to the fields the pipeline reads), the first rows of
 * one 17Lands game-data and draft-data file restricted to those cards, and their cards.csv rows.
 * 17Lands data is CC BY 4.0; Scryfall card data is used under Scryfall's terms (both credited).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { parseCsvLine } from '../pipeline/csv.ts';
import { textLines } from '../pipeline/lines.ts';
import { SCRYFALL_BULK_URL } from '../pipeline/scryfall.ts';
import { CARDS_CSV_URL, draftDataUrl, gameDataUrl } from '../pipeline/seventeenlands.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const RAW = path.join(HERE, 'raw');
const CACHE = path.join(ROOT, '.cache', 'http');

const LIMITED_SET = 'HOB';
/** Cards of the Limited fixture (17Lands columns kept, Scryfall printings kept). */
const LIMITED_CARDS = ['An Unexpected Party', 'Óin the Brave', 'Along the Crooked Way'];
const LIMITED_EXTRA = 5;
const GAME_ROWS = 240;
const SEALED_ROWS = 60;
const DRAFTS = 3;
/** Printing fields grindstone's aggregate and the Whetstone fold read. */
const KEEP = [
  'arena_id', 'card_faces', 'cmc', 'collector_number', 'color_identity', 'colors', 'edhrec_rank', 'game_changer', 'games', 'id',
  'image_status', 'image_uris', 'keywords', 'layout', 'legalities', 'mana_cost', 'name', 'oracle_id', 'oracle_text', 'power',
  'produced_mana', 'rarity', 'released_at', 'set', 'set_name', 'set_type', 'toughness', 'type_line',
];
const FACE_KEEP = ['colors', 'mana_cost', 'name', 'oracle_text', 'power', 'toughness', 'type_line'];

function cached(url: string, method = 'GET'): Uint8Array {
  const id = createHash('sha256').update(`${method} ${url}`).digest('hex');
  const file = path.join(CACHE, `${id}.body`);
  if (!existsSync(file)) throw new Error(`not in the dev cache: ${url} (run the live pipeline first)`);
  return new Uint8Array(readFileSync(file));
}

function cachedHeaders(url: string): Record<string, string> {
  const id = createHash('sha256').update(`HEAD ${url}`).digest('hex');
  return (JSON.parse(readFileSync(path.join(CACHE, `${id}.json`), 'utf8')) as { headers: Record<string, string> }).headers;
}

function pick(o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (o[k] !== undefined) out[k] = o[k];
  return out;
}

function write(rel: string, data: string | Uint8Array): void {
  const file = path.join(RAW, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  console.log(`wrote ${path.relative(ROOT, file)} (${(typeof data === 'string' ? Buffer.byteLength(data) : data.byteLength).toLocaleString('en')} bytes)`);
}

const csvField = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

async function main(): Promise<void> {
  const fixtureCards = (JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'mtga', 'public', '_cards.arena.json'), 'utf8')) as { cards: { name: string }[] }).cards.map((c) => c.name);

  // ---- 17Lands: game data (choose a few extra frequently played cards) ----
  const gameLines: string[] = [];
  for await (const line of textLines(cached(gameDataUrl(LIMITED_SET, 'PremierDraft')))) {
    gameLines.push(line);
    if (gameLines.length > GAME_ROWS) break;
  }
  const header = parseCsvLine(gameLines[0]!);
  const counts = new Map<string, number>();
  for (const line of gameLines.slice(1)) {
    const f = parseCsvLine(line);
    header.forEach((h, i) => {
      if (h.startsWith('deck_') && f[i] !== '0') counts.set(h.slice(5), (counts.get(h.slice(5)) ?? 0) + 1);
    });
  }
  const basics = new Set(['Plains', 'Island', 'Swamp', 'Mountain', 'Forest']);
  const extra = [...counts.entries()].filter(([n]) => !basics.has(n) && !LIMITED_CARDS.includes(n)).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, LIMITED_EXTRA).map(([n]) => n);
  const limitedCards = [...LIMITED_CARDS, ...extra, 'Mountain'];
  const keepCol = (h: string): boolean => {
    const m = /^(?:opening_hand|drawn|tutored|deck|sideboard|pack_card|pool)_(.+)$/.exec(h);
    return !m || limitedCards.includes(m[1]!);
  };
  const trim = (lines: string[]): string => {
    const head = parseCsvLine(lines[0]!);
    const idx = head.map((h, i) => (keepCol(h) ? i : -1)).filter((i) => i >= 0);
    return lines.map((l) => idx.map((i) => csvField(parseCsvLine(l)[i] ?? '')).join(',')).join('\n') + '\n';
  };
  write(`17lands/${LIMITED_SET}.PremierDraft.game.bin`, gzipSync(trim(gameLines), { level: 9 }));

  const sealed: string[] = [];
  for await (const line of textLines(cached(gameDataUrl(LIMITED_SET, 'Sealed')))) {
    sealed.push(line);
    if (sealed.length > SEALED_ROWS) break;
  }
  write(`17lands/${LIMITED_SET}.Sealed.game.bin`, gzipSync(trim(sealed), { level: 9 }));

  const draft: string[] = [];
  const seenDrafts = new Set<string>();
  let draftCol = -1;
  for await (const line of textLines(cached(draftDataUrl(LIMITED_SET, 'PremierDraft')))) {
    if (draftCol < 0) {
      draftCol = parseCsvLine(line).indexOf('draft_id');
      draft.push(line);
      continue;
    }
    const id = parseCsvLine(line)[draftCol] ?? '';
    if (!seenDrafts.has(id)) {
      if (seenDrafts.size === DRAFTS) break;
      seenDrafts.add(id);
    }
    draft.push(line);
  }
  write(`17lands/${LIMITED_SET}.PremierDraft.draft.bin`, gzipSync(trim(draft), { level: 9 }));

  for (const [key, url] of [
    [`17lands/${LIMITED_SET}.PremierDraft.game`, gameDataUrl(LIMITED_SET, 'PremierDraft')],
    [`17lands/${LIMITED_SET}.PremierDraft.draft`, draftDataUrl(LIMITED_SET, 'PremierDraft')],
    [`17lands/${LIMITED_SET}.Sealed.game`, gameDataUrl(LIMITED_SET, 'Sealed')],
  ] as const) {
    const h = cachedHeaders(url);
    write(`${key}.head.json`, `${JSON.stringify({ 'content-type': h['content-type'], 'last-modified': h['last-modified'] }, null, 2)}\n`);
  }

  const cardsCsv: string[] = [];
  for await (const line of textLines(cached(CARDS_CSV_URL))) {
    if (cardsCsv.length === 0) cardsCsv.push(line);
    else {
      const f = parseCsvLine(line);
      if (f[1] === LIMITED_SET && limitedCards.includes(f[2] ?? '')) cardsCsv.push(line);
    }
  }
  write('17lands/cards.txt', `${cardsCsv.join('\n')}\n`);

  // ---- Scryfall: bulk-data entry and the printings of the chosen cards ----
  const bulk = JSON.parse(new TextDecoder().decode(cached(SCRYFALL_BULK_URL))) as Record<string, unknown>;
  write('scryfall/bulk-data-default_cards.json', `${JSON.stringify(bulk, null, 2)}\n`);
  const wanted = new Set([...fixtureCards, ...limitedCards]);
  const byOracle = new Map<string, Record<string, unknown>[]>();
  for await (const raw of textLines(cached(String(bulk.jsonl_download_uri)))) {
    const line = raw.trim().replace(/,$/, '');
    if (!line || line === '[' || line === ']') continue;
    const c = JSON.parse(line) as Record<string, unknown>;
    const faces = Array.isArray(c.card_faces) ? (c.card_faces as Record<string, unknown>[]) : [];
    const names = [String(c.name), ...faces.map((f) => String(f.name))];
    if (!names.some((n) => wanted.has(n)) || !c.oracle_id) continue;
    if (c.set_type === 'token' || c.set_type === 'memorabilia') continue;
    const slim = pick(c, KEEP);
    if (faces.length) slim.card_faces = faces.map((f) => pick(f, FACE_KEEP));
    if (slim.image_uris) slim.image_uris = { normal: (c.image_uris as Record<string, string>).normal };
    const list = byOracle.get(String(c.oracle_id)) ?? [];
    list.push(slim);
    byOracle.set(String(c.oracle_id), list);
  }
  const out: string[] = [];
  for (const id of [...byOracle.keys()].sort()) {
    const all = byOracle.get(id)!.sort((a, b) => String(a.released_at).localeCompare(String(b.released_at)) || String(a.id).localeCompare(String(b.id)));
    const arena = all.filter((p) => (p.games as string[] | undefined)?.includes('arena'));
    // Earliest printing (first-print date), newest Arena printing (image), plus one more Arena printing.
    const keep = new Set([all[0], arena.at(-1), arena.at(-2)].filter(Boolean));
    out.push(...[...keep].map((p) => JSON.stringify(p)));
  }
  write('scryfall/default-cards.jsonl.bin', gzipSync(`${out.join('\n')}\n`, { level: 9 }));
}

await main();
