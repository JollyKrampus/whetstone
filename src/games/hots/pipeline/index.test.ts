/**
 * End-to-end runs of the HotS pipeline through pipeline/run.ts against the recorded fixtures
 * (src/games/hots/fixtures/raw/): the offline first run, determinism, last-good fallbacks when
 * sources go down, and the gated Heroes Profile path with a synthetic transport.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createHttp } from '../../../../pipeline/http.ts';
import { runPipelines, type RunSummary } from '../../../../pipeline/run.ts';
import type { Http } from '../../../core/game.ts';
import { HOTS_FILES, HOTS_PRIVATE_OVERLAYS, HotsMetaSchema, type HotsMeta, type Theory } from '../schema.ts';
import { runHots, type HotsPipelineDeps } from './index.ts';
import type { HpTransport } from './sources/heroesprofile.ts';
import { FIXTURE_NOW, REPO_ROOT } from './test-helpers.ts';
import type { TheoryModule } from './theoryHook.ts';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function tempOut(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'whetstone-hots-'));
  dirs.push(d);
  return d;
}

/** A tiny theory module so these runs do not depend on the real engine being present. */
const theoryStub = async (): Promise<TheoryModule> => ({
  RULES_VERSION: 'stub',
  extractMechanics: (h) => (h.abilities.length > 0 ? [{ tag: 'poke', evidence: [{ kind: 'ability', name: h.abilities[0]?.name ?? 'x', snippet: 'x' }] }] : []),
  loadCurated: () => ({}),
  applyCuratedTraits: (heroes) => heroes,
  buildTheory: ({ heroes }): Theory => ({
    rulesVersion: 'stub',
    counters: heroes.slice(1).map((h) => ({ a: heroes[0]?.id ?? '', b: h.id, score: 55, source: 'theory', reasons: [{ kind: 'theory', text: 'Stub reason' }] })),
    synergies: [],
    mapFit: [],
  }),
});

interface RunOpts {
  out: string;
  now?: Date;
  env?: Record<string, string>;
  /** Hosts whose requests fail as if the source were down. */
  down?: readonly string[];
  deps?: HotsPipelineDeps;
}

function failingHosts(http: Http, down: readonly string[]): Http {
  const guard = (url: string): void => {
    if (down.includes(new URL(url).host)) throw new Error(`${new URL(url).host} is down (test)`);
  };
  return {
    json: async (url, init) => (guard(url), http.json(url, init)),
    text: async (url, init) => (guard(url), http.text(url, init)),
    bytes: async (url, init) => (guard(url), http.bytes(url, init)),
    head: async (url, init) => (guard(url), http.head(url, init)),
  };
}

function run(o: RunOpts): Promise<RunSummary> {
  return runPipelines({
    root: REPO_ROOT,
    out: o.out,
    games: ['hots'],
    offline: true,
    env: o.env ?? {},
    now: o.now ?? FIXTURE_NOW,
    history: { enabled: false, maxBytes: 0 },
    loadPipeline: async () => ({ run: (ctx) => runHots(ctx, { theory: theoryStub, ...o.deps }) }),
    httpFor: (game) => failingHosts(createHttp({ game, root: REPO_ROOT, offline: true }), o.down ?? []),
    print: () => {},
  });
}

const read = <T = unknown>(out: string, rel: string): T => JSON.parse(readFileSync(path.join(out, rel), 'utf8')) as T;
const meta = (out: string): HotsMeta => HotsMetaSchema.parse(read(out, 'current/hots/meta.json'));
const status = (m: HotsMeta, id: string) => m.sources.find((s) => s.id === id);

describe('offline run on recorded fixtures', () => {
  const out = tempOut();
  let summary: RunSummary;

  it('succeeds and writes every class-A file', async () => {
    summary = await run({ out });
    const report = summary.reports[0];
    expect(report?.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(summary.exitCode).toBe(0);
    const index = read<{ files: Record<string, { custody: string }>; img?: { files: number } }>(out, 'current/hots/_files.json');
    expect(Object.keys(index.files).sort()).toEqual(['diffs.json', 'heroes.json', 'links.json', 'maps.json', 'patches.json', 'pro.json', 'public/draft.json', 'theory.json']);
    expect(index.files['pro.json']?.custody).toBe('A-SA');
    expect(index.img?.files).toBeGreaterThan(50);
  });

  it('writes files that match their schemas', () => {
    for (const [file, spec] of Object.entries(HOTS_FILES)) {
      if (spec.custody === 'B' || spec.custody === 'C' || file === 'meta.json' || file === 'rotation.json') continue;
      const r = spec.schema.safeParse(read(out, `current/hots/${file}`));
      expect(r.success, `${file}: ${r.success ? '' : JSON.stringify(r.error.issues[0])}`).toBe(true);
    }
  });

  it('records builds, the major and per-source statuses in meta.json', () => {
    const m = meta(out);
    expect(m.version).toEqual({ label: '2.57', build: '2.57.0.98348', since: '2026-09-28' });
    expect(m.extra).toMatchObject({ build: '2.57.0.98348', dataBuild: '2.57.0.98348', major: '2.57', builds: ['2.57.0.98348', '2.57.0.98285'], assetsTag: 'v2.57.0.98285', hpMode: 'off' });
    expect(m.extra.dataPending).toBeUndefined();
    expect(m.sources.map((s) => [s.id, s.status])).toEqual([
      ['tact', 'ok'],
      ['heroes-data2', 'ok'],
      ['heroes-images', 'ok'],
      ['blizzard-news', 'ok'],
      // The trimmed roster has none of the heroes in the recorded rotation.
      ['nexus-compendium', 'failed'],
      ['liquipedia', 'ok'],
      ['heroesprofile', 'disabled'],
      ['youtube', 'disabled'],
      ['twitch', 'disabled'],
    ]);
    expect(m.counts).toMatchObject({ heroes: 5, maps: 19, patches: 4 });
  });

  it('builds heroes with the composite, patches matched to builds and catch-up diffs', () => {
    const heroes = read<{ id: string; memberOf?: string; mechanics: unknown[]; lastChangedBuild?: string }[]>(out, 'current/hots/heroes.json');
    expect(heroes.map((h) => h.id)).toEqual(['Abat', 'Alex', 'CCho', 'chogall', 'Gall', 'HXAL']);
    expect(heroes.find((h) => h.id === 'HXAL')?.lastChangedBuild).toBe('2.57.0.98348');
    const patches = read<{ id: string; build?: string }[]>(out, 'current/hots/patches.json');
    expect(patches.map((p) => [p.id, p.build ?? null])).toEqual([
      ['2026-10-05-hotfix', '2.57.0.98348'],
      ['2026-09-29-hotfix', null],
      ['2026-09-28-patch', '2.57.0.98285'],
      ['2026-09-14-ptr', '2.57.0.98126_ptr'],
    ]);
    const diffs = read<{ id: string; date?: string }[]>(out, 'current/hots/diffs.json');
    expect(diffs.map((d) => [d.id, d.date])).toEqual([
      ['2.57.0.98285..2.57.0.98348', '2026-10-05'],
      ['2.55.17.98025..2.57.0.98285', '2026-09-28'],
    ]);
    const shard = read<{ heroes: { id: string[] } }>(out, 'current/hots/public/draft.json');
    // Release-date order: Abathur 2014, Cho'gall 2015, Alexstrasza 2017, Xal'atath 2026.
    expect(shard.heroes.id).toEqual(['Abat', 'chogall', 'Alex', 'HXAL']);
  });

  it('is deterministic: the same inputs give the same dataHash', async () => {
    const again = tempOut();
    await run({ out: again });
    expect(meta(again).dataHash).toBe(meta(out).dataHash);
  });

  it('reports no change on a second run with the same upstream data (incremental paths)', async () => {
    const before = meta(out).dataHash;
    const s = await run({ out, now: new Date(FIXTURE_NOW.getTime() + 3600 * 1000) });
    expect(s.reports[0]?.status.changed).toBe(false);
    expect(meta(out).dataHash).toBe(before);
  });

  it('keeps last-good files with stale statuses when sources go down', async () => {
    const before = meta(out);
    const patches = readFileSync(path.join(out, 'current/hots/patches.json'), 'utf8');
    const pro = readFileSync(path.join(out, 'current/hots/pro.json'), 'utf8');
    const later = new Date(FIXTURE_NOW.getTime() + 24 * 3600 * 1000);
    const s = await run({ out, now: later, down: ['news.blizzard.com', 'liquipedia.net', 'us.version.battle.net', 'api.github.com', 'cdn.jsdelivr.net'] });
    expect(s.exitCode).toBe(0);
    const m = meta(out);
    for (const id of ['blizzard-news', 'liquipedia', 'tact']) {
      expect(status(m, id)).toMatchObject({ status: 'stale', fetchedAt: status(before, id)?.fetchedAt });
      expect(s.reports[0]?.issues.some((i) => i.level === 'warn' && i.source === id)).toBe(true);
    }
    expect(m.extra.build).toBe('2.57.0.98348');
    expect(readFileSync(path.join(out, 'current/hots/patches.json'), 'utf8')).toBe(patches);
    expect(readFileSync(path.join(out, 'current/hots/pro.json'), 'utf8')).toBe(pro);
    // Image tags unavailable: the existing img/ tree is kept.
    expect(status(m, 'heroes-images')?.status).toBe('stale');
    expect(read<{ img?: { files: number } }>(out, 'current/hots/_files.json').img?.files).toBeGreaterThan(50);
  });

  it('falls back to last-good hero data when heroes-data2 is down', async () => {
    const heroes = readFileSync(path.join(out, 'current/hots/heroes.json'), 'utf8');
    const s = await run({ out, down: ['github.com', 'raw.githubusercontent.com'] });
    expect(s.exitCode).toBe(0);
    expect(status(meta(out), 'heroes-data2')?.status).toBe('stale');
    expect(readFileSync(path.join(out, 'current/hots/heroes.json'), 'utf8')).toBe(heroes);
  });

  it('fails the game (keeping nothing half-written) without hero data or last-good', async () => {
    const empty = tempOut();
    const s = await run({ out: empty, down: ['github.com'] });
    expect(s.exitCode).toBe(1);
    expect(s.reports[0]?.status.state).toBe('failed');
    expect(s.reports[0]?.issues.some((i) => i.level === 'error' && i.source === 'heroes-data2')).toBe(true);
  });
});

describe('gated Heroes Profile path (synthetic transport)', () => {
  /** Synthetic numbers in a plausible response shape; never real HP data. */
  const transport: HpTransport = async (url) => {
    const u = new URL(url);
    const names = ['Abathur', 'Alexstrasza', 'Cho', 'Gall', "Xal'atath"];
    let body: unknown;
    if (u.pathname.endsWith('/heroes/stats')) {
      body = u.searchParams.has('group_by_map')
        ? names.flatMap((n) => [
            { hero: n, map: 'Cursed Hollow', games: 400, wins: 200 },
            { hero: n, map: 'Sky Temple', games: 2, wins: 1 },
          ])
        : names.map((n, i) => ({ hero: n, games: 1000, wins: 480 + 10 * i, bans: 50 }));
    } else if (u.pathname.endsWith('/builds/all')) {
      body = [{ hero: "Xal'atath", talents: ['XalatathTalentA'], games: 300, wins: 160 }];
    } else {
      const hero = u.searchParams.get('hero') ?? '';
      body = { ally: names.filter((n) => n !== hero).map((n) => ({ name: n, games: 100, wins: 52 })), enemy: names.filter((n) => n !== hero).map((n) => ({ name: n, games: 120, wins: 60 })) };
    }
    return { status: 200, headers: {}, body: JSON.stringify(body) };
  };

  it('writes stats.json and the draft overlay as class B, and ranks maps from game shares', async () => {
    const out = tempOut();
    const s = await run({ out, env: { HP_MODE: 'on', HP_API_KEY: 'test-key' }, deps: { heroesprofile: { transport, sleep: async () => {} } } });
    expect(s.exitCode).toBe(0);
    const m = meta(out);
    expect(status(m, 'heroesprofile')?.status).toBe('ok');
    expect(m.extra.hpMode).toBe('on');
    const stats = read(out, 'private/hots/stats.json');
    expect(HOTS_FILES['stats.json'].schema.safeParse(stats).success).toBe(true);
    expect(HOTS_PRIVATE_OVERLAYS['public/draft.json'].schema.safeParse(read(out, 'private/hots/public/draft.json')).success).toBe(true);
    const maps = read<{ id: string; ranked: boolean; rankedSource: string }[]>(out, 'current/hots/maps.json');
    expect(maps.find((x) => x.id === 'cursed-hollow')).toMatchObject({ ranked: true, rankedSource: 'stats' });
    expect(maps.find((x) => x.id === 'sky-temple')).toMatchObject({ ranked: false, rankedSource: 'stats' });
    // Class B never lands in current/ (the public, committed tree).
    expect(Object.keys(read<{ files: object }>(out, 'current/hots/_files.json').files)).not.toContain('stats.json');
  });

  it('drops class-B output when HP_MODE is off even if a key is present', async () => {
    const out = tempOut();
    await run({ out, env: { HP_API_KEY: 'test-key' }, deps: { heroesprofile: { transport } } });
    expect(status(meta(out), 'heroesprofile')).toMatchObject({ status: 'disabled', detail: 'HP_MODE=off' });
  });
});
