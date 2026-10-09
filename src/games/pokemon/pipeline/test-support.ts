/**
 * Test helpers for the Pokémon pipeline (imported by *.test.ts only): a scripted Http, a
 * PipelineContext over an in-memory last-good tree, the recorded dex fixture and a regulations
 * file with a hypothetical next regulation (M-D) for rollover tests.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { GameMeta, Http, HttpInit, PipelineContext } from '../../../core/game.ts';
import { repoRoot } from '../../../lib/datadir.ts';
import { RegulationsFileSchema, type RegulationsFile } from '../schema.ts';
import { readRecordedExport } from './showdown/source.ts';
import { transformDex, type DexFiles } from './showdown/transform.ts';

export const ROOT = repoRoot();
export const RAW = path.join(ROOT, 'src', 'games', 'pokemon', 'fixtures', 'raw');

/** Recording time of the raw fixtures. */
export const RECORDED_AT = new Date('2026-10-09T01:15:00Z');

/** Contents of a recorded raw fixture (relative to fixtures/raw). */
export function rawFixture(rel: string): string {
  return readFileSync(path.join(RAW, rel), 'utf8');
}

let dexCache: DexFiles | null = null;
/** The recorded (trimmed) Showdown export, transformed. */
export function recordedDex(): DexFiles {
  dexCache ??= transformDex(readRecordedExport(ROOT)).files;
  return structuredClone(dexCache);
}

export type Route = string | Uint8Array | object | Error | ((url: string, init?: HttpInit) => unknown);

export interface FakeHttp extends Http {
  /** Every request, in order: `<kind> <url>`. */
  calls: string[];
  inits: (HttpInit | undefined)[];
}

/**
 * Http that answers from `routes` (exact URL first, then the longest matching prefix). A string
 * answers text() and is JSON-parsed for json(); an object answers json(); an Error is thrown;
 * a function is called. Unknown URLs reject like a 404.
 */
export function fakeHttp(routes: Readonly<Record<string, Route>>): FakeHttp {
  const calls: string[] = [];
  const inits: (HttpInit | undefined)[] = [];
  const find = (url: string): Route | undefined => {
    if (url in routes) return routes[url];
    const prefix = Object.keys(routes)
      .filter((k) => url.startsWith(k))
      .sort((a, b) => b.length - a.length)[0];
    return prefix === undefined ? undefined : routes[prefix];
  };
  const answer = async (kind: string, url: string, init?: HttpInit): Promise<unknown> => {
    calls.push(`${kind} ${url}`);
    inits.push(init);
    let r = find(url);
    if (typeof r === 'function') r = (await r(url, init)) as Route;
    if (r === undefined) throw new Error(`GET ${url} -> 404`);
    if (r instanceof Error) throw r;
    return r;
  };
  return {
    calls,
    inits,
    async json<T>(url: string, init?: HttpInit): Promise<T> {
      const r = await answer('json', url, init);
      return (typeof r === 'string' ? JSON.parse(r) : r) as T;
    },
    async text(url: string, init?: HttpInit): Promise<string> {
      const r = await answer('text', url, init);
      return typeof r === 'string' ? r : JSON.stringify(r);
    },
    async bytes(url: string, init?: HttpInit): Promise<Uint8Array> {
      const r = await answer('bytes', url, init);
      return r instanceof Uint8Array ? r : new TextEncoder().encode(typeof r === 'string' ? r : JSON.stringify(r));
    },
    async head(url: string, init?: HttpInit): Promise<Record<string, string>> {
      await answer('head', url, init);
      return {};
    },
  };
}

export interface FakeContextOptions {
  http?: Http;
  /** Last-good files by data path (JSON values or bytes). */
  previous?: Readonly<Record<string, unknown>>;
  previousMeta?: GameMeta | null;
  now?: Date;
  offline?: boolean;
}

export function fakeContext(o: FakeContextOptions = {}): PipelineContext & { logs: string[] } {
  const logs: string[] = [];
  const previous = o.previous ?? {};
  return {
    game: 'pokemon',
    http: o.http ?? fakeHttp({}),
    secrets: {},
    previousMeta: o.previousMeta ?? null,
    now: o.now ?? RECORDED_AT,
    offline: o.offline ?? false,
    root: ROOT,
    logs,
    log: (msg: string) => {
      logs.push(msg);
    },
    async previous(rel: string): Promise<unknown | null> {
      if (!(rel in previous)) return null;
      const v = previous[rel];
      return v instanceof Uint8Array ? v : structuredClone(v);
    },
  };
}

/** The curated M-B and M-C windows plus a hypothetical M-D, to exercise the M-C → next rollover. */
export const WITH_NEXT: RegulationsFile = RegulationsFileSchema.parse({
  regulations: [
    {
      id: 'M-B',
      label: 'Regulation Set M-B',
      start: '2026-06-17T02:00:00Z',
      end: '2026-09-09T01:59:00Z',
      showdownMod: 'championsregmb',
      formats: { doubles: 'gen9championsvgc2026regmb', doublesBo3: 'gen9championsvgc2026regmbbo3', singles: 'gen9championsbssregmb' },
      limitlessFormat: 'M-B',
      seasons: [],
    },
    {
      id: 'M-C',
      label: 'Regulation Set M-C',
      start: '2026-09-09T02:00:00Z',
      end: '2026-12-02T01:59:00Z',
      showdownMod: 'champions',
      formats: { doubles: 'gen9championsvgc2026regmc', doublesBo3: 'gen9championsvgc2026regmcbo3', singles: 'gen9championsbssregmc' },
      limitlessFormat: 'M-C',
      seasons: [
        { id: 'M-6', start: '2026-09-09T02:00:00Z', end: '2026-10-07T01:59:00Z' },
        { id: 'M-7', start: '2026-10-07T02:00:00Z', end: '2026-11-04T01:59:00Z', estimated: true },
      ],
    },
    {
      id: 'M-D',
      label: 'Regulation Set M-D',
      start: '2026-12-02T02:00:00Z',
      end: '2027-03-03T01:59:00Z',
      showdownMod: 'champions',
      formats: { doubles: 'gen9championsvgc2027regmd', doublesBo3: 'gen9championsvgc2027regmdbo3', singles: 'gen9championsbssregmd' },
      limitlessFormat: 'M-D',
      seasons: [{ id: 'M-9', start: '2026-12-02T02:00:00Z', end: '2027-01-06T01:59:00Z', estimated: true }],
      estimatedEnd: true,
    },
  ],
});
