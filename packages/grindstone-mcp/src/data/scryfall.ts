import { USER_AGENT } from '../version.js';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const API = 'https://api.scryfall.com';

/**
 * Scryfall's published hard limits: 500 ms between calls to /cards/search, /cards/named,
 * /cards/random and /cards/collection; 100 ms for everything else. A 429 locks the client
 * out for 30 seconds, so a 429 waits that long before the single retry.
 */
const SLOW_PATHS = ['/cards/search', '/cards/named', '/cards/random', '/cards/collection'];
const RATE_LIMIT_LOCKOUT_MS = 30_000;

export interface ScryfallOptions {
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export class ScryfallError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class ScryfallClient {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private nextSlot = 0;

  constructor(opts: ScryfallOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  static headers(accept = 'application/json'): Record<string, string> {
    return { 'User-Agent': USER_AGENT, Accept: accept };
  }

  /** GET a JSON resource from api.scryfall.com, throttled and retried once on 429. */
  async getJson<T>(pathAndQuery: string): Promise<T> {
    const url = pathAndQuery.startsWith('http') ? pathAndQuery : `${API}${pathAndQuery}`;
    const gap = SLOW_PATHS.some((p) => new URL(url).pathname.startsWith(p)) ? 500 : 100;
    for (let attempt = 0; ; attempt++) {
      await this.throttle(gap);
      const res = await this.fetchImpl(url, { headers: ScryfallClient.headers() });
      if (res.status === 429 && attempt === 0) {
        this.nextSlot = this.now() + RATE_LIMIT_LOCKOUT_MS;
        continue;
      }
      const body = (await res.json().catch(() => null)) as { object?: string; details?: string } | null;
      if (!res.ok || body?.object === 'error') {
        throw new ScryfallError(body?.details ?? `Scryfall returned HTTP ${res.status}`, res.status);
      }
      return body as T;
    }
  }

  /** Download from a *.scryfall.io file origin (no rate limit there, headers still sent). */
  async download(url: string): Promise<Response> {
    const res = await this.fetchImpl(url, { headers: ScryfallClient.headers('*/*') });
    if (!res.ok || !res.body) throw new ScryfallError(`download failed: HTTP ${res.status}`, res.status);
    return res;
  }

  private async throttle(gapMs: number) {
    const wait = this.nextSlot - this.now();
    if (wait > 0) await this.sleep(wait);
    this.nextSlot = Math.max(this.now(), this.nextSlot) + gapMs;
  }
}
