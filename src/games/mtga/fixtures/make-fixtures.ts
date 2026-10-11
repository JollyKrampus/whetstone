/**
 * Rebuild fixtures/mtga (the small committed snapshot fixture builds and tests read) from real data:
 *
 *   node pipeline/run.ts --game mtga               # live run; fills .cache/http
 *   node src/games/mtga/fixtures/make-fixtures.ts  # folds the cached Scryfall bulk into fixtures/mtga
 *     [--cache <dir>]                              # another checkout's .cache/http (read only)
 *
 * The card shards hold the exact records the live pipeline builds (grindstone's aggregate over
 * every printing in the cached default_cards file), limited to the cards the fixture already had
 * plus every card of the fixture meta lists. The fixture meta lists are FIXTURE_DECKS, copied
 * verbatim from curated/mtga/meta/standard.json, so fixture builds compare decks against real
 * curated lists. meta.json keeps its fixed dataHash and dates; counts, the grindstone version and
 * the source details are refreshed. Limited files and sets.json are left alone.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { CardIndex } from 'grindstone-mcp/core';
import { jsonBytes } from '../../../../pipeline/hash.ts';
import { serializeOutput } from '../../../../pipeline/store.ts';
import { readGrindstoneVersion } from '../pipeline/index.ts';
import { textLines } from '../pipeline/lines.ts';
import { buildCardData, foldBulk } from '../pipeline/scryfall.ts';
import { hydrateCardRecord, type CardShard, type CompactCardRecord } from '../schema.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const FIXTURES = path.join(ROOT, 'fixtures', 'mtga');
const ARGS = parseArgs({ options: { cache: { type: 'string' } } }).values;
const CACHE = path.resolve(ARGS.cache ?? path.join(ROOT, '.cache', 'http'));

/** Curated Standard lists copied into the fixture (by deck name). */
export const FIXTURE_DECKS = ['Izzet Prowess', 'Rakdos Lizards', 'Dimir Midrange'] as const;
const TODAY = '2026-10-08';

interface Snapshot {
  format: string;
  decks: { name?: string; list: string }[];
  [key: string]: unknown;
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

function cached(url: string): Uint8Array {
  const id = createHash('sha256').update(`GET ${url}`).digest('hex');
  const file = path.join(CACHE, `${id}.body`);
  if (!existsSync(file)) throw new Error(`not in the dev cache: ${url} (run the live pipeline first, or pass --cache)`);
  return new Uint8Array(readFileSync(file));
}

/** Card names of an Arena export ("4 Name", optionally with a set code and number). */
function namesIn(list: string): string[] {
  const out: string[] = [];
  for (const line of list.split(/\r?\n/)) {
    const m = /^\s*\d+x?\s+(.+?)(?:\s+\([A-Za-z0-9]{2,6}\)(?:\s+\S+)?)?\s*$/.exec(line);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

async function main(): Promise<void> {
  // 1. Fixture meta lists: real curated decks, verbatim.
  const curated = readJson<Snapshot>(path.join(ROOT, 'curated', 'mtga', 'meta', 'standard.json'));
  const decks = FIXTURE_DECKS.map((name) => {
    const d = curated.decks.find((x) => x.name === name);
    if (!d) throw new Error(`curated/mtga/meta/standard.json has no deck named ${name}`);
    return d;
  });
  const fixtureMeta: Snapshot = { ...curated, decks };

  // 2. Every printing in the cached bulk file, folded exactly like the pipeline does.
  const bulk = readJson<{ updated_at: string; jsonl_download_uri: string }>(path.join(HERE, 'raw', 'scryfall', 'bulk-data-default_cards.json'));
  const grindstone = readGrindstoneVersion().version;
  const fold = await foldBulk(textLines(cached(bulk.jsonl_download_uri)));
  const full = buildCardData(fold, { snapshot: bulk.updated_at, source: bulk.jsonl_download_uri, grindstone, today: TODAY });
  const index = new CardIndex(full.arena.cards.map(hydrateCardRecord), full.arena.meta);

  // 3. The cards to keep: the fixture's current cards plus every card of the fixture lists.
  const current = readJson<{ cards: { name: string }[] }>(path.join(FIXTURES, 'public', '_cards.arena.json')).cards.map((c) => c.name);
  const wanted = new Set<string>();
  const missing: string[] = [];
  for (const name of [...current, ...decks.flatMap((d) => namesIn(d.list))]) {
    const card = index.lookup(name);
    if (card) wanted.add(card.oracleId);
    else missing.push(name);
  }
  if (missing.length) throw new Error(`not in the Arena card data: ${[...new Set(missing)].join(', ')}`);

  const pick = (shard: CardShard): CardShard => {
    const cards = (shard.cards as CompactCardRecord[]).filter((c) => wanted.has(c.oracleId)) as CardShard['cards'];
    return { ...shard, meta: { ...shard.meta, cardCount: cards.length }, cards };
  };
  const arena = pick(full.arena);
  const standard = pick(full.standard);
  writeFileSync(path.join(FIXTURES, 'public', '_cards.arena.json'), serializeOutput({ path: 'public/_cards.arena.json', data: arena }));
  writeFileSync(path.join(FIXTURES, 'public', '_cards.standard.json'), serializeOutput({ path: 'public/_cards.standard.json', data: standard }));
  writeFileSync(path.join(FIXTURES, 'meta', 'standard.json'), `${JSON.stringify(fixtureMeta, null, 2)}\n`);

  // 4. meta.json: counts, grindstone version and source details.
  const metaFile = path.join(FIXTURES, 'meta.json');
  const meta = readJson<{
    counts: Record<string, number>;
    extra: Record<string, unknown>;
    sources: { id: string; detail?: string }[];
  }>(metaFile);
  meta.counts.cards = arena.cards.length;
  meta.counts.standardCards = standard.cards.length;
  meta.counts.metaDecks = decks.length;
  meta.extra.grindstone = grindstone;
  const detail: Record<string, string> = {
    scryfall: `fixture: ${arena.cards.length} Arena cards from default_cards ${bulk.updated_at}`,
    'curated-meta': `fixture: ${decks.length} of the ${curated.decks.length} curated Standard lists`,
    'grindstone-mcp': `grindstone-mcp ${grindstone}, workspace package`,
  };
  for (const s of meta.sources) {
    const d = detail[s.id];
    if (d) s.detail = d;
  }
  writeFileSync(metaFile, jsonBytes(meta, true));
  console.log(`fixtures/mtga: ${arena.cards.length} Arena cards (${standard.cards.length} Standard), ${decks.length} meta lists, grindstone ${grindstone}`);
}

await main();
