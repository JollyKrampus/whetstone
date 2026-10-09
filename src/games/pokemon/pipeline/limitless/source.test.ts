import { describe, expect, it } from 'vitest';
import { TournamentsSchema, type Item, type Species, type Tournaments } from '../../schema.ts';
import { dexIndex } from '../ids.ts';
import { regulationPlan } from '../regulations.ts';
import { fakeContext, fakeHttp, WITH_NEXT } from '../test-support.ts';
import type { KnownIds } from './aggregate.ts';
import { LIMITLESS_API, LIMITLESS_SPACING_MS, MIN_PLAYERS, runLimitlessSource, selectTournaments, WINDOW_DAYS } from './source.ts';

const NOW = new Date('2026-10-08T12:00:00Z');
const stub = { base: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, abilities: ['x'], weightkg: 1, legal: ['M-C'] };
const species: Species[] = [
  { ...stub, id: 'incineroar', name: 'Incineroar', num: 727, types: ['Fire', 'Dark'] },
  { ...stub, id: 'rillaboom', name: 'Rillaboom', num: 812, types: ['Grass'] },
];
const items: Item[] = [{ id: 'sitrusberry', name: 'Sitrus Berry', legal: ['M-C'] }];
const known: KnownIds = { dex: dexIndex(species, items), moves: new Set(['fakeout']), items: new Set(['sitrusberry']), abilities: new Set(['intimidate']) };

const listing = (id: string, date: string, players: number, format = 'M-C') => ({ game: 'VGC', name: `Cup ${id}`, date, format, id, players, organizerId: 1 });
const row = (placing: number, wins: number, losses: number) => ({
  name: `Player ${placing}`,
  player: `handle${placing}`,
  country: 'US',
  placing,
  record: { wins, losses, ties: 0 },
  decklist: [
    { id: 'incineroar', name: 'Incineroar', item: 'Sitrus Berry', ability: 'Intimidate', attacks: ['Fake Out'], nature: 'Careful' },
    { id: 'rillaboom', name: 'Rillaboom', attacks: ['Fake Out'] },
  ],
});

describe('selectTournaments', () => {
  it('keeps the largest finished events of the window with enough players', () => {
    const list = [
      listing('small', '2026-10-01T10:00:00Z', MIN_PLAYERS - 1),
      listing('running', '2026-10-08T06:00:00Z', 500),
      listing('old', '2026-09-07T10:00:00Z', 500),
      listing('b', '2026-10-02T10:00:00Z', 64),
      listing('a', '2026-10-03T10:00:00Z', 64),
      listing('big', '2026-09-20T10:00:00Z', 120),
      listing('a', '2026-10-03T10:00:00Z', 64),
    ];
    expect(selectTournaments(list, NOW).map((t) => t.id)).toEqual(['big', 'a', 'b']);
    expect(selectTournaments(list, NOW, 1).map((t) => t.id)).toEqual(['big']);
    expect(WINDOW_DAYS).toBe(30);
  });
});

describe('runLimitlessSource', () => {
  const plan = regulationPlan(WITH_NEXT, NOW);
  const page1 = `${LIMITLESS_API}/tournaments?game=VGC&format=M-C&limit=50&page=1`;

  it('anonymises standings into tournaments.json, throttled to the API limit', async () => {
    const http = fakeHttp({
      [page1]: [listing('t1', '2026-10-05T10:00:00Z', 32), listing('t2', '2026-10-06T10:00:00Z', 16)],
      [`${LIMITLESS_API}/tournaments/t1/standings`]: [row(1, 5, 0), row(2, 4, 1), row(3, 3, 2)],
      [`${LIMITLESS_API}/tournaments/t2/standings`]: [row(1, 4, 0)],
    });
    const ctx = fakeContext({ http, now: NOW });
    const r = await runLimitlessSource(ctx, plan, known, true);
    expect(r.status).toMatchObject({ id: 'limitless', status: 'ok', fetchedAt: NOW.toISOString() });
    expect(r.issues).toEqual([]);
    expect(r.regulation).toBe('M-C');
    expect(r.counts).toEqual({ tournaments: 2, teams: 4 });
    const t = r.files[0]?.data as Tournaments;
    expect(r.files.map((f) => f.path)).toEqual(['tournaments.json']);
    expect(TournamentsSchema.safeParse(t).success).toBe(true);
    expect(JSON.stringify(t)).not.toMatch(/Player \d|handle\d|"US"/);
    expect(t.tournaments.map((x) => [x.id, x.url])).toEqual([
      ['t2', 'https://play.limitlesstcg.com/tournament/t2/standings'],
      ['t1', 'https://play.limitlesstcg.com/tournament/t1/standings'],
    ]);
    // One page (fewer than 50 rows) plus one standings call per event, all spaced ≥ 6.5 s.
    expect(http.calls).toHaveLength(3);
    expect(http.inits.every((i) => (i?.spacingMs ?? 0) >= LIMITLESS_SPACING_MS)).toBe(true);
    expect(LIMITLESS_SPACING_MS).toBeGreaterThanOrEqual(6_000);
  });

  it('falls back to the previous regulation right after a rollover', async () => {
    const after = regulationPlan(WITH_NEXT, new Date('2026-12-03T12:00:00Z'));
    const http = fakeHttp({
      [`${LIMITLESS_API}/tournaments?game=VGC&format=M-D&limit=50&page=1`]: [],
      [`${LIMITLESS_API}/tournaments?game=VGC&format=M-C&limit=50&page=1`]: [listing('t9', '2026-11-29T10:00:00Z', 40)],
      [`${LIMITLESS_API}/tournaments/t9/standings`]: [row(1, 5, 0)],
    });
    const r = await runLimitlessSource(fakeContext({ http, now: new Date('2026-12-03T12:00:00Z') }), after, known, true);
    expect(r.status.status).toBe('ok');
    expect(r.regulation).toBe('M-C');
    expect((r.files[0]?.data as Tournaments).regulation).toBe('M-C');
  });

  it('keeps the last-good file and reports failed when the API is down', async () => {
    const previous: Tournaments = {
      source: 'limitless',
      attribution: { source: 'limitless', text: 'Tournament data: Limitless', url: 'https://play.limitlesstcg.com/' },
      regulation: 'M-C',
      format: 'M-C',
      window: { label: 'Last 30 days', from: '2026-09-08', to: '2026-10-07' },
      totals: { tournaments: 0, players: 0, teams: 0 },
      tournaments: [],
      species: [],
      archetypes: [],
      teams: [],
    };
    const previousMeta = {
      game: 'pokemon' as const,
      schema: 1,
      version: { label: 'Reg M-C' },
      generatedAt: '2026-10-07T10:30:00Z',
      dataHash: 'abcdef0123456789',
      sources: [{ id: 'limitless', fetchedAt: '2026-10-07T10:20:00Z', status: 'ok' as const }],
      counts: {},
    };
    const http = fakeHttp({ [LIMITLESS_API]: new Error('GET -> 503 after 4 attempt(s)') });
    const r = await runLimitlessSource(fakeContext({ http, now: NOW, previous: { 'tournaments.json': previous }, previousMeta }), plan, known, true);
    expect(r.status).toMatchObject({ status: 'failed', fetchedAt: '2026-10-07T10:20:00Z' });
    expect(r.status.detail).toMatch(/503/);
    expect(r.files).toEqual([{ path: 'tournaments.json', data: previous, custody: 'A' }]);
    expect(r.issues).toEqual([expect.objectContaining({ level: 'warn', source: 'limitless' })]);

    const first = await runLimitlessSource(fakeContext({ http, now: NOW }), plan, known, true);
    expect(first.status).toMatchObject({ status: 'failed', fetchedAt: null });
    expect(first.files).toEqual([]);
    // Optional data: a first run without tournaments is a warning, not an error.
    expect(first.issues.every((i) => i.level === 'warn')).toBe(true);
  });

  it('does not re-serve synthetic fixtures as last-good data and honours --only', async () => {
    const synthetic = { synthetic: true };
    const ctx = fakeContext({ now: NOW, previous: { 'tournaments.json': synthetic } });
    const skipped = await runLimitlessSource(ctx, plan, known, false);
    expect(skipped.status).toMatchObject({ status: 'disabled' });
    expect(skipped.files).toEqual([]);
    const noDex = await runLimitlessSource(ctx, plan, null, true);
    expect(noDex.status.status).toBe('failed');
  });
});

describe('runLimitlessSource partial failures', () => {
  const plan = regulationPlan(WITH_NEXT, NOW);
  const page1 = `${LIMITLESS_API}/tournaments?game=VGC&format=M-C&limit=50&page=1`;
  const list = [listing('t1', '2026-10-05T10:00:00Z', 32), listing('t2', '2026-10-06T10:00:00Z', 30), listing('t3', '2026-10-04T10:00:00Z', 20)];

  it('leaves out an event whose standings fail and keeps the rest', async () => {
    const http = fakeHttp({
      [page1]: list,
      [`${LIMITLESS_API}/tournaments/t1/standings`]: [row(1, 5, 0)],
      [`${LIMITLESS_API}/tournaments/t2/standings`]: new Error('GET -> 500 after 4 attempt(s)'),
      [`${LIMITLESS_API}/tournaments/t3/standings`]: [row(1, 3, 1)],
    });
    const r = await runLimitlessSource(fakeContext({ http, now: NOW }), plan, known, true);
    expect(r.status.status).toBe('ok');
    expect(r.counts).toEqual({ tournaments: 2, teams: 2 });
    expect(r.issues).toEqual([expect.objectContaining({ level: 'warn', message: expect.stringMatching(/left out 1 of 3 events.*t2/) })]);
  });

  it('fails the source when most events fail', async () => {
    const http = fakeHttp({ [page1]: list, [`${LIMITLESS_API}/tournaments/t1/standings`]: [row(1, 5, 0)], [`${LIMITLESS_API}/tournaments/`]: new Error('GET -> 429') });
    const r = await runLimitlessSource(fakeContext({ http, now: NOW }), plan, known, true);
    expect(r.status).toMatchObject({ status: 'failed', detail: expect.stringMatching(/2 of 3 standings failed/) });
  });
});
