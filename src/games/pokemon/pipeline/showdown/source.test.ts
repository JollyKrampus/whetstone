import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameMeta, OutputFile } from '../../../../core/game.ts';
import type { DexShard, Species } from '../../schema.ts';
import { regulationPlan } from '../regulations.ts';
import { SPRITE_SOURCE } from '../sprites.ts';
import { fakeContext, fakeHttp, recordedDex, ROOT, WITH_NEXT } from '../test-support.ts';
import { loadShowdownPin, type ShowdownPin } from './pin.ts';
import type { RawDexExport } from './raw.ts';
import { DEX_FILES, describeDex, dexKey, dexOutputs, dexRequest, readRecordedExport, runDexSource, type DexSourceOptions } from './source.ts';

const SHA = '7332b60e22b9e8194bb53549549eba241d73cc9a';
const NEXT_SHA = '8888888888888888888888888888888888888888';
const NOW = new Date('2026-10-09T01:15:00Z');
const regs = { regulations: WITH_NEXT.regulations.slice(0, 2) };
const plan = regulationPlan(regs, NOW);
const COMMIT = 'https://api.github.com/repos/smogon/pokemon-showdown/commits/master';
const recorded = readRecordedExport(ROOT);

const exporter = (raw: RawDexExport = recorded): NonNullable<DexSourceOptions['exporter']> => async (_ctx, sha) => ({ ...structuredClone(raw), sha });
const pinAt = (sha: string): ShowdownPin => ({ sha, reviewedOn: '2026-10-10' });
const opts = (raw?: RawDexExport, sha?: string): DexSourceOptions => ({ exporter: exporter(raw), minSpecies: 50, ...(sha ? { pin: pinAt(sha) } : {}) });

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'ws-sd-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** Write an export file as the isolated job would. */
function exportFile(raw: RawDexExport = recorded): string {
  const file = path.join(tmp, 'export.json');
  writeFileSync(file, JSON.stringify(raw));
  return file;
}

function meta(extra: Record<string, unknown>, counts: Record<string, number> = {}): GameMeta {
  return {
    game: 'pokemon',
    schema: 1,
    version: { label: 'Reg M-C' },
    generatedAt: '2026-10-08T10:30:00Z',
    dataHash: 'abcdef0123456789',
    sources: [{ id: 'showdown', fetchedAt: '2026-10-08T10:20:00Z', status: 'ok' }],
    counts,
    extra,
  };
}

/** A last-good tree holding the recorded dex. */
function lastGood(): Record<string, unknown> {
  return Object.fromEntries(dexOutputs(recordedDex(), 'M-C').map((f) => [f.path, f.data]));
}

const paths = (files: OutputFile[]): string[] => files.map((f) => f.path).filter((p) => !p.startsWith('img/'));

describe('runDexSource', () => {
  it('replays the recorded export offline', async () => {
    const r = await runDexSource(fakeContext({ offline: true, now: NOW }), regs, plan, true);
    expect(r.status).toMatchObject({ id: 'showdown', status: 'ok' });
    expect(r.status.detail).toMatch(/^recorded export of 7332b60, data for M-C; M-B: \d+ species \+ \d+ Megas; M-C: \d+ species \+ \d+ Megas; 0\/\d+ sprites$/);
    expect(paths(r.files)).toEqual(Object.values(DEX_FILES));
    expect(r.files.some((f) => f.path.startsWith('img/'))).toBe(false);
    expect(r.regulation).toBe('M-C');
    expect(r.sha).toBe(SHA);
    expect(r.dexKey).toBe(dexKey(SHA, dexRequest(regs, plan)));
    expect(r.calc).toMatchObject({ id: 'smogon-calc', status: 'ok', detail: expect.stringMatching(/@smogon\/calc 0\.12\.\d+ \(Champions = generation 0\): \d+ species match the dex/) });
    expect(r.counts?.legalSpecies).toBeGreaterThan(50);
    expect((r.files.find((f) => f.path === DEX_FILES.shard)?.data as DexShard).regulation).toBe('M-C');
    expect(r.issues).toEqual([]);
  });

  it('exports a new commit and self-hosts sprites for the new roster', async () => {
    const png = new Uint8Array(await sharp({ create: { width: 2, height: 2, channels: 4, background: '#c33' } }).png().toBuffer());
    const http = fakeHttp({ [COMMIT]: SHA, [`${SPRITE_SOURCE}garchomp-megaz.png`]: png, [SPRITE_SOURCE]: new Error('GET -> 404') });
    const r = await runDexSource(fakeContext({ http, now: NOW }), regs, plan, true, opts());
    expect(r.status.status).toBe('ok');
    expect(r.files.filter((f) => f.path.startsWith('img/')).map((f) => f.path)).toEqual(['img/sprites/garchompmegaz.webp']);
    const species = r.files.find((f) => f.path === DEX_FILES.species)?.data as Species[];
    expect(species.find((s) => s.id === 'garchompmegaz')?.sprite).toBe('img/sprites/garchompmegaz.webp');
    expect(species.find((s) => s.id === 'garchomp')?.sprite).toBeUndefined();
    expect(r.issues).toEqual([expect.objectContaining({ level: 'warn', source: 'showdown', message: expect.stringMatching(/^no sprite for /) })]);
  });

  it('builds from the commit pinned in curated/pokemon/showdown.json, not master', () => {
    expect(loadShowdownPin(ROOT)).toMatchObject({ sha: SHA, reviewedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it('re-emits the last-good dex without any network access when the pin is unchanged', async () => {
    const key = dexKey(SHA, dexRequest(regs, plan));
    const http = fakeHttp({ [COMMIT]: NEXT_SHA });
    let built = false;
    const r = await runDexSource(fakeContext({ http, now: NOW, previous: lastGood(), previousMeta: meta({ dexKey: key, showdownSha: SHA, regulation: 'M-C' }) }), regs, plan, true, {
      exporter: async () => {
        built = true;
        return recorded;
      },
    });
    expect(built).toBe(false);
    // Master moving on changes nothing: it is not even asked.
    expect(http.calls).toEqual([]);
    expect(r.status).toMatchObject({ status: 'ok', detail: describeDex(recordedDex(), { sha: SHA, regulation: 'M-C', regulations: ['M-B', 'M-C'] }) });
    expect(r.dexKey).toBe(key);
    expect(paths(r.files)).toEqual(Object.values(DEX_FILES));
  });

  it('rejects an export that disagrees with @smogon/calc and keeps the last-good dex', async () => {
    const wrong: RawDexExport = structuredClone(recorded);
    const chomp = wrong.species.find((s) => s.id === 'garchomp')!;
    chomp.baseStats = { ...chomp.baseStats, spe: 120 };
    const http = fakeHttp({});
    const ctx = fakeContext({ http, now: NOW, previous: lastGood(), previousMeta: meta({ dexKey: '0000000000000000', showdownSha: SHA }) });
    const r = await runDexSource(ctx, regs, plan, true, opts(wrong, NEXT_SHA));
    expect(r.status).toMatchObject({ status: 'failed', fetchedAt: '2026-10-08T10:20:00Z', detail: expect.stringMatching(/rejected the export of 8888888: differs from @smogon\/calc: garchomp: spe 120 vs calc 102/) });
    expect(r.issues).toEqual([expect.objectContaining({ level: 'warn', message: expect.stringMatching(/last-good dex kept/) })]);
    expect(paths(r.files)).toEqual(Object.values(DEX_FILES));
    expect((r.files.find((f) => f.path === DEX_FILES.species)?.data as Species[]).find((s) => s.id === 'garchomp')?.base.spe).toBe(102);
    expect(r.calc.detail).toMatch(/1 disagree with the dex/);
    // The kept key is the old one, so the next run retries the export.
    expect(r.dexKey).toBe('0000000000000000');

    const first = await runDexSource(fakeContext({ http, now: NOW }), regs, plan, true, opts(wrong, NEXT_SHA));
    expect(first.issues).toEqual([expect.objectContaining({ level: 'error', source: 'showdown' })]);
    expect(first.files).toEqual([]);
    expect(first.dex).toBeNull();
  });

  it('rejects a truncated roster within the same regulation', async () => {
    const http = fakeHttp({ [COMMIT]: NEXT_SHA });
    const ctx = fakeContext({ http, now: NOW, previous: lastGood(), previousMeta: meta({ regulation: 'M-C' }, { species: 1000 }) });
    const r = await runDexSource(ctx, regs, plan, true, opts());
    expect(r.status.status).toBe('failed');
    expect(r.status.detail).toMatch(/species: dropped from 1000/);
  });

  it('keeps the last-good dex when the export fails, and errors on a first run', async () => {
    const http = fakeHttp({});
    const failing: DexSourceOptions = {
      pin: pinAt(NEXT_SHA),
      exporter: async () => {
        throw new Error('GET https://codeload.github.com/… -> 503');
      },
    };
    const kept = await runDexSource(fakeContext({ http, now: NOW, previous: lastGood(), previousMeta: meta({ showdownSha: SHA, regulation: 'M-C' }) }), regs, plan, true, failing);
    expect(kept.status).toMatchObject({ status: 'failed', detail: expect.stringMatching(/dex export failed: .*503/) });
    expect(kept.sha).toBe(SHA);
    expect(kept.dex?.species.length).toBe(recordedDex().species.length);
    expect(kept.issues.every((i) => i.level === 'warn')).toBe(true);

    const first = await runDexSource(fakeContext({ http, now: NOW }), regs, plan, true, failing);
    expect(first.issues).toEqual([expect.objectContaining({ level: 'error' })]);
    expect(first.status).toMatchObject({ status: 'failed', fetchedAt: null });
  });

  it("uses the isolated export job's file after validating it against the pin", async () => {
    const http = fakeHttp({ [SPRITE_SOURCE]: new Error('GET -> 404') });
    const r = await runDexSource(fakeContext({ http, now: NOW }), regs, plan, true, { exportFile: exportFile(), allowLocalBuild: false, minSpecies: 50 });
    expect(r.status.status).toBe('ok');
    expect(r.sha).toBe(SHA);
    expect(r.dexKey).toBe(dexKey(SHA, dexRequest(regs, plan)));
    expect(paths(r.files)).toEqual(Object.values(DEX_FILES));
    expect(http.calls.every((c) => c.includes(SPRITE_SOURCE))).toBe(true);
  });

  it('rejects an export file of another commit, for other regulations or of the wrong shape', async () => {
    const run = (file: string) =>
      runDexSource(fakeContext({ http: fakeHttp({}), now: NOW, previous: lastGood(), previousMeta: meta({ showdownSha: SHA, regulation: 'M-C' }) }), regs, plan, true, {
        exportFile: file,
        allowLocalBuild: false,
        minSpecies: 50,
        pin: pinAt(NEXT_SHA),
      });
    const otherCommit = await run(exportFile());
    expect(otherCommit.status).toMatchObject({ status: 'failed', detail: expect.stringMatching(/the export is of 7332b60, but curated\/pokemon\/showdown\.json pins 8888888/) });
    expect(otherCommit.dex?.species.length).toBe(recordedDex().species.length);

    const fewer = await run(exportFile({ ...structuredClone(recorded), sha: NEXT_SHA, regulations: structuredClone(recorded.regulations).slice(1) }));
    expect(fewer.status.detail).toMatch(/covers regulations \[M-C\], this run expects \[M-B, M-C\]/);

    const extra = await run(exportFile({ ...structuredClone(recorded), sha: NEXT_SHA, injected: 'x' } as RawDexExport));
    expect(extra.status).toMatchObject({ status: 'failed', detail: expect.stringMatching(/Showdown export export\.json/) });
    expect(extra.issues.every((i) => i.level === 'warn')).toBe(true);
  });

  it('never builds Showdown code itself unless told to', async () => {
    const r = await runDexSource(fakeContext({ http: fakeHttp({}), now: NOW, previous: lastGood(), previousMeta: meta({ showdownSha: SHA, regulation: 'M-C' }) }), regs, plan, true, {
      pin: pinAt(NEXT_SHA),
      exportFile: null,
      allowLocalBuild: false,
    });
    expect(r.status).toMatchObject({ status: 'failed', detail: expect.stringMatching(/no export of 8888888 to read: the data job does not run Showdown code/) });
    expect(r.issues).toEqual([expect.objectContaining({ level: 'warn', message: expect.stringMatching(/WHETSTONE_SHOWDOWN_EXPORT.*last-good dex kept/) })]);
  });

  it('honours --only by re-emitting the last-good dex untouched', async () => {
    const http = fakeHttp({});
    const r = await runDexSource(fakeContext({ http, now: NOW, previous: lastGood(), previousMeta: meta({ regulation: 'M-C' }) }), regs, plan, false);
    expect(http.calls).toEqual([]);
    expect(r.status).toMatchObject({ status: 'stale', detail: expect.stringMatching(/--only/) });
    expect(r.calc).toMatchObject({ status: 'ok', detail: expect.stringMatching(/species match the dex/) });
    expect(paths(r.files)).toEqual(Object.values(DEX_FILES));
  });

  it('takes data from the previous regulation while Showdown has no format for the new one', async () => {
    const after = regulationPlan(WITH_NEXT, new Date('2026-12-03T00:00:00Z'));
    const request = dexRequest(WITH_NEXT, after);
    expect(request.dataRegulations).toEqual(['M-D', 'M-C']);
    expect(request.regulations.map((r) => r.format)).toEqual(['gen9championsvgc2026regmb', 'gen9championsvgc2026regmc', 'gen9championsvgc2027regmd']);
    const withoutMd: RawDexExport = { ...structuredClone(recorded), regulations: [...structuredClone(recorded.regulations), { id: 'M-D', format: 'gen9championsvgc2027regmd', exists: false }] };
    const r = await runDexSource(fakeContext({ http: fakeHttp({ [SPRITE_SOURCE]: new Error('404') }), now: new Date('2026-12-03T00:00:00Z') }), WITH_NEXT, after, true, opts(withoutMd));
    expect(r.status.status).toBe('ok');
    expect(r.regulation).toBe('M-C');
    expect(r.counts?.legalSpecies).toBeGreaterThan(0);
  });
});
