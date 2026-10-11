/**
 * End-to-end runs of the HotS pipeline through pipeline/run.ts against the recorded fixtures
 * (src/games/hots/fixtures/raw/): the offline first run, determinism, last-good fallbacks when
 * sources go down, and that nothing from a removed source (Heroes Profile) is written.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { createHttp } from '../../../../pipeline/http.ts';
import { runPipelines, type RunSummary } from '../../../../pipeline/run.ts';
import type { Http } from '../../../core/game.ts';
import { HOTS_FILES, HotsMetaSchema, type HotsMeta, type Patch, type Theory } from '../schema.ts';
import { runHots, type HotsPipelineDeps } from './index.ts';
import { FIXTURE_NOW, REPO_ROOT, rawText } from './test-helpers.ts';
import { longestSharedRun, VERBATIM_LIMIT } from './transform/summary.ts';
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
    request: async (url, init) => (guard(url), http.request(url, init)),
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
    expect(m.extra).toMatchObject({ build: '2.57.0.98348', dataBuild: '2.57.0.98348', major: '2.57', builds: ['2.57.0.98348', '2.57.0.98285'], assetsTag: 'v2.57.0.98285' });
    expect(m.extra.dataPending).toBeUndefined();
    expect(m.sources.map((s) => [s.id, s.status])).toEqual([
      ['tact', 'ok'],
      ['heroes-data2', 'ok'],
      ['heroes-images', 'ok'],
      ['blizzard-news', 'ok'],
      // The trimmed roster has none of the heroes in the recorded rotation.
      ['nexus-compendium', 'failed'],
      ['liquipedia', 'ok'],
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

  it('stores patch notes as our own summaries: no text repeats 8 words of a recorded article', () => {
    const articles = ['blizzard-news/article-24303007.txt', 'blizzard-news/article-24306095.txt'].map((f) =>
      rawText(f).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '),
    );
    const patches = read<Patch[]>(out, 'current/hots/patches.json');
    expect(patches.every((p) => p.notes === 'summary')).toBe(true);
    const texts = patches.flatMap((p) => [
      ...p.general,
      ...Object.values(p.maps ?? {}).flat(),
      ...Object.values(p.heroes).flatMap((h) => h.changes.flatMap((c) => [c.text, c.target ?? '', c.stat ?? ''])),
    ]);
    expect(texts.length).toBeGreaterThan(20);
    for (const t of texts) for (const a of articles) expect(longestSharedRun(t, a), t).toBeLessThan(VERBATIM_LIMIT);
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

  it('re-summarises last-good patch notes from before the summaries instead of carrying their sentences forward', async () => {
    const legacyOut = tempOut();
    mkdirSync(path.join(legacyOut, 'current', 'hots'), { recursive: true });
    const legacy = [
      {
        id: '2026-09-28-patch',
        version: '2.57',
        date: '2026-09-28',
        title: 'Heroes of the Storm Live Patch Notes - September 28, 2026',
        url: 'https://news.blizzard.com/en-us/article/24303007/heroes-of-the-storm-live-patch-notes-september-28-2026',
        kind: 'patch',
        contentHash: '0123456789abcdef',
        general: ['Updated Homescreen and Startup Music.'],
        heroes: { Abat: { verdict: 'change', changes: [{ section: 'Level 16', target: 'Survival Instincts', level: '16', text: 'Now provides 50% damage reduction against non-Heroes, instead of +100% Health.', dir: 'change' }] } },
      },
    ];
    writeFileSync(path.join(legacyOut, 'current', 'hots', 'patches.json'), JSON.stringify(legacy));
    const s = await run({ out: legacyOut, down: ['news.blizzard.com'] });
    expect(s.exitCode).toBe(0);
    const patches = read<Patch[]>(legacyOut, 'current/hots/patches.json');
    const p = patches.find((x) => x.date === '2026-09-28' && x.kind === 'patch');
    expect(p?.notes).toBe('summary');
    expect(p?.general).toEqual(['Interface and audio: 1 change']);
    // Our template, with the game-data numbers of that build added back.
    expect(p?.heroes.Abat?.changes[0]).toMatchObject({ target: 'Survival Instincts', kind: 'changed', text: "Effect changed; game data: damage 100% → 50% (see Blizzard's notes)" });
    expect(readFileSync(path.join(legacyOut, 'current/hots/patches.json'), 'utf8')).not.toMatch(/Homescreen|non-Heroes/);
  });

  it('fails the game (keeping nothing half-written) without hero data or last-good', async () => {
    const empty = tempOut();
    const s = await run({ out: empty, down: ['github.com'] });
    expect(s.exitCode).toBe(1);
    expect(s.reports[0]?.status.state).toBe('failed');
    expect(s.reports[0]?.issues.some((i) => i.level === 'error' && i.source === 'heroes-data2')).toBe(true);
  });
});

describe('no Heroes Profile output', () => {
  /** Every file under a directory, relative, with forward slashes. */
  const walk = (dir: string, base = dir): string[] =>
    existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name), base) : [path.relative(base, path.join(dir, e.name)).split(path.sep).join('/')])) : [];

  it('writes no statistics, no private overlay and no Heroes Profile ids, links or switches, even with the old secrets set', async () => {
    const out = tempOut();
    const s = await run({ out, env: { HP_MODE: 'on', HP_API_KEY: 'test-key' } });
    expect(s.exitCode).toBe(0);
    expect(walk(path.join(out, 'private', 'hots'))).toEqual([]);
    const m = meta(out);
    expect(m.sources.map((x) => x.id)).not.toContain('heroesprofile');
    expect('hpMode' in m.extra).toBe(false);
    const maps = read<{ rankedSource: string }[]>(out, 'current/hots/maps.json');
    expect(maps.every((x) => x.rankedSource === 'curated' && !('hp' in x))).toBe(true);
    for (const file of walk(path.join(out, 'current', 'hots')).filter((f) => f.endsWith('.json'))) {
      expect(readFileSync(path.join(out, 'current', 'hots', file), 'utf8'), file).not.toMatch(/heroes ?profile|hpMode/i);
    }
  });
});
