/**
 * Heroes Profile API v1 client (network only; class B, gated on HP_MODE=on + HP_API_KEY).
 *
 * Built only on what is publicly observable and on standard HTTP semantics, never on Heroes
 * Profile's source code (their terms forbid reverse-engineering beyond the published docs):
 *  - Observed (2026-10-08, unauthenticated GET): base URL below answers JSON, `401` with an
 *    `{ "error": { "code", "message" } }` envelope, and `x-ratelimit-limit` /
 *    `x-ratelimit-remaining` headers.
 *  - Standard semantics handled generically: `Authorization: Bearer` (RFC 6750),
 *    `202 Accepted` + `Location` / `Retry-After` for asynchronous work (RFC 9110 §15.3.3,
 *    §10.2.2, §10.2.3), `429 Too Many Requests` + `Retry-After` (RFC 6585), rate-limit
 *    headers (`x-ratelimit-remaining`, `x-ratelimit-reset` or `retry-after`).
 *  - TODO(owner-verify): the auth scheme (Bearer vs. a query token), whether long-running
 *    queries really answer 202 with a pollable Location, and the reset header's unit. Endpoint
 *    paths and response shapes live in ./heroesprofileAdapter.ts.
 *
 * pipeline/http.ts's Http interface returns bodies only (no status codes or headers), which 202
 * polling and rate-limit handling need, so this client has its own small transport. The default
 * transport is global fetch with the pipeline's User-Agent; tests inject a fake one.
 */
import { userAgent } from '../../../../../pipeline/http.ts';

export const HP_BASE_URL = 'https://www.heroesprofile.com/api/external/v1';

export interface HpResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: string;
}

export type HpTransport = (url: string, headers: Record<string, string>) => Promise<HpResponse>;

export interface HpClientOptions {
  key: string;
  baseUrl?: string;
  transport?: HpTransport;
  /** Billable calls allowed in one run (job polls are not counted). */
  budget?: number;
  /** Longest wait for one asynchronous job. */
  maxJobMs?: number;
  /** Longest Retry-After honoured for a 429 before giving up. */
  maxRetryAfterMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
  contact?: string;
}

export class HpError extends Error {
  readonly status: number;
  /** `error.code` from the JSON envelope, when present. */
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'HpError';
    this.status = status;
    this.code = code;
  }
}

export class HpBudgetError extends Error {
  constructor(budget: number) {
    super(`Heroes Profile call budget of ${budget} calls for this run is used up`);
    this.name = 'HpBudgetError';
  }
}

export interface HpClient {
  /** GET a path (relative to the base URL) with query parameters; returns parsed JSON. */
  get(path: string, query?: Readonly<Record<string, string | number | boolean | undefined>>): Promise<unknown>;
  /** Billable calls made so far. */
  readonly calls: number;
  readonly budget: number;
}

/** Retry-After as milliseconds (delta-seconds or an HTTP date), else null. */
export function retryAfterMs(value: string | undefined, nowMs: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/**
 * Wait implied by rate-limit headers once `remaining` hits 0: `retry-after`, else
 * `x-ratelimit-reset` read as delta-seconds when small or as a Unix epoch (seconds) when large.
 * TODO(owner-verify): the reset header's unit.
 */
export function rateLimitWaitMs(headers: Readonly<Record<string, string>>, nowMs: number): number {
  const remaining = Number(headers['x-ratelimit-remaining']);
  if (!Number.isFinite(remaining) || remaining > 0) return 0;
  const ra = retryAfterMs(headers['retry-after'], nowMs);
  if (ra !== null) return ra;
  const reset = Number(headers['x-ratelimit-reset']);
  if (Number.isFinite(reset) && reset > 0) return reset > 1e9 ? Math.max(0, reset * 1000 - nowMs) : reset * 1000;
  return 60_000;
}

function envelope(body: string): { code: string | null; message: string | null } {
  try {
    const parsed = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
    const e = parsed?.error;
    return { code: typeof e?.code === 'string' ? e.code : null, message: typeof e?.message === 'string' ? e.message : null };
  } catch {
    return { code: null, message: null };
  }
}

export const fetchTransport =
  (timeoutMs = 120_000): HpTransport =>
  async (url, headers) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    try {
      const res = await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        out[k.toLowerCase()] = v;
      });
      return { status: res.status, headers: out, body: await res.text() };
    } finally {
      clearTimeout(timer);
    }
  };

export function createHpClient(opts: HpClientOptions): HpClient {
  const base = (opts.baseUrl ?? HP_BASE_URL).replace(/\/+$/, '');
  const transport = opts.transport ?? fetchTransport();
  const budget = opts.budget ?? 120;
  const maxJobMs = opts.maxJobMs ?? 20 * 60_000;
  const maxRetryAfter = opts.maxRetryAfterMs ?? 120_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const log = opts.log ?? (() => {});
  const headers = {
    authorization: `Bearer ${opts.key}`,
    accept: 'application/json',
    'user-agent': userAgent(opts.contact),
  };
  let calls = 0;
  let waitUntil = 0;

  async function send(url: string): Promise<HpResponse> {
    const wait = waitUntil - now();
    if (wait > 0) await sleep(wait);
    const res = await transport(url, headers);
    const rl = rateLimitWaitMs(res.headers, now());
    if (rl > 0) {
      waitUntil = now() + rl;
      log(`heroesprofile: rate limit reached; next request in ${Math.round(rl / 1000)} s`);
    }
    return res;
  }

  function fail(res: HpResponse, url: string): never {
    const e = envelope(res.body);
    const safe = url.replace(base, '');
    throw new HpError(`Heroes Profile ${safe} -> ${res.status}${e.code ? ` ${e.code}` : ''}${e.message ? `: ${e.message}` : ''}`, res.status, e.code);
  }

  function parse(res: HpResponse, url: string): unknown {
    try {
      return JSON.parse(res.body);
    } catch {
      throw new HpError(`Heroes Profile ${url.replace(base, '')} returned non-JSON (${res.body.slice(0, 80)})`, res.status, null);
    }
  }

  /** Follows a 202 job until it completes (polls are not billable). */
  async function awaitJob(first: HpResponse, url: string): Promise<HpResponse> {
    const started = now();
    let res = first;
    let target = url;
    for (let polls = 0; res.status === 202; polls++) {
      const location = res.headers.location;
      if (location) target = new URL(location, `${base}/`).toString();
      if (now() - started > maxJobMs) throw new HpError(`Heroes Profile job for ${url.replace(base, '')} did not finish within ${Math.round(maxJobMs / 60000)} min`, 202, 'job_timeout');
      const delay = Math.min(60_000, Math.max(1_000, retryAfterMs(res.headers['retry-after'], now()) ?? 10_000));
      if (polls === 0) log(`heroesprofile: ${url.replace(base, '')} accepted as a job; polling every ${Math.round(delay / 1000)} s`);
      await sleep(delay);
      res = await send(target);
    }
    return res;
  }

  return {
    get budget() {
      return budget;
    },
    get calls() {
      return calls;
    },
    async get(path, query = {}) {
      const u = new URL(`${base}/${path.replace(/^\/+/, '')}`);
      for (const [k, v] of Object.entries(query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        if (v !== undefined) u.searchParams.set(k, String(v));
      }
      const url = u.toString();
      for (let attempt = 0; ; attempt++) {
        if (calls >= budget) throw new HpBudgetError(budget);
        calls++;
        let res = await send(url);
        if (res.status === 202) res = await awaitJob(res, url);
        if (res.status === 429) {
          const ra = retryAfterMs(res.headers['retry-after'], now());
          // A 429 without Retry-After (or with a long one) reads as quota exhaustion: stop.
          if (attempt < 2 && ra !== null && ra <= maxRetryAfter) {
            calls--; // a throttled request was not served
            await sleep(ra);
            continue;
          }
          fail(res, url);
        }
        if (res.status >= 500 && attempt < 2) {
          calls--;
          await sleep(2_000 * (attempt + 1));
          continue;
        }
        if (res.status < 200 || res.status > 299) fail(res, url);
        return parse(res, url);
      }
    },
  };
}
