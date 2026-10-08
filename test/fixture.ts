import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CardIndex } from '../src/core/cards.js';
import type { Context } from '../src/context.js';
import { aggregateCards, readIndex, writeIndex } from '../src/data/bulk.js';
import { ScryfallClient } from '../src/data/scryfall.js';

export const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures');
export const FIXTURE_SNAPSHOT = 'fixture-2026-10-08';

let cached: Promise<CardIndex> | undefined;

/** The fixture card index, built through the real aggregate → SQLite → load path. */
export function fixtureIndex(): Promise<CardIndex> {
  cached ??= (async () => {
    const lines = readFileSync(path.join(FIXTURE_DIR, 'cards.jsonl'), 'utf8').split('\n');
    const records = await aggregateCards(lines);
    const dir = mkdtempSync(path.join(os.tmpdir(), 'grindstone-test-'));
    const dbPath = path.join(dir, 'cards.sqlite');
    writeIndex(dbPath, records, { snapshot: FIXTURE_SNAPSHOT, builtAt: '2026-10-08T00:00:00.000Z', source: 'fixture' });
    const index = readIndex(dbPath);
    if (!index) throw new Error('fixture index failed to load');
    return index;
  })();
  return cached;
}

export function readFixture(name: string): string {
  return readFileSync(path.join(FIXTURE_DIR, name), 'utf8');
}

export function testContext(overrides: Partial<Context> = {}): Context {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'grindstone-ctx-'));
  return {
    getIndex: fixtureIndex,
    scryfall: new ScryfallClient({
      fetch: async () => {
        throw new Error('network disabled in tests');
      },
    }),
    fetch: async () => {
      throw new Error('network disabled in tests');
    },
    online: false,
    cacheDir: dir,
    configDir: dir,
    log: () => {},
    ...overrides,
  };
}
