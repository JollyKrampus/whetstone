// Builds test/fixtures/cards.jsonl: a small, trimmed subset of a Scryfall bulk file, so
// tests run against real card data without the full download.
//
//   node scripts/make-fixture.mjs <default-cards.jsonl.gz> [names-file] [out-file]
//
// names-file lists one card name per line (# comments allowed). Every Arena printing of
// each card is kept, plus its first printing; unknown names are reported.
import fs from 'node:fs';
import readline from 'node:readline';
import zlib from 'node:zlib';

const [bulkPath, namesPath = 'test/fixtures/card-names.txt', outPath = 'test/fixtures/cards.jsonl'] =
  process.argv.slice(2);
if (!bulkPath) {
  console.error('usage: node scripts/make-fixture.mjs <default-cards.jsonl.gz> [names-file] [out-file]');
  process.exit(1);
}

const norm = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const wanted = new Map(
  fs
    .readFileSync(namesPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*/, '').trim())
    .filter(Boolean)
    .map((n) => [norm(n), n]),
);

const KEEP = [
  'oracle_id', 'name', 'layout', 'mana_cost', 'cmc', 'type_line', 'oracle_text', 'colors',
  'color_identity', 'produced_mana', 'keywords', 'legalities', 'power', 'toughness', 'rarity',
  'games', 'arena_id', 'released_at', 'edhrec_rank', 'game_changer', 'set', 'set_type',
  'collector_number', 'digital',
];
const FACE_KEEP = ['name', 'mana_cost', 'type_line', 'oracle_text', 'colors', 'power', 'toughness', 'oracle_id'];
const RARITY = ['common', 'uncommon', 'rare', 'special', 'bonus', 'mythic'];
const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

const byName = new Map();
const input = fs.createReadStream(bulkPath);
const rl = readline.createInterface({ input: bulkPath.endsWith('.gz') ? input.pipe(zlib.createGunzip()) : input });
for await (const line of rl) {
  if (!line.trim()) continue;
  const c = JSON.parse(line);
  const keys = [norm(c.name), ...(c.card_faces ?? []).map((f) => norm(f.name))];
  const key = keys.find((k) => wanted.has(k));
  if (!key || c.layout === 'token' || c.layout === 'art_series' || c.layout === 'reversible_card') continue;
  const slim = pick(c, KEEP);
  if (c.card_faces) slim.card_faces = c.card_faces.map((f) => pick(f, FACE_KEEP));
  const list = byName.get(key) ?? [];
  list.push(slim);
  byName.set(key, list);
}

const out = [];
const missing = [];
for (const [key, original] of wanted) {
  const prints = byName.get(key);
  if (!prints) {
    missing.push(original);
    continue;
  }
  prints.sort((a, b) => (a.released_at < b.released_at ? -1 : 1) || (a.set < b.set ? -1 : 1));
  // First printing, the cheapest Arena printing, and the newest two Arena printings are
  // enough to reproduce release dates, Arena availability and wildcard rarity.
  const arena = prints.filter((p) => p.games?.includes('arena'));
  const cheapest = [...arena].sort((a, b) => RARITY.indexOf(a.rarity) - RARITY.indexOf(b.rarity))[0];
  const keep = new Set([prints[0], cheapest, ...arena.slice(-2)].filter(Boolean));
  out.push(...prints.filter((p) => keep.has(p)));
}
fs.writeFileSync(outPath, out.map((c) => JSON.stringify(c)).join('\n') + '\n');
console.log(`wrote ${out.length} printings for ${wanted.size - missing.length} cards to ${outPath}`);
if (missing.length) console.log(`missing: ${missing.join(' | ')}`);
