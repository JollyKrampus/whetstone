import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Http, PipelineResult } from '../../../core/game.ts';
import { repoRoot } from '../../../lib/datadir.ts';
import { createContext } from '../../../../pipeline/context.ts';
import { createHttp } from '../../../../pipeline/http.ts';
import { runPipelines } from '../../../../pipeline/run.ts';
import { validateFiles } from '../../../../pipeline/validate.ts';
import { LimitedRatingsSchema, MTGA_FILES, MtgaMetaExtraSchema } from '../schema.ts';
import { LIMITED_FORMATS, pipeline, readGrindstoneVersion } from './index.ts';

const ROOT = repoRoot();
const NOW = new Date('2026-10-08T10:17:00Z');
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(path.join(tmpdir(), 'whetstone-mtga-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const offlineHttp = (): Http => createHttp({ game: 'mtga', root: ROOT, offline: true });

/** Offline fixtures, with requests to hosts matching `fail` throwing a network error. */
function failingHttp(fail: RegExp): Http {
  const base = offlineHttp();
  const guard = <T>(url: string, f: () => Promise<T>) => (fail.test(url) ? Promise.reject(Object.assign(new Error('getaddrinfo ENOTFOUND'), { status: 0 })) : f());
  return {
    json: (url, init) => guard(url, () => base.json(url, init)),
    text: (url, init) => guard(url, () => base.text(url, init)),
    bytes: (url, init) => guard(url, () => base.bytes(url, init)),
    head: (url, init) => guard(url, () => base.head(url, init)),
    request: (url, init) => guard(url, () => base.request(url, init)),
  };
}

async function run(out: string, http: Http = offlineHttp(), only: string[] | null = null): Promise<PipelineResult> {
  const ctx = createContext({ game: 'mtga', root: ROOT, out, http, env: {}, now: NOW, offline: true, only, log: () => {} });
  return pipeline.run(ctx);
}

/** Write a run through the real runner so the next run sees it as last-good data. */
async function runAndWrite(out: string, httpFor: () => Http = offlineHttp) {
  return runPipelines({ root: ROOT, out, games: ['mtga'], offline: true, env: {}, now: NOW, httpFor, print: () => {} });
}

describe('mtga pipeline (offline fixtures)', () => {
  it('builds every registered file, valid against the schemas, with no issues', async () => {
    const r = await run(tmp());
    expect(r.issues).toEqual([]);
    expect(r.files.map((f) => f.path).sort()).toEqual([
      'limited/HOB.PremierDraft.json',
      'limited/HOB.Sealed.json',
      'limited/index.json',
      'meta/standard.json',
      'public/_cards.arena.json',
      'public/_cards.standard.json',
      'sets.json',
    ]);
    expect(r.files.every((f) => f.custody === 'A')).toBe(true);
    expect(validateFiles(r.files, MTGA_FILES)).toEqual([]);
    expect(r.meta.sources.map((s) => [s.id, s.status])).toEqual([
      ['scryfall', 'ok'],
      ['17lands', 'ok'],
      ['curated-meta', 'ok'],
      ['grindstone-mcp', 'ok'],
    ]);
    const extra = MtgaMetaExtraSchema.parse(r.meta.extra);
    expect(extra.grindstone).toBe(readGrindstoneVersion().version);
    expect(r.meta.sources.find((s) => s.id === 'grindstone-mcp')?.detail).toBe(`grindstone-mcp ${extra.grindstone}, workspace package`);
    expect(extra.latestSet).toBe(r.meta.version.label);
    expect(extra.metaFormats).toEqual(['standard']);
    // The curated Standard lists are real (no example decks) and every card resolves offline.
    expect(r.meta.counts).toMatchObject({ limitedSets: 1, metaDecks: 10 });
    expect(r.meta.sources.find((s) => s.id === 'curated-meta')?.detail).toBe('1 format(s), 10 list(s)');
    expect(r.meta.counts.cards).toBeGreaterThan(r.meta.counts.standardCards!);
  });

  it('runs grindstone-mcp from the workspace package (packages/grindstone-mcp)', async () => {
    const core = (await import('grindstone-mcp/core')) as Record<string, unknown>;
    expect(typeof core.suggestUpgrades).toBe('function');
    expect(typeof core.aggregateCards).toBe('function');
    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'packages', 'grindstone-mcp', 'package.json'), 'utf8')) as { version: string };
    expect(readGrindstoneVersion().version).toBe(pkg.version);
  });

  it('computes Limited ratings from the recorded 17Lands sample, with card ids from the index', async () => {
    const r = await run(tmp());
    const premier = LimitedRatingsSchema.parse(r.files.find((f) => f.path === 'limited/HOB.PremierDraft.json')?.data);
    expect(premier.totals).toEqual({ games: 240, drafts: 3 });
    expect(premier.cards.map((c) => c.name)).not.toContain('Mountain');
    const party = premier.cards.find((c) => c.name === 'An Unexpected Party')!;
    expect(party.oracleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(party.rarity).toBe('rare');
    expect(party.colors).toBe('W');
    expect(party.ata).not.toBeNull();
    // A name with a comma survives the CSV round trip.
    expect(premier.cards.some((c) => c.name === 'Bilbo Baggins, Burglar')).toBe(true);
    const sealed = LimitedRatingsSchema.parse(r.files.find((f) => f.path === 'limited/HOB.Sealed.json')?.data);
    expect(sealed.dataset.draftData).toBeUndefined();
    expect(sealed.cards.every((c) => c.ata === null && c.alsa === null)).toBe(true);
    expect(LIMITED_FORMATS[0]).toBe('PremierDraft');
  });

  it('is deterministic and reuses unchanged sources on the next run', async () => {
    const out = tmp();
    const first = await runAndWrite(out);
    expect(first.reports[0]?.status.state).toBe('ok');
    const second = await runAndWrite(out);
    expect(second.reports[0]?.status.changed).toBe(false);
    expect(second.reports[0]?.status.dataHash).toBe(first.reports[0]?.status.dataHash);
  });

  it('keeps last-good Limited data when 17Lands is unreachable', async () => {
    const out = tmp();
    await runAndWrite(out);
    const r = await run(out, failingHttp(/17lands/));
    expect(r.issues.some((i) => i.level === 'error')).toBe(false);
    expect(r.issues.find((i) => i.source === '17lands')?.level).toBe('warn');
    expect(r.meta.sources.find((s) => s.id === '17lands')?.status).toBe('failed');
    expect(r.files.map((f) => f.path)).toContain('limited/HOB.PremierDraft.json');
  });

  it('keeps last-good card data when Scryfall fails, and errors when there is none', async () => {
    const out = tmp();
    await runAndWrite(out);
    const kept = await run(out, failingHttp(/scryfall/));
    expect(kept.issues.find((i) => i.source === 'scryfall')?.level).toBe('warn');
    expect(kept.meta.sources[0]).toMatchObject({ id: 'scryfall', status: 'failed' });
    expect(kept.files.map((f) => f.path)).toContain('public/_cards.arena.json');

    const fresh = await run(tmp(), failingHttp(/scryfall/));
    expect(fresh.files).toEqual([]);
    expect(fresh.issues.find((i) => i.level === 'error')?.message).toMatch(/no card data/);
  });

  it('honours --only by re-emitting the other sources unchanged', async () => {
    const out = tmp();
    const first = await runAndWrite(out);
    const r = await run(out, failingHttp(/scryfall/), ['17lands']);
    expect(r.issues).toEqual([]);
    expect(r.meta.sources.find((s) => s.id === 'scryfall')).toEqual(first.status.games.mtga?.sources.find((s) => s.id === 'scryfall'));
    expect(r.files).toHaveLength(7);
  });
});
