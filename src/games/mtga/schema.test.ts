import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { DataValidationError, parseData } from '../../core/schemas.ts';
import { repoRoot, usingFixtures } from '../../lib/datadir.ts';
import * as load from './load.ts';
import {
  CardRecordSchema,
  CardShardSchema,
  LimitedIndexSchema,
  LimitedRatingsSchema,
  MetaSnapshotSchema,
  MtgaMetaSchema,
  SetsFileSchema,
  hydrateCardRecord,
  type CompactCardRecord,
} from './schema.ts';

const ROOT = repoRoot();
const FIXTURES = path.join(ROOT, 'fixtures', 'mtga');
const CURATED = path.join(ROOT, 'curated', 'mtga');
const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));
function fixture<S extends z.ZodType>(schema: S, file: string): z.output<S> {
  return parseData(schema, readJson(path.join(FIXTURES, file)), `fixtures/mtga/${file}`);
}
const listDir = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []);

/** Main-deck and sideboard card names with counts from an Arena export. */
function parseList(list: string): { main: Map<string, number>; side: Map<string, number> } {
  const main = new Map<string, number>();
  const side = new Map<string, number>();
  let target = main;
  for (const raw of list.split('\n')) {
    const line = raw.trim();
    if (/^sideboard$/i.test(line)) target = side;
    const m = /^(\d+)\s+(.+?)(?:\s+\([A-Z0-9]+\)\s+\S+)?$/.exec(line);
    if (m) target.set(m[2] as string, (target.get(m[2] as string) ?? 0) + Number(m[1]));
  }
  return { main, side };
}

describe('mtga fixtures match the schemas', () => {
  it('meta.json', () => expect(() => fixture(MtgaMetaSchema, 'meta.json')).not.toThrow());
  it('sets.json', () => expect(() => fixture(SetsFileSchema, 'sets.json')).not.toThrow());
  it('public/_cards.standard.json', () => expect(() => fixture(CardShardSchema, 'public/_cards.standard.json')).not.toThrow());
  it('public/_cards.arena.json', () => expect(() => fixture(CardShardSchema, 'public/_cards.arena.json')).not.toThrow());
  it('limited/index.json', () => expect(() => fixture(LimitedIndexSchema, 'limited/index.json')).not.toThrow());
  for (const file of listDir(path.join(FIXTURES, 'limited')).filter((f) => f !== 'index.json')) {
    it(`limited/${file}`, () => expect(() => fixture(LimitedRatingsSchema, `limited/${file}`)).not.toThrow());
  }
  for (const file of listDir(path.join(FIXTURES, 'meta'))) {
    it(`meta/${file}`, () => expect(() => fixture(MetaSnapshotSchema, `meta/${file}`)).not.toThrow());
  }
});

describe('mtga curated files match the schemas', () => {
  const files = listDir(path.join(CURATED, 'meta'));
  it('has at least the Standard snapshot', () => expect(files).toContain('standard.json'));
  for (const file of files) {
    it(`meta/${file}`, () => {
      const snap = parseData(MetaSnapshotSchema, readJson(path.join(CURATED, 'meta', file)), `curated/mtga/meta/${file}`);
      expect(`${snap.format}.json`).toBe(file);
    });
  }
});

describe('mtga fixture consistency', () => {
  const arena = fixture(CardShardSchema, 'public/_cards.arena.json');
  const standard = fixture(CardShardSchema, 'public/_cards.standard.json');
  const byName = new Map(arena.cards.map((c) => [c.name, c]));

  it('holds about forty Arena cards, Standard a subset of Arena', () => {
    expect(arena.cards.length).toBeGreaterThanOrEqual(40);
    const ids = new Set(arena.cards.map((c) => c.oracleId));
    for (const c of standard.cards) expect(ids.has(c.oracleId), c.name).toBe(true);
    expect(arena.cards.some((c) => c.legalities.standard === undefined)).toBe(true);
    expect(standard.cards.some((c) => c.legalities.standard === 'banned')).toBe(true);
    expect(arena.cards.some((c) => c.faces.length === 2)).toBe(true);
  });

  it('restores omitted defaults the same way with and without zod', () => {
    const raw = (readJson(path.join(FIXTURES, 'public/_cards.arena.json')) as { cards: CompactCardRecord[] }).cards;
    for (const c of raw) expect(hydrateCardRecord(c)).toEqual(CardRecordSchema.parse(c));
    expect(raw.some((c) => c.oracleText === undefined)).toBe(true);
  });

  it('example meta decks resolve against the fixture card pool', () => {
    const snap = fixture(MetaSnapshotSchema, 'meta/standard.json');
    expect(snap.example).toBe(true);
    expect(snap.decks).toHaveLength(2);
    for (const deck of snap.decks) {
      expect(deck.example).toBe(true);
      const { main, side } = parseList(deck.list);
      expect([...main.values()].reduce((a, b) => a + b, 0), deck.name).toBe(60);
      for (const name of [...main.keys(), ...side.keys()]) {
        const card = byName.get(name);
        expect(card, `${deck.name}: ${name}`).toBeDefined();
        expect(card?.legalities.standard, name).toBe('legal');
      }
    }
    const curatedSnap = parseData(MetaSnapshotSchema, readJson(path.join(CURATED, 'meta', 'standard.json')), 'curated');
    expect(curatedSnap.example).toBe(true);
    for (const d of curatedSnap.decks) expect(snap.decks).toContainEqual(d);
  });

  it('keeps Limited ratings internally consistent and marked synthetic', () => {
    const index = fixture(LimitedIndexSchema, 'limited/index.json');
    for (const e of index) {
      const r = fixture(LimitedRatingsSchema, e.file);
      expect(r.synthetic).toBe(true);
      expect(r.set).toBe(e.set);
      expect(r.totals.games).toBe(e.games);
      for (const c of r.cards) {
        if (c.gihWr !== null && c.gnsWr !== null && c.iwd !== null) expect(c.iwd).toBeCloseTo((c.gihWr - c.gnsWr) * 100, 0);
        if (c.oracleId) expect(byName.get(c.name)?.oracleId).toBe(c.oracleId);
      }
    }
  });

  it('meta.json counts and extras agree with the files', () => {
    const meta = fixture(MtgaMetaSchema, 'meta.json');
    const sets = fixture(SetsFileSchema, 'sets.json');
    expect(meta.counts.cards).toBe(arena.cards.length);
    expect(meta.counts.standardCards).toBe(standard.cards.length);
    expect(meta.extra.snapshot).toBe(arena.meta.snapshot);
    expect(meta.version.label).toBe(meta.extra.latestSet);
    expect(sets[0]?.code).toBe(meta.extra.latestSet);
    for (const code of meta.extra.standardSets) expect(sets.some((s) => s.code === code && s.standard)).toBe(true);
  });
});

describe('mtga schema rejects bad data', () => {
  it('requires a sourceUrl on non-example curated decks', () => {
    const base = { format: 'standard', decks: [{ archetype: 'Boros', list: 'Deck\n4 Shock' }] };
    expect(MetaSnapshotSchema.safeParse(base).success).toBe(false);
    expect(MetaSnapshotSchema.safeParse({ ...base, decks: [{ ...base.decks[0], sourceUrl: 'https://magic.gg/' }] }).success).toBe(true);
    expect(MetaSnapshotSchema.safeParse({ ...base, format: 'explorer' }).success).toBe(false);
  });

  it('rejects unsorted shards and wrong card counts, naming the file', () => {
    const shard = readJson(path.join(FIXTURES, 'public/_cards.standard.json')) as { cards: unknown[]; meta: { cardCount: number } };
    expect(CardShardSchema.safeParse({ ...shard, cards: [...shard.cards].reverse() }).success).toBe(false);
    expect(CardShardSchema.safeParse({ ...shard, meta: { ...shard.meta, cardCount: 1 } }).success).toBe(false);
    expect(() => parseData(CardShardSchema, { ...shard, schema: 2 }, 'data/current/mtga/public/_cards.standard.json')).toThrow(DataValidationError);
  });
});

describe('mtga load.ts against fixtures', () => {
  afterEach(() => load.clearMtgaCache());

  it('loads every file through the data dir', () => {
    expect(load.getMeta().game).toBe('mtga');
    expect(load.getSets().length).toBeGreaterThan(0);
    expect(load.getCardShard('standard').cards.length).toBeGreaterThan(0);
    if (!usingFixtures('mtga')) return;
    expect(load.getSet('blb')?.name).toBe('Bloomburrow');
    expect(load.getStandardSets().length).toBe(load.getMeta().extra.standardSets.length);
    expect(load.getCardShard('arena').cards.find((c) => c.name === 'Fire Elemental')?.oracleText).toBe('');
    expect(load.getLimitedIndex()).toHaveLength(1);
    expect(load.getLimitedRatings('BLB')?.cards.length).toBeGreaterThan(0);
    expect(load.getLimitedRatings('BLB', 'Sealed')).toBeNull();
    expect(load.getMetaSnapshot('standard')?.decks).toHaveLength(2);
    expect(load.getMetaSnapshot('pioneer')).toBeNull();
    expect(load.getMetaSnapshots().map((s) => s.format)).toEqual(['standard']);
  });
});
