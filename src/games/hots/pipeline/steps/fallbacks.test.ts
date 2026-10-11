/**
 * Step-level fallbacks with a fake transport: a lagging or unreachable rotation source and an
 * implausible Liquipedia result (pipeline-custody/F4, hots-logic/F4).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Http, HttpInit, PipelineContext } from '../../../../core/game.ts';
import type { Pro, Rotation } from '../../schema.ts';
import { FIXTURE_NOW, REPO_ROOT, fixtureRelease, rawJson, testCurated } from '../test-helpers.ts';
import { buildHeroes } from '../transform/heroes.ts';
import { createEnv, type RunEnv } from './common.ts';
import { implausiblePro, runLiquipedia } from './liquipedia.ts';
import { runRotation } from './rotation.ts';

const heroes = buildHeroes(fixtureRelease('2.57.0.98348'), { aliases: testCurated().aliases, now: FIXTURE_NOW }).heroes;

/** A transport that answers by fixture key (`init.fixture`), or fails like a dead host. */
function fakeHttp(answer: (fixture: string) => unknown): Http {
  const json = async <T,>(_url: string, init?: HttpInit): Promise<T> => {
    const body = answer(init?.fixture ?? '');
    if (body instanceof Error) throw body;
    return body as T;
  };
  const no = async (): Promise<never> => {
    throw new Error('not used');
  };
  return { json, text: no, bytes: no, head: no, request: no };
}

function env(now: string, http: Http, previous: Record<string, unknown>): RunEnv {
  const ctx: PipelineContext = {
    game: 'hots',
    http,
    secrets: {},
    previous: async (p) => previous[p] ?? null,
    previousMeta: null,
    now: new Date(now),
    offline: false,
    root: REPO_ROOT,
    log: () => {},
  };
  return createEnv(ctx);
}

describe('rotation fallbacks', () => {
  const lastWeek: Rotation = { source: 'nexus-compendium', fetchedAt: '2026-10-02T10:00:00.000Z', start: '2026-10-01', end: '2026-10-08', allFree: false, heroes: ['Abat'], ranked: null };

  it('re-emits last-good with lagging: true when the source is down after the window ended', async () => {
    const e = env('2026-10-09T10:17:00Z', fakeHttp(() => new Error('nexuscompendium.com is down')), { 'rotation.json': lastWeek });
    const r = await runRotation(e, heroes);
    expect(r).toEqual({ ...lastWeek, lagging: true });
    expect(e.statuses.get('nexus-compendium')?.status).toBe('stale');
  });

  it('leaves a current last-good rotation unflagged', async () => {
    const e = env('2026-10-05T10:17:00Z', fakeHttp(() => new Error('down')), { 'rotation.json': lastWeek });
    expect(await runRotation(e, heroes)).toEqual(lastWeek);
  });

  it('flags the same week reported again after the switch, keeping its "as of" time', async () => {
    const raw = rawJson<{ RotationHero: { Heroes: unknown[] } }>('nexus-compendium/currently.json');
    // The recorded window is 2026-10-01..2026-10-08; name a fixture hero so the rotation is usable.
    const answer = { ...raw, RotationHero: { ...raw.RotationHero, Heroes: [{ ID: 'abathur', Name: 'Abathur' }] } };
    const first = await runRotation(env('2026-10-07T10:17:00Z', fakeHttp(() => answer), {}), heroes);
    expect(first?.lagging).toBeUndefined();
    const e = env('2026-10-09T10:17:00Z', fakeHttp(() => answer), { 'rotation.json': first });
    const second = await runRotation(e, heroes);
    expect(second).toEqual({ ...first, lagging: true });
    expect(e.statuses.get('nexus-compendium')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/not yet updated upstream/) });
  });
});

describe('liquipedia plausibility', () => {
  const window = (label: string) => ({ label, from: '2026-01-01', to: '2026-12-31' });

  it('rejects an empty result or a large drop within the same window', () => {
    const prev = { window: window('2026 tournaments'), totals: { tournaments: 40, maps: 766 } };
    expect(implausiblePro({ window: window('2026 tournaments'), totals: { tournaments: 0, maps: 0 } }, prev)).toMatch(/no drafted maps/);
    expect(implausiblePro({ window: window('2026 tournaments'), totals: { tournaments: 10, maps: 300 } }, prev)).toMatch(/fell from 766 to 300/);
    expect(implausiblePro({ window: window('2026 tournaments'), totals: { tournaments: 39, maps: 700 } }, prev)).toBeNull();
    // A new window (new year) may legitimately start smaller; a first run has nothing to compare.
    expect(implausiblePro({ window: window('2027 tournaments'), totals: { tournaments: 2, maps: 60 } }, prev)).toBeNull();
    expect(implausiblePro({ window: window('2026 tournaments'), totals: { tournaments: 0, maps: 0 } }, null)).toBeNull();
  });

  it('keeps last-good pro.json with status stale when the search comes back empty', async () => {
    const prevPro = JSON.parse(readFileSync(path.join(REPO_ROOT, 'fixtures', 'hots', 'pro.json'), 'utf8')) as Pro;
    const answer = (fixture: string): unknown => {
      if (fixture.startsWith('liquipedia/search-')) return { query: { search: [] } };
      if (fixture.startsWith('liquipedia/revisions-')) return { query: { pages: [] } };
      if (fixture.startsWith('liquipedia/pages-')) return rawJson('liquipedia/pages-1.json');
      return new Error(`unexpected request ${fixture}`);
    };
    // A Monday: the weekly full refresh, no incremental shortcut.
    const e = env('2026-10-12T10:17:00Z', fakeHttp(answer), { 'pro.json': prevPro });
    const r = await runLiquipedia(e, heroes);
    expect(r.pro).toEqual(prevPro);
    expect(e.statuses.get('liquipedia')).toMatchObject({ status: 'stale', detail: expect.stringMatching(/implausible result/) });
    expect(e.issues.some((i) => i.level === 'warn' && i.source === 'liquipedia' && /implausible/.test(i.message))).toBe(true);
    // The page checks are separate queries and stay fresh.
    expect(r.heroPages.get('Abat')).toBe('Abathur');
  });
});
