import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { HttpError, OfflineFixtureError, createHttp, fixtureKey, parseRetryAfter, redactUrl, userAgent, type HttpOptions } from './http.ts';

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'ws-http-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface Call {
  url: string;
  init: RequestInit;
}

type Reply = Response | Error | ((call: Call) => Response | Promise<Response>);

/** fetch stub that replays `replies` in order and records every call. */
function stubFetch(replies: Reply[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    const next = replies.shift();
    if (!next) throw new Error(`unexpected request ${call.url}`);
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(call) : next;
  };
  return { fetch: impl as typeof fetch, calls };
}

/** Virtual clock: sleep advances time instantly and records requested delays. */
function clock(start = 1_000_000) {
  let t = start;
  const sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
  };
}

function make(opts: Partial<HttpOptions> & Pick<HttpOptions, 'fetch'>, c = clock()) {
  return createHttp({ game: 'hots', root, now: c.now, sleep: c.sleep, seed: 1, ...opts });
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('helpers', () => {
  it('builds the user agent with an optional contact', () => {
    expect(userAgent()).toBe('Whetstone/0.1 (+https://github.com/JollyKrampus/whetstone)');
    expect(userAgent('me@example.com')).toBe('Whetstone/0.1 (+https://github.com/JollyKrampus/whetstone; me@example.com)');
  });

  it('redacts secret query parameters and keeps fixture keys stable across secrets', () => {
    const a = 'https://www.googleapis.com/youtube/v3/search?part=snippet&key=SECRET1';
    const b = 'https://www.googleapis.com/youtube/v3/search?part=snippet&key=OTHER';
    expect(redactUrl(a)).toBe('https://www.googleapis.com/youtube/v3/search?part=snippet&key=REDACTED');
    expect(fixtureKey(a)).toBe(fixtureKey(b));
    expect(fixtureKey(a)).toMatch(/^[0-9a-f]{16}$/);
    expect(fixtureKey(a, 'POST')).not.toBe(fixtureKey(a));
    expect(redactUrl('https://example.com/x?y=1')).toBe('https://example.com/x?y=1');
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('7', 0)).toBe(7000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 4000)).toBe(6000);
    expect(parseRetryAfter('soon', 0)).toBeNull();
    expect(parseRetryAfter(undefined, 0)).toBeNull();
  });
});

describe('network', () => {
  it('sends the User-Agent and Accept headers and parses JSON', async () => {
    const s = stubFetch([json({ ok: true })]);
    const http = make({ fetch: s.fetch, contact: 'ops@example.com' });
    await expect(http.json('https://api.example.com/a')).resolves.toEqual({ ok: true });
    const headers = s.calls[0]!.init.headers as Record<string, string>;
    expect(headers['user-agent']).toContain('ops@example.com');
    expect(headers.accept).toBe('application/json');
  });

  it('lets callers override headers and send a body', async () => {
    const s = stubFetch([json({})]);
    const http = make({ fetch: s.fetch });
    await http.json('https://api.example.com/a', { method: 'POST', body: '{"q":1}', headers: { Authorization: 'Bearer t', Accept: 'text/csv' } });
    const init = s.calls[0]!.init;
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"q":1}');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer t');
    expect((init.headers as Record<string, string>).accept).toBe('text/csv');
  });

  it('retries 5xx with deterministic exponential backoff', async () => {
    const replies = () => [new Response('busy', { status: 503 }), new Response('busy', { status: 502 }), json({ v: 1 })];
    const c1 = clock();
    const r1 = await make({ fetch: stubFetch(replies()).fetch }, c1).json('https://api.example.com/x');
    const c2 = clock();
    await make({ fetch: stubFetch(replies()).fetch }, c2).json('https://api.example.com/x');
    expect(r1).toEqual({ v: 1 });
    expect(c1.sleeps).toHaveLength(2);
    expect(c1.sleeps).toEqual(c2.sleeps);
    expect(c1.sleeps[0]).toBeGreaterThanOrEqual(500);
    expect(c1.sleeps[0]).toBeLessThan(1000);
    expect(c1.sleeps[1]).toBeGreaterThanOrEqual(1000);
    expect(c1.sleeps[1]).toBeLessThan(1500);
  });

  it('honours Retry-After on 429', async () => {
    const c = clock();
    const s = stubFetch([new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }), json([1])]);
    await expect(make({ fetch: s.fetch }, c).json('https://api.example.com/x')).resolves.toEqual([1]);
    expect(c.sleeps).toEqual([7000]);
  });

  it('gives up when Retry-After exceeds the limit', async () => {
    const s = stubFetch([new Response('{"error":{"code":"quota_exceeded"}}', { status: 429, headers: { 'retry-after': '86400' } })]);
    const err = await make({ fetch: s.fetch }).json('https://api.example.com/x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(429);
    expect((err as HttpError).bodySnippet).toContain('quota_exceeded');
    expect(s.calls).toHaveLength(1);
  });

  it('does not retry other 4xx and redacts the URL in the error', async () => {
    const s = stubFetch([new Response('nope', { status: 401 })]);
    const err = await make({ fetch: s.fetch }).text('https://api.example.com/x?api_token=abc').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(401);
    expect((err as HttpError).message).toContain('api_token=REDACTED');
    expect((err as HttpError).message).not.toContain('abc');
    expect(s.calls).toHaveLength(1);
  });

  it('retries network errors and finally throws an HttpError with status 0', async () => {
    const s = stubFetch([new TypeError('fetch failed'), new TypeError('fetch failed')]);
    const err = await make({ fetch: s.fetch, retries: 1 }).bytes('https://cdn.example.com/f.zip').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(0);
    expect(s.calls).toHaveLength(2);
  });

  it('aborts requests that exceed the timeout', async () => {
    const hang = (call: Call) =>
      new Promise<Response>((_, reject) => {
        call.init.signal?.addEventListener('abort', () => reject(call.init.signal?.reason));
      });
    const s = stubFetch([hang]);
    const err = await make({ fetch: s.fetch, retries: 0 }).text('https://slow.example.com/', { timeoutMs: 20 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).message).toMatch(/timed out after 20 ms/);
  });

  it('spaces requests to the same host but not across hosts', async () => {
    const c = clock();
    const s = stubFetch([json(1), json(2), json(3)]);
    const http = make({ fetch: s.fetch }, c);
    await http.json('https://a.example.com/1');
    await http.json('https://b.example.com/1');
    await http.json('https://a.example.com/2', { spacingMs: 2000 });
    expect(c.sleeps).toEqual([2000]);
  });

  it('returns lower-cased headers from head()', async () => {
    const s = stubFetch([new Response(null, { status: 200, headers: { 'Last-Modified': 'Thu, 01 Oct 2026 14:40:21 GMT' } })]);
    const h = await make({ fetch: s.fetch }).head('https://www.smogon.com/stats/x.json');
    expect(h['last-modified']).toBe('Thu, 01 Oct 2026 14:40:21 GMT');
    expect(s.calls[0]!.init.method).toBe('HEAD');
  });
});

describe('dev cache', () => {
  it('serves fresh entries from disk and revalidates stale ones with ETag', async () => {
    const c = clock();
    const s = stubFetch([
      json({ n: 1 }, { headers: { etag: '"v1"' } }),
      (call) => {
        expect((call.init.headers as Record<string, string>)['if-none-match']).toBe('"v1"');
        return new Response(null, { status: 304 });
      },
    ]);
    const http = make({ fetch: s.fetch, cache: true }, c);
    expect(await http.json('https://api.example.com/c')).toEqual({ n: 1 });
    expect(await http.json('https://api.example.com/c')).toEqual({ n: 1 });
    expect(s.calls).toHaveLength(1);
    c.advance(13 * 3_600_000);
    expect(await http.json('https://api.example.com/c')).toEqual({ n: 1 });
    expect(s.calls).toHaveLength(2);
    expect(existsSync(path.join(root, '.cache', 'http'))).toBe(true);
  });

  it('does not cache when disabled (CI)', async () => {
    const s = stubFetch([json(1), json(2)]);
    const http = make({ fetch: s.fetch, cache: false });
    await http.json('https://api.example.com/c');
    expect(await http.json('https://api.example.com/c')).toBe(2);
    expect(existsSync(path.join(root, '.cache'))).toBe(false);
  });
});

describe('offline fixtures and record mode', () => {
  const raw = () => path.join(root, 'src', 'games', 'hots', 'fixtures', 'raw');

  it('reads a fixture by explicit key or URL hash', async () => {
    mkdirSync(raw(), { recursive: true });
    writeFileSync(path.join(raw(), 'tact-hero.txt'), 'Region!STRING:0|BuildId!DEC:4\nus|98348\n');
    const url = 'https://news.blizzard.com/en-us/api/feed/heroes-of-the-storm?offset=0';
    writeFileSync(path.join(raw(), `${fixtureKey(url)}.json`), '﻿{"feed":[]}');
    const http = make({ fetch: stubFetch([]).fetch, offline: true });
    await expect(http.text('https://us.version.battle.net/v2/products/hero/versions', { fixture: 'tact-hero' })).resolves.toContain('98348');
    await expect(http.json(url)).resolves.toEqual({ feed: [] });
  });

  it('throws a helpful error when the fixture is missing', async () => {
    const http = make({ fetch: stubFetch([]).fetch, offline: true });
    const err = await http.json('https://api.example.com/missing').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OfflineFixtureError);
    expect((err as OfflineFixtureError).message).toContain('src/games/hots/fixtures/raw/');
    expect((err as OfflineFixtureError).message).toContain('WHETSTONE_RECORD=1');
  });

  it('rejects fixture keys that escape the fixtures directory', async () => {
    const http = make({ fetch: stubFetch([]).fetch, offline: true });
    await expect(http.json('https://x.example.com', { fixture: '../secrets' })).rejects.toThrow(/Invalid fixture key/);
  });

  it('records responses as fixtures that offline mode can replay', async () => {
    const s = stubFetch([json({ rotation: ['Abathur'] }), new Response('bin', { status: 200 })]);
    const live = make({ fetch: s.fetch, record: true });
    await live.json('https://nexuscompendium.com/api/currently/herorotation', { fixture: 'nc/rotation' });
    await live.bytes('https://example.com/file.zip');
    expect(readFileSync(path.join(raw(), 'nc', 'rotation.json'), 'utf8')).toBe('{"rotation":["Abathur"]}');
    expect(existsSync(path.join(raw(), `${fixtureKey('https://example.com/file.zip')}.bin`))).toBe(true);

    const offline = make({ fetch: stubFetch([]).fetch, offline: true });
    await expect(offline.json('https://nexuscompendium.com/api/currently/herorotation', { fixture: 'nc/rotation' })).resolves.toEqual({ rotation: ['Abathur'] });
  });
});
