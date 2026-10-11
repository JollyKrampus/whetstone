import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../../lib/datadir.ts';
import { CardShardSchema, SetsFileSchema } from '../schema.ts';
import { textLines } from './lines.ts';
import { buildCardData, buildSets, foldBulk, parseBulkInfo, toShardRecord, versionOf, type FoldResult } from './scryfall.ts';

const RAW = path.join(repoRoot(), 'src', 'games', 'mtga', 'fixtures', 'raw', 'scryfall');
const OPTS = { snapshot: '2026-10-08T21:05:45.161+00:00', source: 'https://data.scryfall.io/default-cards/x.jsonl.gz', grindstone: '0.2.0', today: '2026-10-08' };

let folded: Promise<FoldResult> | null = null;
const fold = () => (folded ??= foldBulk(textLines(new Uint8Array(readFileSync(path.join(RAW, 'default-cards.jsonl.bin'))))));

/** A printing as Scryfall's bulk data has it (only the fields the fold reads). */
function printing(o: Partial<Record<string, unknown>> & { name: string; oracle_id: string; set: string }) {
  return JSON.stringify({
    id: `00000000-0000-4000-8000-${String(o.collector_number ?? '1').padStart(12, '0')}`,
    layout: 'normal',
    set_type: 'expansion',
    set_name: o.set.toUpperCase(),
    released_at: '2026-01-01',
    collector_number: '1',
    rarity: 'common',
    type_line: 'Instant',
    mana_cost: '{R}',
    cmc: 1,
    oracle_text: 'Deal 1 damage.',
    colors: ['R'],
    color_identity: ['R'],
    legalities: { standard: 'legal', historic: 'legal', modern: 'legal' },
    games: ['arena', 'paper'],
    image_status: 'highres_scan',
    image_uris: { normal: 'x' },
    ...o,
  });
}

describe('parseBulkInfo', () => {
  it('reads the default_cards entry, preferring jsonl_download_uri', () => {
    const info = parseBulkInfo(JSON.parse(readFileSync(path.join(RAW, 'bulk-data-default_cards.json'), 'utf8')));
    expect(info.updatedAt).toMatch(/^2026-/);
    expect(info.downloadUri).toMatch(/^https:\/\/data\.scryfall\.io\/default-cards\/.+\.jsonl\.gz$/);
    expect(parseBulkInfo({ updated_at: '2026-10-08T00:00:00Z', download_uri: 'https://data.scryfall.io/x.json' }).downloadUri).toBe('https://data.scryfall.io/x.json');
  });

  it('fails loudly on schema drift or a foreign host', () => {
    expect(() => parseBulkInfo({ updated_at: '2026-10-08T00:00:00Z' })).toThrow(/jsonl_download_uri/);
    expect(() => parseBulkInfo({ updated_at: 'yesterday', jsonl_download_uri: 'https://data.scryfall.io/x' })).toThrow(/updated_at/);
    expect(() => parseBulkInfo({ updated_at: '2026-10-08T00:00:00Z', jsonl_download_uri: 'https://evil.example/x' })).toThrow();
    expect(() => parseBulkInfo(null)).toThrow();
  });
});

describe('foldBulk on the recorded fixture', () => {
  it("folds printings with grindstone's aggregate and records the newest Arena printing", async () => {
    const f = await fold();
    expect(f.printingCount).toBeGreaterThan(f.records.length);
    const strike = f.records.find((r) => r.name === 'Lightning Strike')!;
    expect(strike.onArena).toBe(true);
    expect(strike.releasedAt).toBe('2013-09-27');
    const p = f.printings.get(strike.oracleId)!;
    expect(p.releasedAt).toBe(strike.latestReleasedAt);
    expect(p.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('builds schema-valid shards: Arena cards only, Standard a subset, Arena legalities only', async () => {
    const data = buildCardData(await fold(), OPTS);
    const arena = CardShardSchema.parse(data.arena);
    const standard = CardShardSchema.parse(data.standard);
    expect(arena.meta).toEqual({ snapshot: OPTS.snapshot, builtAt: OPTS.snapshot, source: OPTS.source, cardCount: arena.cards.length });
    expect(standard.cards.length).toBeLessThan(arena.cards.length);
    for (const c of arena.cards) {
      expect(Object.keys(c.legalities).every((k) => ['standard', 'pioneer', 'historic', 'timeless', 'brawl', 'standardbrawl', 'alchemy'].includes(k))).toBe(true);
      expect(Object.values(c.legalities)).not.toContain('not_legal');
      expect(c.scryfallId, c.name).toBeDefined();
    }
    // Empty arrays stay in the shard (grindstone's CardIndex iterates them).
    const raw = data.arena.cards.find((c) => c.name === 'Shock')!;
    expect(raw.faces).toEqual([]);
    expect(raw.keywords).toEqual([]);
    expect(SetsFileSchema.safeParse(data.sets).success).toBe(true);
  });
});

describe('toShardRecord', () => {
  it('keeps grindstone fields, trims legalities and adds image ids only when well-formed', async () => {
    const [r] = (await foldBulk([printing({ name: 'Zap', oracle_id: '11111111-1111-4111-8111-111111111111', set: 'tst' })])).records;
    const good = toShardRecord(r!, { id: '22222222-2222-4222-8222-222222222222', set: 'tst', cn: '7', releasedAt: '2026-01-01', hasImage: true });
    expect(good.legalities).toEqual({ standard: 'legal', historic: 'legal' });
    expect(good).toMatchObject({ scryfallId: '22222222-2222-4222-8222-222222222222', set: 'tst', cn: '7' });
    const bad = toShardRecord(r!, { id: 'not-a-uuid', set: 'tst', cn: '7', releasedAt: '2026-01-01', hasImage: true });
    expect(bad.scryfallId).toBeUndefined();
    // No price in the bulk data: the shard leaves the field out (hydration restores null).
    expect('priceUsd' in good).toBe(false);
  });

  it("carries the cheapest printing's paper price", async () => {
    const id = '44444444-4444-4444-8444-444444444444';
    const [r] = (
      await foldBulk([
        printing({ name: 'Zap', oracle_id: id, set: 'aaa', collector_number: '1', prices: { usd: '1.50', usd_foil: '3.00' } }),
        printing({ name: 'Zap', oracle_id: id, set: 'bbb', collector_number: '2', prices: { usd: null, usd_foil: '0.75' } }),
        printing({ name: 'Zap', oracle_id: id, set: 'ccc', collector_number: '3', prices: { usd: '0.00' } }),
      ])
    ).records;
    expect(r?.priceUsd).toBe(0.75);
    expect(toShardRecord(r!, undefined).priceUsd).toBe(0.75);
  });

  it('prefers a printing with an image, then the newest one', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const f = await foldBulk([
      printing({ name: 'Zap', oracle_id: id, set: 'old', released_at: '2020-01-01', collector_number: '1' }),
      printing({ name: 'Zap', oracle_id: id, set: 'new', released_at: '2026-01-01', collector_number: '2', image_status: 'missing' }),
      printing({ name: 'Zap', oracle_id: id, set: 'mid', released_at: '2024-01-01', collector_number: '3' }),
      printing({ name: 'Zap', oracle_id: id, set: 'ppr', released_at: '2027-01-01', collector_number: '4', games: ['paper'] }),
    ]);
    expect(f.printings.get(id)?.set).toBe('mid');
  });
});

describe('buildSets and versionOf', () => {
  it('flags Standard sets by type, release date and the share of Standard-legal Arena cards', async () => {
    const mk = (set: string, n: number, legal: number, extra: Record<string, unknown> = {}) =>
      Array.from({ length: n }, (_, i) =>
        printing({ name: `${set}${i}`, oracle_id: `44444444-4444-4444-8444-${set.padEnd(4, '0')}${String(i).padStart(8, '0')}`.slice(0, 36), set, collector_number: String(i + 1), legalities: { standard: i < legal ? 'legal' : 'not_legal' }, ...extra }),
      );
    const f = await foldBulk([
      ...mk('new', 10, 10, { released_at: '2026-09-01' }),
      ...mk('fut', 4, 0, { released_at: '2026-12-01' }),
      ...mk('old', 10, 2, { released_at: '2019-01-01', set_type: 'core' }),
      ...mk('cmd', 5, 5, { released_at: '2026-09-01', set_type: 'commander' }),
      ...mk('pap', 3, 3, { released_at: '2026-05-01', games: ['paper'] }),
    ]);
    const sets = buildSets(f, '2026-10-08');
    expect(sets.map((s) => [s.code, s.standard, s.cardCount])).toEqual([
      ['FUT', false, 4],
      ['CMD', false, 5],
      ['NEW', true, 10],
      ['OLD', false, 10],
    ]);
    expect(versionOf(sets, '2026-10-08')).toEqual({ latest: sets[2], standardSets: ['NEW'] });
    // Without Standard sets the newest released expansion labels the data.
    expect(versionOf(sets.map((s) => ({ ...s, standard: false })), '2026-10-08').latest?.code).toBe('NEW');
  });
});
