import { describe, expect, it } from 'vitest';
import { HpBudgetError, HpError, createHpClient, rateLimitWaitMs, retryAfterMs, type HpResponse, type HpTransport } from './heroesprofile.ts';

interface Call {
  url: string;
  headers: Record<string, string>;
}

/** Scripted transport: answers queued responses in order and records each request. */
function scripted(responses: HpResponse[]): { transport: HpTransport; calls: Call[] } {
  const calls: Call[] = [];
  const queue = [...responses];
  return {
    calls,
    transport: async (url, headers) => {
      calls.push({ url, headers });
      const next = queue.shift();
      if (!next) throw new Error(`unexpected request ${url}`);
      return next;
    },
  };
}
const ok = (body: unknown, headers: Record<string, string> = {}): HpResponse => ({ status: 200, headers, body: JSON.stringify(body) });

function client(responses: HpResponse[], budget = 10) {
  const s = scripted(responses);
  let now = 1_000_000;
  const sleeps: number[] = [];
  const c = createHpClient({
    key: 'secret-key',
    budget,
    transport: s.transport,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });
  return { c, calls: s.calls, sleeps };
}

describe('createHpClient', () => {
  it('sends the key as a Bearer token with JSON accept and a stable query order', async () => {
    const { c, calls } = client([ok({ data: [] })]);
    expect(await c.get('heroes/stats', { z: 1, a: 'x y', skip: undefined })).toEqual({ data: [] });
    expect(calls[0]?.url).toBe('https://www.heroesprofile.com/api/external/v1/heroes/stats?a=x+y&z=1');
    expect(calls[0]?.headers).toMatchObject({ authorization: 'Bearer secret-key', accept: 'application/json' });
    expect(calls[0]?.headers['user-agent']).toMatch(/^Whetstone\//);
    expect(c.calls).toBe(1);
  });

  it('polls a 202 job at its Location, honouring Retry-After, without billing polls', async () => {
    const { c, calls, sleeps } = client([
      { status: 202, headers: { location: '/api/external/v1/jobs/42', 'retry-after': '5' }, body: '{"async":true}' },
      { status: 202, headers: { 'retry-after': '7' }, body: '{}' },
      ok([{ hero: 'Abathur' }]),
    ]);
    expect(await c.get('heroes/stats')).toEqual([{ hero: 'Abathur' }]);
    expect(calls.map((x) => x.url.replace('https://www.heroesprofile.com', ''))).toEqual(['/api/external/v1/heroes/stats', '/api/external/v1/jobs/42', '/api/external/v1/jobs/42']);
    expect(sleeps).toEqual([5000, 7000]);
    expect(c.calls).toBe(1);
  });

  it('retries a 429 with Retry-After and gives up on one without it', async () => {
    const a = client([{ status: 429, headers: { 'retry-after': '3' }, body: '{}' }, ok({ fine: true })]);
    expect(await a.c.get('x')).toEqual({ fine: true });
    expect(a.sleeps).toEqual([3000]);
    expect(a.c.calls).toBe(1);
    const b = client([{ status: 429, headers: {}, body: '{"error":{"code":"quota_exceeded","message":"Weekly quota used"}}' }]);
    await expect(b.c.get('x')).rejects.toMatchObject({ name: 'HpError', status: 429, code: 'quota_exceeded' });
  });

  it('waits for the rate-limit window when remaining reaches 0', async () => {
    const { c, sleeps } = client([ok(1, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '12' }), ok(2)]);
    await c.get('a');
    await c.get('b');
    expect(sleeps).toEqual([12000]);
  });

  it('surfaces the error envelope and enforces the call budget', async () => {
    const { c } = client([{ status: 403, headers: {}, body: '{"error":{"code":"forbidden","message":"Not in your plan"}}' }]);
    const err = await c.get('heroes/matchups').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HpError);
    expect(String((err as Error).message)).toMatch(/403 forbidden: Not in your plan/);
    expect(String((err as Error).message)).not.toMatch(/secret-key/);
    const b = client([ok(1), ok(2)], 1);
    await b.c.get('a');
    await expect(b.c.get('b')).rejects.toBeInstanceOf(HpBudgetError);
  });

  it('retries server errors twice', async () => {
    const { c } = client([{ status: 503, headers: {}, body: '' }, ok('done')]);
    expect(await c.get('a')).toBe('done');
  });
});

describe('header helpers', () => {
  it('reads Retry-After seconds or dates', () => {
    expect(retryAfterMs('10', 0)).toBe(10_000);
    expect(retryAfterMs('Thu, 01 Jan 1970 00:00:05 GMT', 0)).toBe(5_000);
    expect(retryAfterMs('soon', 0)).toBeNull();
  });

  it('reads the rate-limit reset as delta seconds or an epoch', () => {
    expect(rateLimitWaitMs({ 'x-ratelimit-remaining': '3' }, 0)).toBe(0);
    expect(rateLimitWaitMs({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '30' }, 0)).toBe(30_000);
    expect(rateLimitWaitMs({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2000000000' }, 1_999_999_990_000)).toBe(10_000);
    expect(rateLimitWaitMs({ 'x-ratelimit-remaining': '0' }, 0)).toBe(60_000);
  });
});
