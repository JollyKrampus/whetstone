/**
 * The load.ts helpers added with the pipeline (getWarmingUp, getRosterRegulation,
 * getSpriteCredit), read from a data directory this pipeline produced offline.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPipelines } from '../../../../pipeline/run.ts';
import * as load from '../load.ts';
import type { PokemonMeta } from '../schema.ts';
import { RECORDED_AT, ROOT, WITH_NEXT } from './test-support.ts';

let tmp: string;
let dir: string;
const saved = process.env.WHETSTONE_DATA_DIR;

const edit = <T>(file: string, change: (x: T) => T): void => {
  const p = path.join(dir, file);
  writeFileSync(p, JSON.stringify(change(JSON.parse(readFileSync(p, 'utf8')) as T)));
};

beforeAll(async () => {
  tmp = mkdtempSync(path.join(tmpdir(), 'ws-pk-load-'));
  const out = path.join(tmp, 'data');
  const summary = await runPipelines({ root: ROOT, out, games: ['pokemon'], offline: true, env: {}, now: RECORDED_AT, print: () => {}, history: { enabled: false, maxBytes: 0 } });
  expect(summary.reports[0]?.status.state).toBe('ok');
  dir = path.join(out, 'current', 'pokemon');
  // A warm-up after a hypothetical M-D, with self-hosted sprites.
  edit<PokemonMeta>('meta.json', (m) => ({
    ...m,
    extra: {
      ...m.extra,
      warmingUp: { regulation: 'M-D', since: '2026-12-02T02:00:00Z', sources: ['smogon'], showing: 'M-C' },
      sprites: { count: 1, source: 'https://play.pokemonshowdown.com/sprites/gen5/', credit: 'Sprites: test credit' },
    },
  }));
  edit('regulations.json', () => WITH_NEXT);
  process.env.WHETSTONE_DATA_DIR = out;
  load.clearPokemonCache();
});

afterAll(() => {
  if (saved === undefined) delete process.env.WHETSTONE_DATA_DIR;
  else process.env.WHETSTONE_DATA_DIR = saved;
  load.clearPokemonCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('load.ts helpers for pipeline data', () => {
  it('reads the pipeline output through the loader', () => {
    expect(load.getMeta().extra.showdownSha).toBe('7332b60e22b9e8194bb53549549eba241d73cc9a');
    expect(load.getSpecies().length).toBeGreaterThan(50);
    expect(load.getUsageIndex()).toHaveLength(3);
    expect(load.getTournaments()?.totals.tournaments).toBe(2);
    expect(load.getDexShard()?.regulation).toBe('M-C');
  });

  it('exposes the warm-up state and the sprite credit', () => {
    expect(load.getWarmingUp()).toEqual({ regulation: 'M-D', since: '2026-12-02T02:00:00Z', sources: ['smogon'], showing: 'M-C' });
    expect(load.getSpriteCredit()).toMatchObject({ credit: 'Sprites: test credit' });
  });

  it('keeps a roster while Showdown has no data for a new regulation', () => {
    const inMd = new Date('2026-12-05T00:00:00Z');
    expect(load.getCurrentRegulation(inMd).id).toBe('M-D');
    expect(load.getLegalSpecies('M-D')).toEqual([]);
    expect(load.getRosterRegulation(inMd).id).toBe('M-C');
    expect(load.getLegalSpecies(load.getRosterRegulation(inMd).id).length).toBeGreaterThan(50);
    expect(load.getRosterRegulation(new Date('2026-10-09T00:00:00Z')).id).toBe('M-C');
  });
});
