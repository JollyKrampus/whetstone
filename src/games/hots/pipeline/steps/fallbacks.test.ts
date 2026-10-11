/**
 * Step-level fallbacks with a fake transport: a lagging or unreachable rotation source
 * (hots-logic/F4).
 */
import { describe, expect, it } from 'vitest';
import type { Http, HttpInit, PipelineContext } from '../../../../core/game.ts';
import type { Rotation } from '../../schema.ts';
import { FIXTURE_NOW, REPO_ROOT, fixtureRelease, rawJson, testCurated } from '../test-helpers.ts';
import { buildHeroes } from '../transform/heroes.ts';
import { createEnv, type RunEnv } from './common.ts';
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
