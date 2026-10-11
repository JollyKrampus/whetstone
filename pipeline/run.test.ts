import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DataPipeline, GameId, GameMeta, Http, OutputFile, PipelineContext, PipelineResult, ValidationIssue } from '../src/core/game.ts';
import { bearerTokens, gameEnvNames, isSelected, secretsFromEnv } from './context.ts';
import type { FileIndex, StatusFile } from './manifest.ts';
import { checkResult, degradedSources, failedSources, formatSummary, githubOutputs, loadGamePipeline, runPipelines, type RunOptions } from './run.ts';
import { listFiles } from './store.ts';

let root: string;
let out: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ws-run-'));
  out = path.join(root, 'data');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const noHttp: Http = {
  json: () => Promise.reject(new Error('no network in tests')),
  text: () => Promise.reject(new Error('no network in tests')),
  bytes: () => Promise.reject(new Error('no network in tests')),
  head: () => Promise.reject(new Error('no network in tests')),
  request: () => Promise.reject(new Error('no network in tests')),
};

function meta(game: GameId, extra: Partial<PipelineResult['meta']> = {}): PipelineResult['meta'] {
  return {
    game,
    schema: 1,
    version: { label: '2.57', build: '2.57.0.98348' },
    sources: [
      { id: 'tact', fetchedAt: '2026-10-08T10:17:00.000Z', status: 'ok' },
      { id: 'youtube', fetchedAt: null, status: 'disabled', detail: 'YT_API_KEY not set' },
    ],
    counts: { heroes: 2 },
    ...extra,
  };
}

function fixed(files: OutputFile[], issues: ValidationIssue[] = [], m = meta('hots')): DataPipeline {
  return { run: async () => ({ meta: m, files, issues }) };
}

function opts(pipelines: Partial<Record<GameId, DataPipeline | null>>, extra: Partial<RunOptions> = {}): RunOptions {
  const lines: string[] = [];
  return {
    root,
    out,
    games: Object.keys(pipelines) as GameId[],
    env: {},
    now: new Date('2026-10-08T10:17:00Z'),
    loadPipeline: async (game) => pipelines[game] ?? null,
    httpFor: () => noHttp,
    print: (l) => lines.push(l),
    ...extra,
  };
}

const read = (...p: string[]) => readFileSync(path.join(out, ...p), 'utf8');
const readMeta = (game: GameId) => JSON.parse(read('current', game, 'meta.json')) as GameMeta;
const readStatus = () => JSON.parse(read('status.json')) as StatusFile;

const baseFiles = (): OutputFile[] => [
  { path: 'heroes.json', data: [{ id: 'Abat', name: 'Abathur' }, { id: 'HXAL', name: "Xal'atath" }], custody: 'A' },
  { path: 'pro.json', data: { license: 'CC-BY-SA-3.0', heroes: {} }, custody: 'A-SA' },
  { path: 'public/draft.json', data: { heroes: ['Abat', 'HXAL'] }, custody: 'A' },
  { path: 'img/heroes/abathur.webp', data: null, bytes: new Uint8Array([1, 2, 3]), custody: 'A' },
  { path: 'videos.json', data: { videos: [] }, custody: 'C' },
];

describe('runPipelines: success path', () => {
  it('writes current/private files, meta with dataHash, custody index, history and status', async () => {
    const summary = await runPipelines(opts({ hots: fixed(baseFiles()) }));
    expect(summary.exitCode).toBe(0);

    expect(listFiles(path.join(out, 'current', 'hots'))).toEqual(['_files.json', 'heroes.json', 'img/heroes/abathur.webp', 'meta.json', 'pro.json', 'public/draft.json']);
    expect(listFiles(path.join(out, 'private', 'hots'))).toEqual(['_files.json', 'videos.json']);
    expect(read('current', 'hots', 'heroes.json')).toBe('[\n  {\n    "id": "Abat",\n    "name": "Abathur"\n  },\n  {\n    "id": "HXAL",\n    "name": "Xal\'atath"\n  }\n]\n');
    expect(read('current', 'hots', 'public', 'draft.json')).toBe('{"heroes":["Abat","HXAL"]}\n');

    const m = readMeta('hots');
    expect(m.generatedAt).toBe('2026-10-08T10:17:00.000Z');
    expect(m.dataHash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.keys(m)).toEqual(['counts', 'dataHash', 'game', 'generatedAt', 'schema', 'sources', 'version']);

    const index = JSON.parse(read('current', 'hots', '_files.json')) as FileIndex;
    expect(Object.keys(index.files)).toEqual(['heroes.json', 'pro.json', 'public/draft.json']);
    expect(index.files['pro.json']?.custody).toBe('A-SA');
    expect(index.img).toMatchObject({ files: 1, bytes: 3 });
    expect((JSON.parse(read('private', 'hots', '_files.json')) as FileIndex).files['videos.json']?.custody).toBe('C');

    const history = JSON.parse(gunzipSync(readFileSync(path.join(out, 'history', '2026', '10', '08', 'hots.json.gz'))).toString('utf8'));
    expect(Object.keys(history.files)).toEqual(['heroes.json']);
    expect(Object.keys(history.omitted)).toEqual(['pro.json', 'public/draft.json']);
    expect(history.meta.dataHash).toBe(m.dataHash);
    expect(JSON.stringify(history)).not.toContain('videos');

    const status = readStatus();
    expect(status.games.hots).toMatchObject({ state: 'ok', changed: true, dataHash: m.dataHash, files: { current: 4, private: 1 } });
  });

  it('is deterministic and reports changed=false when only the clock moved', async () => {
    await runPipelines(opts({ hots: fixed(baseFiles()) }));
    const first = readMeta('hots');
    const firstBytes = read('current', 'hots', 'heroes.json');
    const second = await runPipelines(opts({ hots: fixed(baseFiles()) }, { now: new Date('2026-10-09T10:17:00Z') }));
    const m = readMeta('hots');
    expect(m.dataHash).toBe(first.dataHash);
    expect(m.generatedAt).toBe('2026-10-09T10:17:00.000Z');
    expect(read('current', 'hots', 'heroes.json')).toBe(firstBytes);
    expect(second.reports[0]?.status.changed).toBe(false);
    expect(existsSync(path.join(out, 'history', '2026', '10', '09', 'hots.json.gz'))).toBe(true);

    // A source's fetchedAt is a timestamp too and must not affect the hash.
    const later = meta('hots');
    later.sources[0]!.fetchedAt = '2026-10-10T10:17:00.000Z';
    await runPipelines(opts({ hots: fixed(baseFiles(), [], later) }));
    expect(readMeta('hots').dataHash).toBe(first.dataHash);
  });

  it('produces identical bytes in two independent output directories', async () => {
    await runPipelines(opts({ hots: fixed(baseFiles()) }));
    const otherOut = path.join(root, 'data2');
    await runPipelines(opts({ hots: fixed(baseFiles()) }, { out: otherOut }));
    for (const rel of listFiles(path.join(out, 'current', 'hots'))) {
      expect(readFileSync(path.join(otherOut, 'current', 'hots', rel)).equals(readFileSync(path.join(out, 'current', 'hots', rel)))).toBe(true);
    }
    const gz = (base: string) => readFileSync(path.join(base, 'history', '2026', '10', '08', 'hots.json.gz'));
    expect(gz(otherOut).equals(gz(out))).toBe(true);
  });

  it('removes files that disappeared, keeps img/ unless re-emitted, and replaces private/ wholesale', async () => {
    await runPipelines(opts({ hots: fixed(baseFiles()) }));
    const withoutImgAndPro = baseFiles().filter((f) => !f.path.startsWith('img/') && f.path !== 'pro.json' && f.path !== 'videos.json');
    await runPipelines(opts({ hots: fixed(withoutImgAndPro) }));
    expect(listFiles(path.join(out, 'current', 'hots'))).toEqual(['_files.json', 'heroes.json', 'img/heroes/abathur.webp', 'meta.json', 'public/draft.json']);
    expect(existsSync(path.join(out, 'private', 'hots'))).toBe(false);

    const newImg: OutputFile = { path: 'img/heroes/xalatath.webp', data: null, bytes: new Uint8Array([9]), custody: 'A' };
    await runPipelines(opts({ hots: fixed([...withoutImgAndPro, newImg]) }));
    expect(listFiles(path.join(out, 'current', 'hots', 'img'))).toEqual(['heroes/xalatath.webp']);
  });

  it('changes dataHash when re-emitted images change', async () => {
    await runPipelines(opts({ hots: fixed(baseFiles()) }));
    const before = readMeta('hots').dataHash;
    const files = baseFiles().map((f) => (f.path.startsWith('img/') ? { ...f, bytes: new Uint8Array([7, 7]) } : f));
    const r = await runPipelines(opts({ hots: fixed(files) }));
    expect(readMeta('hots').dataHash).not.toBe(before);
    expect(r.reports[0]?.status.changed).toBe(true);
  });
});

describe('runPipelines: failure path', () => {
  it('keeps last-good data on an error issue, marks sources and exits non-zero after other games ran', async () => {
    await runPipelines(opts({ hots: fixed(baseFiles()) }));
    const good = readMeta('hots');
    const heroesBefore = read('current', 'hots', 'heroes.json');

    const broken = fixed(
      [{ path: 'heroes.json', data: [], custody: 'A' }],
      [{ level: 'error', source: 'tact', message: 'heroes.json: hero count dropped to 0' }],
    );
    const mtga = { run: async () => ({ meta: meta('mtga', { version: { label: 'EOE' } }), files: [{ path: 'cards.json', data: [], custody: 'A' as const }], issues: [] }) };
    const summary = await runPipelines(opts({ hots: broken, mtga }, { now: new Date('2026-10-09T10:17:00Z') }));

    expect(summary.exitCode).toBe(1);
    expect(read('current', 'hots', 'heroes.json')).toBe(heroesBefore);
    expect(readMeta('hots')).toEqual(good);
    expect(existsSync(path.join(out, 'private', 'hots', 'videos.json'))).toBe(true);
    expect(existsSync(path.join(out, 'current', 'mtga', 'meta.json'))).toBe(true);

    const status = readStatus();
    expect(status.games.hots).toMatchObject({ state: 'failed', changed: false, dataHash: good.dataHash, generatedAt: good.generatedAt });
    expect(status.games.hots?.sources).toEqual([
      { id: 'tact', fetchedAt: '2026-10-08T10:17:00.000Z', status: 'failed', detail: 'heroes.json: hero count dropped to 0' },
      { id: 'youtube', fetchedAt: null, status: 'disabled', detail: 'YT_API_KEY not set' },
    ]);
    expect(status.games.mtga?.state).toBe('ok');
    expect(githubOutputs(summary.reports)).toEqual(['changed_hots=false', 'changed_mtga=true', 'changed=true', 'failed=hots', 'degraded=']);
    expect(formatSummary(summary.reports)).toMatch(/hots\s+failed\s+no/);
  });

  it('treats a thrown pipeline as failed without touching data', async () => {
    const summary = await runPipelines(opts({ hots: { run: async () => Promise.reject(new Error('boom')) } }));
    expect(summary.exitCode).toBe(1);
    expect(summary.reports[0]?.status.issues[0]?.message).toContain('boom');
    expect(existsSync(path.join(out, 'current', 'hots'))).toBe(false);
  });

  it('treats a pipeline module that fails to load as failed, and a missing one as skipped', async () => {
    const summary = await runPipelines(
      opts({}, {
        games: ['hots', 'pokemon'],
        loadPipeline: async (game) => {
          if (game === 'hots') throw new Error('SyntaxError in index.ts');
          return null;
        },
      }),
    );
    expect(summary.reports.map((r) => r.status.state)).toEqual(['failed', 'skipped']);
    expect(summary.exitCode).toBe(1);
  });
});

describe('checkResult', () => {
  const ok = (files: OutputFile[]): PipelineResult => ({ meta: meta('hots'), files, issues: [] });

  it('rejects unsafe, reserved, duplicate and malformed outputs', () => {
    const r = checkResult('hots', ok([
      { path: '../x.json', data: 1, custody: 'A' },
      { path: 'meta.json', data: 1, custody: 'A' },
      { path: 'a.json', data: 1, custody: 'A' },
      { path: 'a.json', data: 2, custody: 'A' },
      { path: 'b.json', data: 1, custody: 'Z' as never },
      { path: 'c.json', data: undefined, custody: 'A' },
    ]));
    expect(r.files.map((f) => f.path)).toEqual(['a.json']);
    expect(r.issues.filter((i) => i.level === 'error')).toHaveLength(5);
  });

  it('allows one public/*.json path in both current and private (overlay), nothing else', () => {
    const r = checkResult('hots', ok([
      { path: 'public/draft.json', data: { heroes: [] }, custody: 'A' },
      { path: 'public/draft.json', data: { stats: {} }, custody: 'B' },
      { path: 'public/draft.json', data: { more: {} }, custody: 'C' },
      { path: 'stats.json', data: {}, custody: 'A' },
      { path: 'stats.json', data: {}, custody: 'B' },
    ]));
    expect(r.files.map((f) => `${f.custody}:${f.path}`)).toEqual(['A:public/draft.json', 'B:public/draft.json', 'A:stats.json']);
    expect(r.issues.map((i) => i.message)).toEqual(['public/draft.json is emitted more than once', 'stats.json is emitted more than once']);
  });

  it('writes an overlay to both trees with the right custody in each index', async () => {
    const files: OutputFile[] = [...baseFiles(), { path: 'public/draft.json', data: { stats: { games: 1 } }, custody: 'B' }];
    await runPipelines(opts({ hots: fixed(files) }));
    expect(read('private', 'hots', 'public', 'draft.json')).toBe('{"stats":{"games":1}}\n');
    expect((JSON.parse(read('current', 'hots', '_files.json')) as FileIndex).files['public/draft.json']?.custody).toBe('A');
    expect((JSON.parse(read('private', 'hots', '_files.json')) as FileIndex).files['public/draft.json']?.custody).toBe('B');
  });

  it('routes class B like C and D, and refuses class P', () => {
    const files: OutputFile[] = [
      { path: 'stats.json', data: {}, custody: 'B' },
      { path: 'mined.json', data: {}, custody: 'D' },
      { path: 'mine.json', data: {}, custody: 'P' },
    ];
    const r = checkResult('hots', ok(files));
    expect(r.files.map((f) => f.path)).toEqual(['stats.json', 'mined.json']);
    expect(r.issues).toEqual([{ level: 'error', message: 'mine.json: class P (personal) data must never be emitted by a public pipeline' }]);
  });

  it('checks the meta block', () => {
    const r = checkResult('hots', { meta: { ...meta('mtga') }, files: [], issues: [] });
    expect(r.issues[0]?.message).toContain('meta.game');
  });

  it('writes class B to private/ and never to the committed tree', async () => {
    const files: OutputFile[] = [...baseFiles(), { path: 'stats.json', data: { sl: {} }, custody: 'B' }];
    await runPipelines(opts({ hots: fixed(files) }));
    expect(listFiles(path.join(out, 'private', 'hots'))).toEqual(['_files.json', 'stats.json', 'videos.json']);
    expect(existsSync(path.join(out, 'current', 'hots', 'stats.json'))).toBe(false);
  });

  it('reports sources that served last-good data in an ok run as degraded', async () => {
    const m = meta('hots', {
      sources: [
        { id: 'tact', fetchedAt: '2026-10-08T10:17:00.000Z', status: 'ok' },
        { id: 'liquipedia', fetchedAt: '2026-10-06T10:17:00.000Z', status: 'stale', detail: 'HTTP 503; last-good kept' },
        { id: 'youtube', fetchedAt: null, status: 'disabled' },
      ],
    });
    const summary = await runPipelines(opts({ hots: fixed(baseFiles(), [], m) }));
    expect(summary.exitCode).toBe(0);
    expect(readStatus().games.hots).toMatchObject({ state: 'ok', degraded: ['liquipedia'] });
    expect(githubOutputs(summary.reports)).toContain('degraded=hots:liquipedia');
    expect(formatSummary(summary.reports)).toContain('liquipedia');
    expect(degradedSources(m.sources)).toEqual(['liquipedia']);
  });
});

describe('context', () => {
  it('exposes last-good files, previousMeta, secrets and the --only selection', async () => {
    await runPipelines(opts({ hots: fixed(baseFiles()) }));
    interface Seen {
      prev: unknown;
      priv: unknown;
      missing: unknown;
      metaHash: string | undefined;
      secrets: PipelineContext['secrets'];
      tact: boolean;
      hp: boolean;
    }
    const seen: Seen[] = [];
    const probe: DataPipeline = {
      run: async (ctx) => {
        seen.push({
          prev: await ctx.previous('heroes.json'),
          priv: await ctx.previous('videos.json'),
          missing: await ctx.previous('nope.json'),
          metaHash: ctx.previousMeta?.dataHash,
          secrets: ctx.secrets,
          tact: isSelected(ctx, 'tact'),
          hp: isSelected(ctx, 'youtube'),
        });
        return { meta: meta('hots'), files: baseFiles(), issues: [] };
      },
    };
    await runPipelines(opts({ hots: probe }, { only: ['tact'], env: { LIQUIPEDIA_UA_CONTACT: ' ', YT_API_KEY: 'yt', WHETSTONE_SHOWDOWN_EXPORT: 'x.json', DATA_ARTIFACT_KEY: 'k', GITHUB_TOKEN: 't', OTHER: 'x' } }));
    expect(seen).toHaveLength(1);
    const s = seen[0] as Seen;
    expect(s.prev).toEqual([{ id: 'Abat', name: 'Abathur' }, { id: 'HXAL', name: "Xal'atath" }]);
    expect(s.priv).toEqual({ videos: [] });
    expect(s.missing).toBeNull();
    expect(s.metaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.secrets.LIQUIPEDIA_UA_CONTACT).toBeUndefined();
    expect(s.secrets.YT_API_KEY).toBe('yt');
    // Only the variables the game's registry entry lists: never another game's, never the GitHub token.
    expect(Object.keys(s.secrets)).not.toContain('OTHER');
    expect(Object.keys(s.secrets)).not.toContain('WHETSTONE_SHOWDOWN_EXPORT');
    expect(Object.keys(s.secrets)).not.toContain('DATA_ARTIFACT_KEY');
    expect(Object.keys(s.secrets)).not.toContain('GITHUB_TOKEN');
    expect(s.tact).toBe(true);
    expect(s.hp).toBe(false);
  });
});

describe('helpers', () => {
  it('failedSources falls back to last-good statuses', () => {
    const prev = { ...meta('hots'), generatedAt: 'x', dataHash: 'y' } as GameMeta;
    expect(failedSources(prev, null, [{ level: 'error', message: 'threw' }]).map((s) => s.status)).toEqual(['stale', 'disabled']);
    expect(failedSources(null, null, [])).toEqual([]);
  });

  it('loadGamePipeline returns null when the module does not exist', async () => {
    await expect(loadGamePipeline('hots', root)).resolves.toBeNull();
  });
});

describe('secrets', () => {
  it('sends GITHUB_TOKEN as a bearer token for api.github.com only, never to games', () => {
    expect(bearerTokens({ GITHUB_TOKEN: ' ghs_x ', HOME: '/root' })).toEqual({ 'api.github.com': 'ghs_x' });
    expect(bearerTokens({ GITHUB_TOKEN: '' })).toEqual({});
    expect(secretsFromEnv({ GITHUB_TOKEN: 'ghs_x' }, 'mtga')).toEqual({});
  });

  it('scopes variables per game from the registry', () => {
    expect(gameEnvNames('pokemon')).toEqual([]);
    expect(gameEnvNames('mtga')).toEqual([]);
    expect(gameEnvNames('hots')).toContain('YT_API_KEY');
    expect(secretsFromEnv({ YT_API_KEY: 'k', LIQUIPEDIA_UA_CONTACT: 'me' }, 'pokemon')).toEqual({});
    expect(secretsFromEnv({ YT_API_KEY: ' k ', LIQUIPEDIA_UA_CONTACT: '' }, 'hots')).toMatchObject({ YT_API_KEY: 'k', LIQUIPEDIA_UA_CONTACT: undefined });
  });
});
