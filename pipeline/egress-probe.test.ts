import { describe, expect, it } from 'vitest';
import { PROBES, looksLikeChallenge, runProbe } from './egress-probe.ts';

const fetchReturning = (res: Response) => (async () => res) as unknown as typeof fetch;

describe('egress probe', () => {
  it('has one probe per host', () => {
    const hosts = PROBES.map((p) => new URL(p.url).host);
    expect(new Set(hosts).size).toBe(hosts.length);
  });

  it('detects Cloudflare challenges by header or body', () => {
    expect(looksLikeChallenge(403, new Headers({ 'cf-mitigated': 'challenge' }), '')).toBe(true);
    expect(looksLikeChallenge(503, new Headers(), '<title>Just a moment...</title>')).toBe(true);
    expect(looksLikeChallenge(401, new Headers(), '{"error":{"code":"unauthenticated"}}')).toBe(false);
    expect(looksLikeChallenge(200, new Headers(), 'just a moment')).toBe(false);
  });

  it('accepts the expected status and flags anything else', async () => {
    const hp = { name: 'HP', url: 'https://www.heroesprofile.com/api/external/v1/patches', expect: [401] };
    const ok = await runProbe(hp, 'ua', fetchReturning(new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } })));
    expect(ok).toMatchObject({ ok: true, status: 401, contentType: 'application/json' });
    const blocked = await runProbe(hp, 'ua', fetchReturning(new Response('<html>Just a moment...</html>', { status: 403 })));
    expect(blocked).toMatchObject({ ok: false, challenge: true, note: 'bot challenge' });
    const down = await runProbe(hp, 'ua', (async () => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch);
    expect(down).toMatchObject({ ok: false, status: 0, note: 'fetch failed' });
  });
});
