import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseAndResolve } from '../src/core/deck.js';
import { buildMeta, compareToMeta, snapshotSchema } from '../src/core/meta.js';
import { loadSnapshot } from '../src/data/snapshots.js';
import { findRulesTxtUrl, loadRules, lookupNumber, parseRules, searchRules } from '../src/data/rules.js';
import { packageRoot } from '../src/data/paths.js';
import { createServer } from '../src/server.js';
import { fixtureIndex, readFixture, testContext } from './fixture.js';
import { call, connect } from './helpers.js';

const metaJson = () => JSON.parse(readFixture('meta-historic.json'));

describe('compare_to_meta', () => {
  it('finds the closest archetype, missing core cards and unusual inclusions', async () => {
    const index = await fixtureIndex();
    const meta = await buildMeta(metaJson().decks, index);
    const deck = await parseAndResolve(readFixture('tiers/t3-gruul.txt'), index);
    const r = compareToMeta(deck, meta)!;
    expect(r.closest.archetype).toBe('Gruul Midrange');
    expect(r.closest.overlapPercent).toBeGreaterThan(30);
    expect(r.closest.overlapPercent).toBeLessThan(100);
    expect(r.missingCore.map((c) => c.name)).toEqual(expect.arrayContaining(['Fable of the Mirror-Breaker // Reflection of Kiki-Jiki', 'Burst Lightning']));
    expect(r.unusual.map((c) => c.name)).toEqual(expect.arrayContaining(['Colossal Dreadmaw', 'Giant Growth', 'Raging Goblin']));
    expect(r.ranking).toHaveLength(3);
  });

  it('scores an exact meta copy at 100% overlap', async () => {
    const index = await fixtureIndex();
    const meta = await buildMeta(metaJson().decks, index);
    const deck = await parseAndResolve(readFixture('tiers/t5-mono-red.txt'), index);
    const r = compareToMeta(deck, meta)!;
    expect(r.closest).toMatchObject({ archetype: 'Mono-Red Aggro', overlapPercent: 100, winRate: 0.54 });
    expect(r.missingCore).toEqual([]);
    expect(r.unusual).toEqual([]);
  });

  it('loads a local snapshot when no lists are passed', async () => {
    const configDir = mkdtempSync(path.join(os.tmpdir(), 'grindstone-meta-'));
    mkdirSync(path.join(configDir, 'meta'));
    writeFileSync(path.join(configDir, 'meta', 'historic.json'), readFixture('meta-historic.json'));
    expect(loadSnapshot(configDir, 'historic')?.snapshot.decks).toHaveLength(3);
    expect(loadSnapshot(configDir, 'standard')).toBeNull();

    const client = await connect(createServer(testContext({ configDir })));
    const r = await call(client, 'compare_to_meta', { text: readFixture('tiers/t5-mono-red.txt'), format: 'historic' });
    expect(r.isError).toBe(false);
    expect(String(r.body.metaSource)).toMatch(/^snapshot: /);
    const rated = await call(client, 'rate_power', { text: readFixture('tiers/t5-mono-red.txt'), format: 'historic' });
    expect(rated.body).toMatchObject({ tier: 5 });

    const none = await call(client, 'compare_to_meta', { text: readFixture('standard-boros.txt'), format: 'standard' });
    expect(none).toMatchObject({ isError: true, body: { error: 'no_meta' } });
  });

  it('ships an example snapshot that matches the schema and resolves', async () => {
    const example = JSON.parse(readFixture('../../meta/example-standard.json'));
    expect(snapshotSchema.safeParse(example).success).toBe(true);
    const meta = await buildMeta(example.decks, await fixtureIndex());
    expect(meta.unresolved).toEqual([]);
    expect(packageRoot()).toBeTruthy();
  });
});

describe('lookup_rule', () => {
  const doc = parseRules(readFixture('rules-sample.txt'), 'fixture');

  it('parses rules, examples, effective date and glossary (skipping the contents)', () => {
    expect(doc.effective).toBe('January 1, 2030');
    expect(doc.byNumber.get('100.1')?.text).toBe('These sample rules apply to any game of Sample Magic.');
    expect(doc.byNumber.get('100.2')?.examples).toEqual(['A player brings a deck of sixty cards.']);
    expect(doc.rules.filter((r) => r.number === '100')).toHaveLength(1);
    expect(doc.glossary.get('stomping')?.definition).toMatch(/excess combat damage/);
  });

  it('looks up a rule with its subrules, and searches by keyword', () => {
    expect(lookupNumber(doc, '702.19').map((r) => r.number)).toEqual(['702.19', '702.19a', '702.19b', '702.19c']);
    expect(lookupNumber(doc, '702.19b.').map((r) => r.number)).toEqual(['702.19b']);
    const s = searchRules(doc, 'stomping planeswalkers');
    expect(s.rules[0]!.number).toBe('702.19c');
    expect(searchRules(doc, 'two-player game').glossary?.term).toBe('Two-Player Game');
  });

  it('finds the current .txt link on the Wizards rules page', () => {
    const html =
      '<a href="https://media.wizards.com/2026/downloads/MagicCompRules 20260925.pdf">PDF</a>' +
      '<a href="https://media.wizards.com/2026/downloads/MagicCompRules 20260925.txt">TXT</a>';
    expect(findRulesTxtUrl(html)).toBe('https://media.wizards.com/2026/downloads/MagicCompRules%2020260925.txt');
    expect(findRulesTxtUrl('<html></html>')).toBeNull();
  });

  it('downloads once, caches, and serves the cache offline', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'grindstone-rules-'));
    const urls: string[] = [];
    const fetch = async (url: string) => {
      urls.push(url);
      if (url.endsWith('/en/rules')) return new Response('<a href="https://media.wizards.com/2030/downloads/MagicCompRules 20300101.txt">x</a>');
      return new Response(readFixture('rules-sample.txt'));
    };
    let clock = 1_000_000;
    const first = await loadRules({ dir, fetch, online: true, now: () => clock });
    expect(first.byNumber.has('702.19a')).toBe(true);
    expect(urls).toHaveLength(2);
    await loadRules({ dir, fetch, online: true, now: () => clock });
    expect(urls).toHaveLength(2);
    clock += 8 * 24 * 3600 * 1000; // stale: re-checks the page, same URL → no re-download
    await loadRules({ dir, fetch, online: true, now: () => clock });
    expect(urls).toHaveLength(3);
    const offline = await loadRules({ dir, fetch: async () => { throw new Error('offline'); }, online: false });
    expect(offline.byNumber.has('100.1a')).toBe(true);
    await expect(loadRules({ dir: mkdtempSync(path.join(os.tmpdir(), 'gr-')), fetch, online: false })).rejects.toThrow();
  });

  it('is exposed as lookup_rule, with a structured error when unavailable', async () => {
    const client = await connect(createServer(testContext()));
    const r = await call(client, 'lookup_rule', { number: '702.19' });
    expect(r.isError).toBe(true);
    expect(r.body.error).toBe('rules_unavailable');
    const missing = await call(client, 'lookup_rule', {});
    expect(missing.body.error).toBe('missing_query');
  });
});

describe('tune_my_deck prompt', () => {
  it('walks the full sequence', async () => {
    const client = await connect(createServer(testContext()));
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain('tune_my_deck');
    const p = await client.getPrompt({
      name: 'tune_my_deck',
      arguments: { decklist: '4 Shock\n56 Mountain', format: 'standard', goal: 'casual', budget: '4 rares' },
    });
    const text = (p.messages[0]!.content as { text: string }).text;
    for (const step of ['parse_decklist', 'validate_deck', 'analyze_deck', 'rate_power', 'compare_to_meta', 'suggest_upgrades']) {
      expect(text).toContain(step);
    }
    expect(text).toContain('casual');
    expect(text.indexOf('rate_power')).toBeLessThan(text.indexOf('compare_to_meta'));
  });
});
