/**
 * The pipeline's only door to the network (SPEC §4 `Http`). Polite by default: identifying
 * User-Agent, per-host spacing, bounded retries that honour Retry-After, timeouts. For
 * development it adds a disk cache (never in CI), an --offline mode that serves recorded
 * fixtures, and a record mode (WHETSTONE_RECORD=1) that writes those fixtures.
 *
 * Fixture lookup: src/games/<game>/fixtures/raw/<key>.<ext> where <key> is `init.fixture` or
 * `fixtureKey(url)` (first 16 hex of sha256 of the redacted URL) and <ext> is tried in the order
 * json/txt/bin depending on the call (`head()` uses <key>.head.json, an object of headers).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Http, HttpInit } from '../src/core/game.ts';
import { sha256, stableStringify } from './hash.ts';

export const USER_AGENT_BASE = 'Whetstone/0.1 (+https://github.com/JollyKrampus/whetstone)';

/** Query parameters whose values must never reach logs, cache keys or fixture names. */
const SECRET_PARAMS = new Set(['key', 'api_key', 'apikey', 'api_token', 'access_token', 'token', 'client_secret', 'password', 'secret', 'sig', 'signature']);

export function userAgent(contact?: string): string {
  const c = contact?.trim();
  return c ? `${USER_AGENT_BASE.slice(0, -1)}; ${c})` : USER_AGENT_BASE;
}

/** URL with secret query values replaced, safe for logs and stable across secret rotation. */
export function redactUrl(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return url;
  }
  let touched = false;
  for (const name of [...u.searchParams.keys()]) {
    if (SECRET_PARAMS.has(name.toLowerCase())) {
      u.searchParams.set(name, 'REDACTED');
      touched = true;
    }
  }
  if (u.username || u.password) {
    u.username = '';
    u.password = '';
    touched = true;
  }
  return touched ? u.toString() : url;
}

/** Default offline fixture key for a request. */
export function fixtureKey(url: string, method = 'GET'): string {
  const redacted = redactUrl(url);
  return sha256(method === 'GET' ? redacted : `${method} ${redacted}`).slice(0, 16);
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  /** First 300 characters of the response body, for diagnostics. */
  readonly bodySnippet: string;
  constructor(message: string, status: number, url: string, bodySnippet = '') {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.url = url;
    this.bodySnippet = bodySnippet;
  }
}

export class OfflineFixtureError extends Error {
  readonly expected: string[];
  constructor(message: string, expected: string[]) {
    super(message);
    this.name = 'OfflineFixtureError';
    this.expected = expected;
  }
}

export interface HttpOptions {
  game: string;
  /** Repo root; fixtures and the dev cache are resolved against it. */
  root: string;
  offline?: boolean;
  /** Save every successful response as a fixture (WHETSTONE_RECORD=1). */
  record?: boolean;
  /** Use the dev disk cache. Callers disable it in CI. */
  cache?: boolean;
  cacheDir?: string;
  fixturesDir?: string;
  /** Contact appended to the User-Agent (email or URL). */
  contact?: string;
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Give up instead of waiting when a server asks for a longer Retry-After than this. */
  maxRetryAfterMs?: number;
  timeoutMs?: number;
  spacingMs?: number;
  ttlHours?: number;
  /** Seed for backoff jitter, so retry timing is reproducible in tests. */
  seed?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (msg: string) => void;
}

type Kind = 'json' | 'text' | 'bytes' | 'head';

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

interface CacheMeta {
  url: string;
  method: string;
  status: number;
  headers: Record<string, string>;
  savedAt: number;
}

const FIXTURE_EXTS: Record<Kind, readonly string[]> = {
  json: ['json', 'txt', 'bin'],
  text: ['txt', 'json', 'bin'],
  bytes: ['bin', 'json', 'txt'],
  head: ['head.json'],
};

const FIXTURE_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$/;

/** mulberry32: tiny deterministic PRNG for jitter. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function lowerHeaders(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/** Retry-After in ms (delta-seconds or HTTP date), or null when absent/invalid. */
export function parseRetryAfter(value: string | undefined, nowMs: number): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status <= 599);
}

function decode(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8').decode(bytes);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function createHttp(options: HttpOptions): Http {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = options.now ?? Date.now;
  const log = options.log ?? (() => {});
  const random = prng(options.seed ?? 0x5eed);
  const retries = options.retries ?? 3;
  const baseDelay = options.baseDelayMs ?? 500;
  const maxDelay = options.maxDelayMs ?? 30_000;
  const maxRetryAfter = options.maxRetryAfterMs ?? 120_000;
  const fixturesDir = options.fixturesDir ?? path.join(options.root, 'src', 'games', options.game, 'fixtures', 'raw');
  const cacheDir = options.cacheDir ?? path.join(options.root, '.cache', 'http');
  const ua = userAgent(options.contact);

  const hostQueue = new Map<string, Promise<void>>();
  const hostLast = new Map<string, number>();

  /** Serialise request starts per host and keep at least `spacing` ms between them. */
  async function gate(host: string, spacing: number): Promise<void> {
    const previous = hostQueue.get(host) ?? Promise.resolve();
    let release: () => void = () => {};
    const mine = new Promise<void>((r) => {
      release = r;
    });
    hostQueue.set(host, previous.then(() => mine));
    await previous;
    try {
      const last = hostLast.get(host);
      const wait = last === undefined ? 0 : last + spacing - now();
      if (wait > 0) await sleep(wait);
      hostLast.set(host, now());
    } finally {
      release();
    }
  }

  function backoff(attempt: number): number {
    return Math.min(maxDelay, baseDelay * 2 ** attempt) + Math.floor(random() * baseDelay);
  }

  function fixtureCandidates(key: string, kind: Kind): string[] {
    if (!FIXTURE_KEY.test(key) || key.split('/').includes('..')) {
      throw new Error(`Invalid fixture key ${JSON.stringify(key)} (use letters, digits, . _ - and /)`);
    }
    const parts = key.split('/');
    const base = path.join(fixturesDir, ...parts);
    const exact = /\.(json|txt|bin)$/.test(key) ? [base] : [];
    return [...exact, ...FIXTURE_EXTS[kind].map((ext) => `${base}.${ext}`)];
  }

  function readFixture(method: string, url: string, key: string, kind: Kind): RawResponse {
    const candidates = fixtureCandidates(key, kind);
    const hit = candidates.find((p) => existsSync(p));
    if (!hit) {
      const rel = candidates.map((p) => path.relative(options.root, p).split(path.sep).join('/'));
      throw new OfflineFixtureError(
        `Offline fixture missing for ${method} ${redactUrl(url)}: expected ${rel[0]}. ` +
          `Record it with WHETSTONE_RECORD=1 node pipeline/run.ts --game ${options.game}, or pass { fixture } to name it.`,
        rel,
      );
    }
    const body = new Uint8Array(readFileSync(hit));
    if (kind === 'head') {
      const headers = JSON.parse(decode(body)) as Record<string, string>;
      const lower: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = String(v);
      return { status: 200, headers: lower, body: new Uint8Array() };
    }
    return { status: 200, headers: {}, body };
  }

  function writeFixture(key: string, kind: Kind, res: RawResponse): void {
    // An explicit extension in the key wins; otherwise use the preferred extension for the call.
    const target = fixtureCandidates(key, kind)[0] as string;
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, kind === 'head' ? stableStringify(res.headers, 2) + '\n' : res.body);
    log(`recorded fixture ${path.relative(options.root, target).split(path.sep).join('/')}`);
  }

  function cachePaths(method: string, url: string, body?: string): { meta: string; body: string } {
    const id = sha256(`${method} ${redactUrl(url)}${body === undefined ? '' : `\n${sha256(body)}`}`);
    return { meta: path.join(cacheDir, `${id}.json`), body: path.join(cacheDir, `${id}.body`) };
  }

  function readCache(p: { meta: string; body: string }): { meta: CacheMeta; body: Uint8Array } | null {
    try {
      if (!existsSync(p.meta) || !existsSync(p.body)) return null;
      return { meta: JSON.parse(readFileSync(p.meta, 'utf8')) as CacheMeta, body: new Uint8Array(readFileSync(p.body)) };
    } catch {
      return null;
    }
  }

  function writeCache(p: { meta: string; body: string }, meta: CacheMeta, body: Uint8Array): void {
    mkdirSync(path.dirname(p.meta), { recursive: true });
    writeFileSync(p.body, body);
    writeFileSync(p.meta, JSON.stringify(meta));
  }

  async function fetchOnce(method: string, url: string, headers: Record<string, string>, body: string | undefined, timeoutMs: number): Promise<RawResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs);
    try {
      const init: RequestInit = { method, headers, signal: controller.signal, redirect: 'follow' };
      if (body !== undefined) init.body = body;
      const res = await fetchImpl(url, init);
      // The body is read inside the timeout so a stalled download cannot hang the run.
      const bytes = method === 'HEAD' ? new Uint8Array() : new Uint8Array(await res.arrayBuffer());
      return { status: res.status, headers: lowerHeaders(res.headers), body: bytes };
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(kind: Kind, url: string, init: HttpInit = {}): Promise<RawResponse> {
    const method = kind === 'head' ? 'HEAD' : (init.method ?? 'GET').toUpperCase();
    const safeUrl = redactUrl(url);
    const key = init.fixture ?? fixtureKey(url, method);

    if (options.offline) return readFixture(method, url, key, kind);

    const cacheable = options.cache === true && (method === 'GET' || method === 'HEAD');
    const cp = cacheable ? cachePaths(method, url, init.body) : null;
    const cached = cp ? readCache(cp) : null;
    const ttlMs = (init.ttlHours ?? options.ttlHours ?? 12) * 3_600_000;
    if (cached && now() - cached.meta.savedAt < ttlMs) {
      const res = { status: cached.meta.status, headers: cached.meta.headers, body: cached.body };
      if (options.record) writeFixture(key, kind, res);
      return res;
    }

    const headers: Record<string, string> = { 'user-agent': ua };
    for (const [k, v] of Object.entries(init.headers ?? {})) headers[k.toLowerCase()] = v;
    // Revalidate an expired cache entry instead of downloading it again.
    if (cached?.meta.headers.etag) headers['if-none-match'] = cached.meta.headers.etag;
    else if (cached?.meta.headers['last-modified']) headers['if-modified-since'] = cached.meta.headers['last-modified'];

    const host = new URL(url).host;
    const spacing = init.spacingMs ?? options.spacingMs ?? 250;
    const timeoutMs = init.timeoutMs ?? options.timeoutMs ?? 30_000;

    let lastError = '';
    for (let attempt = 0; attempt <= retries; attempt++) {
      await gate(host, spacing);
      const started = now();
      let res: RawResponse;
      try {
        res = await fetchOnce(method, url, headers, init.body, timeoutMs);
      } catch (err) {
        lastError = err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err);
        if (attempt < retries) {
          const delay = backoff(attempt);
          log(`${method} ${safeUrl} failed (${lastError}); retry ${attempt + 1}/${retries} in ${delay} ms`);
          await sleep(delay);
          continue;
        }
        throw new HttpError(`${method} ${safeUrl} failed after ${attempt + 1} attempt(s): ${lastError}`, 0, safeUrl);
      }
      log(`${method} ${safeUrl} -> ${res.status} (${now() - started} ms)`);

      if (res.status === 304 && cached && cp) {
        const meta = { ...cached.meta, savedAt: now() };
        writeCache(cp, meta, cached.body);
        const out = { status: cached.meta.status, headers: cached.meta.headers, body: cached.body };
        if (options.record) writeFixture(key, kind, out);
        return out;
      }
      if (isRetryableStatus(res.status)) {
        lastError = `HTTP ${res.status}`;
        const retryAfter = parseRetryAfter(res.headers['retry-after'], now());
        if (attempt < retries && (retryAfter === null || retryAfter <= maxRetryAfter)) {
          const delay = retryAfter ?? backoff(attempt);
          log(`${method} ${safeUrl} -> ${res.status}; retry ${attempt + 1}/${retries} in ${delay} ms`);
          await sleep(delay);
          continue;
        }
        throw new HttpError(`${method} ${safeUrl} -> ${res.status} after ${attempt + 1} attempt(s)`, res.status, safeUrl, decode(res.body).slice(0, 300));
      }
      if (res.status < 200 || res.status > 299) {
        throw new HttpError(`${method} ${safeUrl} -> ${res.status}`, res.status, safeUrl, decode(res.body).slice(0, 300));
      }
      // 202 (async job accepted) and other non-200 successes are not stable enough to cache.
      if (cp && res.status === 200) {
        writeCache(cp, { url: safeUrl, method, status: res.status, headers: res.headers, savedAt: now() }, res.body);
      }
      if (options.record && res.status === 200) writeFixture(key, kind, res);
      return res;
    }
    throw new HttpError(`${method} ${safeUrl} failed: ${lastError}`, 0, safeUrl);
  }

  return {
    async json<T = unknown>(url: string, init?: HttpInit): Promise<T> {
      const res = await request('json', url, { ...init, headers: { accept: 'application/json', ...init?.headers } });
      const text = decode(res.body);
      try {
        return JSON.parse(text) as T;
      } catch (err) {
        throw new Error(`${redactUrl(url)} did not return valid JSON (${(err as Error).message}); starts with ${JSON.stringify(text.slice(0, 120))}`, { cause: err });
      }
    },
    async text(url: string, init?: HttpInit): Promise<string> {
      return decode((await request('text', url, init)).body);
    },
    async bytes(url: string, init?: HttpInit): Promise<Uint8Array> {
      return (await request('bytes', url, init)).body;
    },
    async head(url: string, init?: HttpInit): Promise<Record<string, string>> {
      return (await request('head', url, init)).headers;
    },
  };
}
