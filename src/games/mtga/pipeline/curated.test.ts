import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CardIndex } from 'grindstone-mcp/core';
import { repoRoot } from '../../../lib/datadir.ts';
import { CardShardSchema } from '../schema.ts';
import { loadCurated, validateSnapshot } from './curated.ts';

const ROOT = repoRoot();
const shard = CardShardSchema.parse(JSON.parse(readFileSync(path.join(ROOT, 'fixtures', 'mtga', 'public', '_cards.arena.json'), 'utf8')));
const index = new CardIndex(shard.cards, shard.meta);
const curated = JSON.parse(readFileSync(path.join(ROOT, 'curated', 'mtga', 'meta', 'standard.json'), 'utf8')) as { decks: { list: string }[] };

const real = (list: string) => ({
  format: 'standard',
  decks: [{ name: 'Boros', archetype: 'Boros Aggro', list, sourceUrl: 'https://magic.gg/decklists/example' }],
});

describe('validateSnapshot', () => {
  it('accepts the curated Standard snapshot against the fixture card pool', async () => {
    const r = await validateSnapshot('curated/mtga/meta/standard.json', curated, index);
    expect(r.issues).toEqual([]);
    expect(r.snapshot?.decks).toHaveLength(curated.decks.length);
  });

  it('fails unknown card names with a suggestion', async () => {
    const r = await validateSnapshot('standard.json', real('Deck\n4 Lightnig Strike\n56 Mountain'), index);
    expect(r.snapshot).toBeNull();
    expect(r.issues[0]).toMatchObject({ level: 'error', source: 'curated-meta' });
    expect(r.issues[0]?.message).toMatch(/Lightnig Strike.*did you mean Lightning Strike/);
  });

  it('only warns when a list is no longer legal (bans, rotation)', async () => {
    const r = await validateSnapshot('standard.json', real('Deck\n4 Heartfire Hero\n56 Mountain'), index);
    expect(r.snapshot).not.toBeNull();
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]?.level).toBe('warn');
    expect(r.issues[0]?.message).toMatch(/not Standard-legal/);
  });

  it('requires source URLs on real lists and a file name matching the format', async () => {
    const noSource = { format: 'standard', decks: [{ archetype: 'Boros', list: 'Deck\n60 Mountain' }] };
    expect((await validateSnapshot('standard.json', noSource, index)).issues[0]?.message).toMatch(/sourceUrl/);
    const misnamed = await validateSnapshot('pioneer.json', real('Deck\n60 Mountain'), index);
    expect(misnamed.issues.some((i) => i.level === 'error' && /declares format/.test(i.message))).toBe(true);
  });
});

describe('loadCurated', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'whetstone-curated-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads every <format>.json in name order and reports bad files', async () => {
    const meta = path.join(dir, 'curated', 'mtga', 'meta');
    mkdirSync(meta, { recursive: true });
    writeFileSync(path.join(meta, 'standard.json'), JSON.stringify(real('Deck\n4 Shock\n56 Mountain')));
    writeFileSync(path.join(meta, 'explorer.json'), '{}');
    writeFileSync(path.join(meta, 'historic.json'), '{ not json');
    const r = await loadCurated(dir, index);
    expect(r.snapshots.map((s) => s.format)).toEqual(['standard']);
    expect(r.issues.map((i) => i.message)).toEqual([
      expect.stringMatching(/explorer\.json: file name must be/),
      expect.stringMatching(/historic\.json: invalid JSON/),
    ]);
  });

  it('returns nothing when the directory does not exist', async () => {
    expect(await loadCurated(path.join(dir, 'nowhere'), index)).toEqual({ snapshots: [], issues: [] });
  });
});
