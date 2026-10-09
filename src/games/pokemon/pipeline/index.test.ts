import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Http } from '../../../core/game.ts';
import { runPipelines, type RunOptions } from '../../../../pipeline/run.ts';
import { registryEntry, validateData } from '../../../../pipeline/validate.ts';
import { H2HSchema, POKEMON_FILES, PokemonMetaSchema, TournamentsSchema, type PokemonMeta, type Usage } from '../schema.ts';
import { regulationPlan } from './regulations.ts';
import { readRecordedExport } from './showdown/source.ts';
import { LIMITLESS_API } from './limitless/source.ts';
import { REPLAY_API } from './replays/source.ts';
import { STATS_ROOT } from './smogon/source.ts';
import { SPRITE_SOURCE } from './sprites.ts';
import { pipeline, runPokemon, speedUsage, warmingUp } from './index.ts';
import { fakeContext, fakeHttp, RAW, RECORDED_AT, ROOT, WITH_NEXT, type Route } from './test-support.ts';

let tmp: string;
let out: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'ws-pk-'));
  out = path.join(tmp, 'data');
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const down: Http = {
  json: () => Promise.reject(new Error('GET -> 503 (network down in this test)')),
  text: () => Promise.reject(new Error('GET -> 503 (network down in this test)')),
  bytes: () => Promise.reject(new Error('GET -> 503 (network down in this test)')),
  head: () => Promise.reject(new Error('GET -> 503 (network down in this test)')),
};

function run(extra: Partial<RunOptions> = {}) {
  return runPipelines({ root: ROOT, out, games: ['pokemon'], offline: true, env: { WHETSTONE_HTTP_CACHE: '0' }, now: RECORDED_AT, print: () => {}, ...extra });
}

const current = (rel: string): string => readFileSync(path.join(out, 'current', 'pokemon', rel), 'utf8');
const json = <T>(rel: string): T => JSON.parse(current(rel)) as T;

function listFiles(dir: string, base = dir): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    return statSync(p).isDirectory() ? listFiles(p, base) : [path.relative(base, p).split(path.sep).join('/')];
  });
}

describe('offline end-to-end run (recorded fixtures)', () => {
  it('writes every Pokémon file, valid against POKEMON_FILES, with no player data', async () => {
    const summary = await run();
    const report = summary.reports[0]!;
    expect(report.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(report.status.state).toBe('ok');
    expect(summary.exitCode).toBe(0);

    const files = listFiles(path.join(out, 'current', 'pokemon')).sort();
    expect(files).toEqual(
      [
        '_files.json',
        'dex/abilities.json',
        'dex/items.json',
        'dex/learnsets.json',
        'dex/moves.json',
        'dex/species.json',
        'dex/typechart.json',
        'h2h.json',
        'ledger/showdown-replays.json',
        'meta.json',
        'public/dex.json',
        'regulations.json',
        'speed.json',
        'tournaments.json',
        'usage/gen9championsbssregmc-1760.json',
        'usage/gen9championsvgc2026regmc-1760.json',
        'usage/gen9championsvgc2026regmcbo3-1760.json',
        'usage/index.json',
      ].sort(),
    );
    for (const f of files.filter((x) => x !== 'meta.json' && x !== '_files.json')) {
      const spec = registryEntry(POKEMON_FILES, f);
      expect(spec, f).not.toBeNull();
      expect(validateData(spec!.schema, json(f), { file: f }).issues, f).toEqual([]);
    }
    const meta = PokemonMetaSchema.parse(json('meta.json'));
    expect(meta.version).toEqual({ label: 'Reg M-C', since: '2026-09-09' });
    expect(meta.sources.map((s) => [s.id, s.status])).toEqual([
      ['showdown', 'ok'],
      ['smogon', 'ok'],
      ['limitless', 'ok'],
      ['showdown-replays', 'ok'],
      ['smogon-calc', 'ok'],
    ]);
    expect(meta.extra).toMatchObject({ regulation: 'M-C', season: { id: 'M-7' }, smogonMonth: '2026-09', showdownSha: '7332b60e22b9e8194bb53549549eba241d73cc9a' });
    expect(meta.extra.warmingUp).toBeUndefined();
    expect(meta.counts).toMatchObject({ usageFiles: 3, tournaments: 2, replays: 6 });
    expect(meta.counts.species).toBe(readRecordedExport(ROOT).species.length);

    // Names in the recorded responses are placeholders; none may reach the output.
    const everything = files.map((f) => current(f)).join('\n');
    expect(everything).not.toMatch(/Player [AB0-9]|player-\d|"XX"/);
    const t = TournamentsSchema.parse(json('tournaments.json'));
    expect(t.totals.tournaments).toBe(2);
    expect(H2HSchema.parse(json('h2h.json')).replays).toBe(6);
  });

  it('is deterministic: a second run over the same inputs changes nothing', async () => {
    const first = await run();
    const second = await run();
    expect(second.reports[0]?.status.dataHash).toBe(first.reports[0]?.status.dataHash);
    expect(second.reports[0]?.status.changed).toBe(false);
  });

  it('keeps every source on its last-good data when the network is down', async () => {
    await run();
    const before = Object.fromEntries(['dex/species.json', 'usage/index.json', 'tournaments.json', 'h2h.json', 'speed.json'].map((f) => [f, current(f)]));
    const summary = await run({ offline: false, httpFor: () => down, now: new Date('2026-10-10T10:17:00Z') });
    const report = summary.reports[0]!;
    expect(report.status.state).toBe('ok');
    expect(report.issues.filter((i) => i.level === 'error')).toEqual([]);
    for (const [f, text] of Object.entries(before)) expect(current(f), f).toBe(text);
    const meta = json<PokemonMeta>('meta.json');
    const statuses = Object.fromEntries(meta.sources.map((s) => [s.id, s]));
    for (const id of ['showdown', 'smogon', 'limitless', 'showdown-replays']) {
      expect(statuses[id]).toMatchObject({ status: 'failed', fetchedAt: RECORDED_AT.toISOString() });
    }
    expect(statuses['smogon-calc']?.status).toBe('ok');
  });

  it('fails the game (nothing written) when there is no dex at all', async () => {
    const summary = await run({ offline: false, httpFor: () => down });
    expect(summary.reports[0]?.status.state).toBe('failed');
    expect(summary.exitCode).toBe(1);
    expect(summary.reports[0]?.issues).toContainEqual(expect.objectContaining({ level: 'error', source: 'showdown' }));
  });

  it('re-emits unselected sources with --only', async () => {
    await run();
    const summary = await run({ only: ['smogon'] });
    expect(summary.reports[0]?.status.state).toBe('ok');
    const statuses = Object.fromEntries(json<PokemonMeta>('meta.json').sources.map((s) => [s.id, s.status]));
    expect(statuses).toEqual({ showdown: 'stale', smogon: 'ok', limitless: 'stale', 'showdown-replays': 'stale', 'smogon-calc': 'ok' });
    expect(listFiles(path.join(out, 'current', 'pokemon'))).toContain('tournaments.json');
  });

  it('exports the DataPipeline the runner loads', () => {
    expect(typeof pipeline.run).toBe('function');
  });
});

describe('warm-up after a regulation change (M-C → M-D)', () => {
  it('switches to M-D at once and labels the sources still showing M-C', async () => {
    const now = new Date('2026-12-03T10:17:00Z');
    const raw = readRecordedExport(ROOT);
    const fixture = (rel: string): string => readFileSync(path.join(RAW, rel), 'utf8');
    const smogon = (file: string): string => fixture(`smogon/2026-09-${file}.json`);
    const replayRows = JSON.parse(fixture('replays/search-gen9championsvgc2026regmcbo3.json')) as { id: string; uploadtime: number }[];
    const routes: Record<string, Route> = {
      'https://api.github.com/repos/smogon/pokemon-showdown/commits/master': raw.sha,
      [SPRITE_SOURCE]: new Error('GET -> 404'),
      [STATS_ROOT]: fixture('smogon/index.txt').replace('2026-09/', '2026-11/'),
      [`${STATS_ROOT}2026-11/chaos/`]: fixture('smogon/2026-09-chaos-index.txt'),
      [`${STATS_ROOT}2026-11/chaos/gen9championsvgc2026regmc-1760.json`]: smogon('gen9championsvgc2026regmc-1760'),
      [`${STATS_ROOT}2026-11/chaos/gen9championsvgc2026regmcbo3-1760.json`]: smogon('gen9championsvgc2026regmcbo3-1760'),
      [`${STATS_ROOT}2026-11/chaos/gen9championsbssregmc-1760.json`]: smogon('gen9championsbssregmc-1760'),
      [`${LIMITLESS_API}/tournaments?game=VGC&format=M-D&limit=50&page=1`]: [],
      [`${LIMITLESS_API}/tournaments?game=VGC&format=M-C&limit=50&page=1`]: (JSON.parse(fixture('limitless/tournaments-M-C-p1.json')) as { date: string }[]).map((t, i) => ({ ...t, date: `2026-11-2${i}T10:00:00.000Z` })),
      [`${REPLAY_API}/search.json?format=gen9championsvgc2027regmdbo3`]: [],
      [`${REPLAY_API}/search.json?format=gen9championsvgc2026regmcbo3`]: replayRows,
    };
    for (const f of readdirSync(path.join(RAW, 'limitless')).filter((x) => x.startsWith('standings-'))) routes[`${LIMITLESS_API}/tournaments/${f.slice(10, -5)}/standings`] = fixture(`limitless/${f}`);
    for (const r of replayRows) routes[`${REPLAY_API}/${r.id}.log`] = fixture(`replays/log-${r.id}.txt`);

    const ctx = fakeContext({ http: fakeHttp(routes), now });
    const result = await runPokemon(ctx, {
      regulations: WITH_NEXT,
      dex: { exporter: async () => ({ ...structuredClone(raw), regulations: [...structuredClone(raw.regulations), { id: 'M-D', format: 'gen9championsvgc2027regmd', exists: false }] }), minSpecies: 50 },
    });
    expect(result.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(result.meta.version).toEqual({ label: 'Reg M-D', since: '2026-12-02' });
    const extra = result.meta.extra as PokemonMeta['extra'];
    expect(extra).toMatchObject({ regulation: 'M-D', regulationLabel: 'Regulation Set M-D', season: { id: 'M-9' }, formats: { doubles: 'gen9championsvgc2027regmd' } });
    expect(extra.warmingUp).toEqual({ regulation: 'M-D', since: '2026-12-02T02:00:00Z', sources: ['showdown', 'smogon', 'limitless', 'showdown-replays'], showing: 'M-C' });
    const speed = result.files.find((f) => f.path === 'speed.json')?.data as { regulation: string };
    expect(speed.regulation).toBe('M-C');
    expect((result.files.find((f) => f.path === 'usage/gen9championsvgc2026regmc-1760.json')?.data as Usage).month).toBe('2026-11');
  });
});

describe('helpers', () => {
  const plan = regulationPlan(WITH_NEXT, new Date('2026-12-03T00:00:00Z'));

  it('reports warm-up only for sources whose data is on another regulation', () => {
    expect(warmingUp(plan, { showdown: 'M-D', smogon: 'M-D', limitless: undefined })).toBeUndefined();
    expect(warmingUp(plan, { smogon: 'M-C', showdown: 'M-D', 'showdown-replays': 'M-C' })).toEqual({ regulation: 'M-D', since: '2026-12-02T02:00:00Z', sources: ['smogon', 'showdown-replays'], showing: 'M-C' });
  });

  it('bases speed tiers on the current doubles usage at the highest cutoff, else the previous regulation', () => {
    const u = (regulation: string, format: string, cutoff: 0 | 1500 | 1760) => ({ regulation, format, cutoff }) as Usage;
    const usage = [u('M-C', 'gen9championsvgc2026regmc', 1500), u('M-C', 'gen9championsvgc2026regmc', 1760), u('M-C', 'gen9championsbssregmc', 1760)];
    expect(speedUsage(usage, plan)).toBe(usage[1]);
    expect(speedUsage([u('M-D', 'gen9championsvgc2027regmd', 0), ...usage], plan)?.regulation).toBe('M-D');
    expect(speedUsage([usage[2]!], plan)).toBeNull();
  });

  it('refuses invalid regulations with an error before any source runs', async () => {
    const http = fakeHttp({});
    const r = await runPokemon(fakeContext({ http }), { regulations: { regulations: [] } });
    expect(r.files).toEqual([]);
    expect(r.issues).toEqual([expect.objectContaining({ level: 'error', message: expect.stringMatching(/regulations.yaml is invalid/) })]);
    expect(r.meta.game).toBe('pokemon');
    expect(http.calls).toEqual([]);
  });
});
