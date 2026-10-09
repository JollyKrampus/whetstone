import { describe, expect, it } from 'vitest';
import { UsageIndexSchema, UsageSchema, type Species, type Usage, type UsageIndex } from '../../schema.ts';
import { dexIndex } from '../ids.ts';
import { regulationPlan } from '../regulations.ts';
import { fakeContext, fakeHttp, WITH_NEXT, type Route } from '../test-support.ts';
import { CHAOS_TIMEOUT_MS, chooseTargets, describeUsage, parseChaosListing, parseMonths, runSmogonSource, STATS_ROOT, type UsageDeps } from './source.ts';

const NOW = new Date('2026-10-08T12:00:00Z');
const plan = regulationPlan(WITH_NEXT, NOW);
const MC = ['gen9championsvgc2026regmc', 'gen9championsvgc2026regmcbo3', 'gen9championsbssregmc'];
const species: Species[] = ['rillaboom', 'incineroar'].map((id, i) => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  num: i + 1,
  types: ['Normal'],
  base: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 },
  abilities: ['x'],
  weightkg: 1,
  legal: ['M-C'],
}));
const deps: UsageDeps = { dex: dexIndex(species, []), moves: new Set(['fakeout']), items: new Set(['sitrusberry']), abilities: new Set(['grassysurge']) };

const index = (months: string[]): string => `<html><body><pre><a href="../">../</a>\n${months.map((m) => `<a href="${m}/">${m}/</a>   01-Oct-2026 14:40   -`).join('\n')}</pre></body></html>`;
const listing = (files: string[]): string => files.map((f) => `<a href="${f}">${f}</a>  01-Oct-2026 14:40  16234567`).join('\n');
const chaos = (format: string, cutoff: number, battles = 1000) => ({
  info: { metagame: format, cutoff, 'number of battles': battles },
  data: {
    Rillaboom: {
      usage: 0.46,
      'Raw count': 900,
      Abilities: { grassysurge: 10 },
      Items: { sitrusberry: 5 },
      Moves: { fakeout: 10 },
      Spreads: { 'Adamant:32/32/0/0/2/0': 10 },
      Teammates: { Incineroar: 4 },
      'Checks and Counters': {},
    },
    Incineroar: { usage: 0.3, 'Raw count': 600, Abilities: { intimidate: 1 }, Items: {}, Moves: {}, Spreads: {}, Teammates: {}, 'Checks and Counters': {} },
  },
});
const allFiles = (formats: string[]): string[] => formats.flatMap((f) => [0, 1500, 1630, 1760].map((c) => `${f}-${c}.json`));

function routes(month: string, formats = MC, extra: Record<string, Route> = {}): Record<string, Route> {
  const r: Record<string, Route> = {
    [STATS_ROOT]: index(['2026-08', month]),
    [`${STATS_ROOT}${month}/chaos/`]: listing([...allFiles(formats), 'gen9championsou-1500.json']),
  };
  for (const f of formats) for (const c of [0, 1500, 1760]) r[`${STATS_ROOT}${month}/chaos/${f}-${c}.json`] = chaos(f, c);
  return { ...r, ...extra };
}

/** Last-good files as ctx.previous would read them. */
function asPrevious(files: { path: string; data: unknown }[]): Record<string, unknown> {
  return Object.fromEntries(files.map((f) => [f.path, f.data]));
}

describe('stats index parsing', () => {
  it('lists months and chaos files', () => {
    expect(parseMonths(index(['2026-09', '2014-11', '2026-08']))).toEqual(['2014-11', '2026-08', '2026-09']);
    expect([...parseChaosListing(listing(['gen9championsvgc2026regmc-1760.json', 'gen9ou-0.json']))]).toEqual(['gen9championsvgc2026regmc-1760.json', 'gen9ou-0.json']);
  });

  it('targets doubles first at the highest cutoff, then Bo3 and singles, skipping 1630', () => {
    const targets = chooseTargets(plan, new Set(allFiles(MC)));
    expect(targets.map((t) => `${t.format}-${t.cutoff}`)).toEqual([
      'gen9championsvgc2026regmc-1760',
      'gen9championsvgc2026regmc-1500',
      'gen9championsvgc2026regmc-0',
      'gen9championsvgc2026regmcbo3-1760',
      'gen9championsvgc2026regmcbo3-1500',
      'gen9championsvgc2026regmcbo3-0',
      'gen9championsbssregmc-1760',
      'gen9championsbssregmc-1500',
      'gen9championsbssregmc-0',
    ]);
    expect(targets.every((t) => t.regulation === 'M-C')).toBe(true);
  });

  it('falls back to the previous regulation while the new one has no month yet', () => {
    const after = regulationPlan(WITH_NEXT, new Date('2026-12-05T00:00:00Z'));
    expect(chooseTargets(after, new Set(allFiles(MC)))[0]).toEqual({ regulation: 'M-C', format: 'gen9championsvgc2026regmc', cutoff: 1760 });
    expect(chooseTargets(after, new Set(['gen9championsvgc2027regmd-0.json', ...allFiles(MC)]))[0]).toEqual({ regulation: 'M-D', format: 'gen9championsvgc2027regmd', cutoff: 0 });
    expect(chooseTargets(after, new Set(['gen9ou-0.json']))).toEqual([]);
  });
});

describe('runSmogonSource', () => {
  it('fetches the newest month into valid usage files and an index', async () => {
    const http = fakeHttp(routes('2026-09'));
    const r = await runSmogonSource(fakeContext({ http, now: NOW }), plan, deps, true);
    expect(r.status).toMatchObject({ id: 'smogon', status: 'ok' });
    expect(r.status.detail).toBe('September 2026, M-C: 9 files (gen9championsbssregmc, gen9championsvgc2026regmc, gen9championsvgc2026regmcbo3; cutoffs 0/1500/1760)');
    expect(r.month).toBe('2026-09');
    expect(r.regulation).toBe('M-C');
    expect(r.counts).toEqual({ usageFiles: 9 });
    expect(r.issues).toEqual([]);
    const idx = r.files.find((f) => f.path === 'usage/index.json')?.data as UsageIndex;
    expect(UsageIndexSchema.safeParse(idx).success).toBe(true);
    expect(idx.map((e) => e.file)).toContain('usage/gen9championsvgc2026regmc-1760.json');
    for (const f of r.files.filter((x) => x.path !== 'usage/index.json')) expect(UsageSchema.safeParse(f.data).success).toBe(true);
    expect(http.inits.filter((i) => i?.timeoutMs === CHAOS_TIMEOUT_MS)).toHaveLength(9);
  });

  it('re-emits an unchanged month without downloading it again, with the same detail', async () => {
    const first = await runSmogonSource(fakeContext({ http: fakeHttp(routes('2026-09')), now: NOW }), plan, deps, true);
    const http = fakeHttp(routes('2026-09'));
    const again = await runSmogonSource(fakeContext({ http, now: NOW, previous: asPrevious(first.files) }), plan, deps, true);
    expect(http.calls.filter((c) => c.endsWith('.json'))).toEqual([]);
    expect(again.files).toEqual(first.files);
    expect(again.status.detail).toBe(first.status.detail);
  });

  it('detects the month rollover and fetches progressively within the budget', async () => {
    const september = await runSmogonSource(fakeContext({ http: fakeHttp(routes('2026-09')), now: NOW }), plan, deps, true);
    let t = 0;
    // Every download "takes" 7 minutes: a 20-minute budget starts three of them.
    const clock = (): number => t;
    const slow: Record<string, Route> = {};
    for (const f of MC) for (const c of [0, 1500, 1760]) slow[`${STATS_ROOT}2026-10/chaos/${f}-${c}.json`] = () => ((t += 7 * 60_000), chaos(f, c, 2000));
    const http = fakeHttp(routes('2026-10', MC, slow));
    const r = await runSmogonSource(fakeContext({ http, now: new Date('2026-11-02T12:00:00Z'), previous: asPrevious(september.files) }), plan, deps, true, { clock });
    const months = Object.fromEntries((r.usage as Usage[]).map((u) => [`${u.format}-${u.cutoff}`, u.month]));
    expect(months['gen9championsvgc2026regmc-1760']).toBe('2026-10');
    expect(months['gen9championsvgc2026regmc-1500']).toBe('2026-10');
    expect(months['gen9championsvgc2026regmc-0']).toBe('2026-10');
    expect(months['gen9championsbssregmc-0']).toBe('2026-09');
    expect(r.usage).toHaveLength(9);
    expect(r.month).toBe('2026-10');
    expect(r.issues[0]).toMatchObject({ level: 'warn', message: expect.stringMatching(/6 file\(s\) not fetched yet.*budget/) });
    expect(r.status.detail).toMatch(/^October 2026, M-C: 3 files .*; September 2026, M-C: 6 files/);

    // The next run picks up where this one stopped.
    const next = fakeHttp(routes('2026-10'));
    const done = await runSmogonSource(fakeContext({ http: next, now: new Date('2026-11-03T12:00:00Z'), previous: asPrevious(r.files) }), plan, deps, true);
    expect(next.calls.filter((c) => c.endsWith('.json'))).toHaveLength(6);
    expect(done.usage.every((u) => u.month === '2026-10')).toBe(true);
    expect(done.issues).toEqual([]);
  });

  it('uses the previous regulation while a new one warms up', async () => {
    const after = regulationPlan(WITH_NEXT, new Date('2026-12-05T00:00:00Z'));
    const r = await runSmogonSource(fakeContext({ http: fakeHttp(routes('2026-11')), now: new Date('2026-12-05T00:00:00Z') }), after, deps, true);
    expect(r.status.status).toBe('ok');
    expect(r.regulation).toBe('M-C');
  });

  it('keeps last-good usage when Smogon is down, goes backwards or one file is broken', async () => {
    const september = await runSmogonSource(fakeContext({ http: fakeHttp(routes('2026-09')), now: NOW }), plan, deps, true);
    const previous = asPrevious(september.files);
    const previousMeta = {
      game: 'pokemon' as const,
      schema: 1,
      version: { label: 'Reg M-C' },
      generatedAt: '2026-10-07T10:30:00Z',
      dataHash: 'abcdef0123456789',
      sources: [{ id: 'smogon', fetchedAt: '2026-10-07T10:20:00Z', status: 'ok' as const }],
      counts: {},
    };

    const down = await runSmogonSource(fakeContext({ http: fakeHttp({ [STATS_ROOT]: new Error('GET -> 503') }), now: NOW, previous, previousMeta }), plan, deps, true);
    expect(down.status).toMatchObject({ status: 'failed', fetchedAt: '2026-10-07T10:20:00Z' });
    expect(down.files).toEqual(september.files);
    expect(down.month).toBe('2026-09');

    const backwards = await runSmogonSource(fakeContext({ http: fakeHttp(routes('2026-08')), now: NOW, previous }), plan, deps, true);
    expect(backwards.status).toMatchObject({ status: 'failed', detail: expect.stringMatching(/older than the last-good/) });

    const broken = await runSmogonSource(
      fakeContext({ http: fakeHttp(routes('2026-10', MC, { [`${STATS_ROOT}2026-10/chaos/gen9championsbssregmc-0.json`]: { info: { metagame: 'gen9ou' } } })), now: NOW, previous }),
      plan,
      deps,
      true,
    );
    expect(broken.status.status).toBe('ok');
    expect(broken.usage.find((u) => u.format === 'gen9championsbssregmc' && u.cutoff === 0)?.month).toBe('2026-09');
    expect(broken.issues[0]?.message).toMatch(/1 file\(s\) not fetched yet.*errors/);

    const nothing = await runSmogonSource(fakeContext({ http: fakeHttp(routes('2026-09', [])), now: NOW }), plan, deps, true);
    expect(nothing.status).toMatchObject({ status: 'failed', fetchedAt: null });
    expect(nothing.issues.every((i) => i.level === 'warn')).toBe(true);
  });

  it('describes data, not runs', () => {
    expect(describeUsage([])).toBe('no usage files');
  });
});
