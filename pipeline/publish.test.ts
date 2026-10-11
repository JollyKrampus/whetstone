import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GameMeta } from '../src/core/game.ts';
import type { GameStatus, PublicManifest, StatusFile } from './manifest.ts';
import { publish } from './publish.ts';
import { listFiles } from './store.ts';

let root: string;
let store: string;
let artifacts: string;
const now = new Date('2026-10-09T10:30:00Z');

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ws-publish-'));
  store = path.join(root, 'store');
  artifacts = path.join(root, 'artifacts');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function put(base: string, rel: string, content: string): void {
  const file = path.join(base, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function meta(game: GameMeta['game'], hash: string, generatedAt = '2026-10-09T10:20:00.000Z'): GameMeta {
  return { game, schema: 1, version: { label: 'v' }, generatedAt, dataHash: hash, sources: [{ id: 's', fetchedAt: generatedAt, status: 'ok' }], counts: {} };
}

function status(state: GameStatus['state'], hash: string | null, changed: boolean): GameStatus {
  return { state, checkedAt: now.toISOString(), generatedAt: null, dataHash: hash, changed, durationMs: 1, files: { current: 1, private: 0 }, sources: [], issues: [] };
}

function artifact(game: GameMeta['game'], st: GameStatus, withData = true): void {
  const base = path.join(artifacts, `data-${game}`);
  const statusFile: StatusFile = { schema: 1, updatedAt: now.toISOString(), games: { [game]: st } };
  put(base, 'status.json', JSON.stringify(statusFile));
  if (withData) {
    put(base, `current/${game}/meta.json`, JSON.stringify(meta(game, st.dataHash ?? 'none')));
    put(base, `current/${game}/data.json`, `{"game":"${game}"}`);
    put(base, `history/2026/10/09/${game}.json.gz`, 'gz');
  }
}

describe('publish', () => {
  it('copies successful games, keeps last-good for failed or missing ones, merges status and history', () => {
    put(store, 'current/hots/meta.json', JSON.stringify(meta('hots', 'old-hots')));
    put(store, 'current/hots/stale.json', '{}');
    put(store, 'current/mtga/meta.json', JSON.stringify(meta('mtga', 'old-mtga')));
    put(store, 'current/pokemon/meta.json', JSON.stringify(meta('pokemon', 'old-pkmn')));
    put(store, 'history/2026/10/08/hots.json.gz', 'yesterday');

    artifact('hots', status('ok', 'new-hots', true));
    artifact('mtga', status('failed', 'old-mtga', false), false);
    // pokemon: no artifact at all (job crashed).

    const r = publish({ store, artifacts, games: ['hots', 'mtga', 'pokemon'], now });

    expect(listFiles(path.join(store, 'current', 'hots'))).toEqual(['data.json', 'meta.json']);
    expect(JSON.parse(readFileSync(path.join(store, 'current', 'mtga', 'meta.json'), 'utf8')).dataHash).toBe('old-mtga');
    expect(listFiles(path.join(store, 'history'))).toEqual(['2026/10/08/hots.json.gz', '2026/10/09/hots.json.gz']);
    expect(r.changed).toBe(true);
    expect(r.deploy).toBe(true);
    expect(r.failed).toEqual(['mtga', 'pokemon']);
    expect(r.summary).toBe('hots=ok* mtga=failed pokemon=failed');
    const st = JSON.parse(readFileSync(path.join(store, 'status.json'), 'utf8')) as StatusFile;
    expect(st.games.pokemon).toMatchObject({ state: 'failed', dataHash: 'old-pkmn' });
    expect(st.games.pokemon?.sources[0]?.status).toBe('stale');
    expect(existsSync(path.join(store, 'README.md'))).toBe(true);
    expect(readFileSync(path.join(store, 'LICENSE'), 'utf8')).toContain('MIT License');
    const notice = readFileSync(path.join(store, 'NOTICE.md'), 'utf8');
    // Generated from the registry: every game, its open sources with licence and copyright, and the MIT text.
    expect(notice).toContain('## Heroes of the Storm');
    expect(notice).toContain('Copyright (c) 2026 Kevin Oliva');
    expect(notice).toContain('Copyright (c) 2011-2026 Guangcong Luo and other contributors');
    expect(notice).toContain('CC BY 4.0');
    expect(notice).toContain('Permission is hereby granted');
    expect(notice).not.toMatch(/custody [BCD]\b/);
  });

  it('rejects an artifact that still carries the old status.json of the branch', () => {
    const old: StatusFile = { schema: 1, updatedAt: '2026-10-08T10:30:00.000Z', games: { hots: { ...status('ok', 'old', true), checkedAt: '2026-10-08T10:30:00.000Z' } } };
    put(store, 'status.json', JSON.stringify(old));
    put(store, 'current/hots/meta.json', JSON.stringify(meta('hots', 'old')));
    // The job died before run.ts wrote a new status: the artifact holds yesterday's file.
    const base = path.join(artifacts, 'data-hots');
    put(base, 'status.json', JSON.stringify(old));
    put(base, 'current/hots/meta.json', JSON.stringify(meta('hots', 'old')));
    const r = publish({ store, artifacts, games: ['hots'], now });
    expect(r.failed).toEqual(['hots']);
    expect(r.changed).toBe(false);
    expect(r.status.games.hots?.detail).toMatch(/old status.json/);
  });

  it('counts consecutive degraded runs per source and raises an alert from the second', () => {
    const degraded = (checkedAt: string, ids: string[]): GameStatus => ({ ...status('ok', 'h', false), checkedAt, degraded: ids });
    put(store, 'current/hots/meta.json', JSON.stringify(meta('hots', 'h')));
    artifact('hots', degraded('2026-10-09T10:30:00.000Z', ['liquipedia']));
    const first = publish({ store, artifacts, games: ['hots'], now });
    expect(first.degraded).toEqual(['hots:liquipedia(1)']);
    expect(first.alert).toEqual([]);

    rmSync(artifacts, { recursive: true, force: true });
    artifact('hots', degraded('2026-10-10T10:30:00.000Z', ['liquipedia', 'tact']));
    const second = publish({ store, artifacts, games: ['hots'], now: new Date('2026-10-10T10:40:00Z') });
    expect(second.degraded).toEqual(['hots:liquipedia(2)', 'hots:tact(1)']);
    expect(second.alert).toEqual(['hots:liquipedia(2)']);
    expect(second.status.games.hots?.degradedRuns).toEqual({ liquipedia: 2, tact: 1 });

    rmSync(artifacts, { recursive: true, force: true });
    artifact('hots', degraded('2026-10-11T10:30:00.000Z', []));
    const recovered = publish({ store, artifacts, games: ['hots'], now: new Date('2026-10-11T10:40:00Z') });
    expect(recovered.degraded).toEqual([]);
    expect(recovered.status.games.hots?.degradedRuns).toBeUndefined();
  });

  it('treats an ok status without data as a failure', () => {
    put(store, 'current/hots/meta.json', JSON.stringify(meta('hots', 'old')));
    artifact('hots', status('ok', 'new', true), false);
    const r = publish({ store, artifacts, games: ['hots'], now });
    expect(r.failed).toEqual(['hots']);
    expect(r.changed).toBe(false);
    expect(JSON.parse(readFileSync(path.join(store, 'current', 'hots', 'meta.json'), 'utf8')).dataHash).toBe('old');
  });

  it('requests a deploy when the live site lags even if nothing changed', () => {
    put(store, 'current/hots/meta.json', JSON.stringify(meta('hots', 'h')));
    artifact('hots', status('ok', 'h', false));
    const live = (hash: string, generatedAt: string, fixtures = false): PublicManifest => ({
      schema: 1,
      games: { hots: { version: { label: 'v' }, generatedAt, dataHash: hash, fixtures, sources: [], counts: {}, files: {} } },
    });
    const fresh = '2026-10-09T08:00:00.000Z';
    expect(publish({ store, artifacts, games: ['hots'], now, live: live('h', fresh) }).deploy).toBe(false);
    expect(publish({ store, artifacts, games: ['hots'], now, live: live('other', fresh) }).deployReasons).toEqual(['hots: live dataHash differs']);
    expect(publish({ store, artifacts, games: ['hots'], now, live: live('h', '2026-10-01T00:00:00.000Z') }).deploy).toBe(true);
    expect(publish({ store, artifacts, games: ['hots'], now, live: live('h', fresh, true) }).deploy).toBe(true);
    expect(publish({ store, artifacts, games: ['hots'], now, live: null }).deployReasons).toEqual(['hots: not on the live site']);
  });
});
