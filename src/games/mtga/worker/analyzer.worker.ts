/**
 * Web Worker entry for the MTGA analyzer. Loads card shards (IndexedDB first, then the network
 * with download progress), answers protocol requests through handler.ts, and offers the
 * optional Scryfall fuzzy-name fallback (api.scryfall.com, only when a request asks for it:
 * at most 2 requests per second, a 30-second pause after a 429, answers cached per session).
 */
import { Engine, EngineError, type ShardData } from './engine.ts';
import { readShard, writeShard } from './cache.ts';
import { createHandler } from './handler.ts';
import type { Pool, ShardUrls, WorkerMessage, WorkerRequest } from './protocol.ts';

interface WorkerScope {
  postMessage(message: WorkerMessage): void;
  addEventListener(type: 'message', listener: (event: MessageEvent<WorkerRequest>) => void): void;
}
const scope = globalThis as unknown as WorkerScope;
const post = (m: WorkerMessage) => scope.postMessage(m);

let urls: ShardUrls | null = null;
let snapshot = '';
let lastFromCache = false;

/**
 * The shards are cached in IndexedDB (cache.ts). The site's service worker would otherwise keep a
 * second multi-megabyte copy and re-download it in the background on every use
 * (stale-while-revalidate on /data/*.json), so the request carries a query string its data
 * route does not match.
 */
export function networkUrl(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}via=worker`;
}

async function download(pool: Pool, url: string): Promise<string> {
  const res = await fetch(networkUrl(url), { credentials: 'same-origin' });
  if (!res.ok) throw new EngineError('fetch_failed', `Could not load the ${pool === 'arena' ? 'full Arena' : 'Standard'} card data (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || undefined;
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastReport = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    const now = Date.now();
    if (now - lastReport > 150) {
      lastReport = now;
      // content-length is the compressed size when the server gzips; then only "loaded" is meaningful.
      post({ type: 'progress', stage: 'download', pool, loaded, ...(total && total >= loaded ? { total } : {}) });
    }
  }
  const all = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

async function loadShard(pool: Pool): Promise<ShardData> {
  if (!urls) throw new EngineError('not_ready', 'The analyzer has not been initialised.');
  const url = urls[pool];
  let text = await readShard(pool, url, snapshot);
  lastFromCache = text !== null;
  if (text !== null) post({ type: 'progress', stage: 'cache', pool });
  else {
    post({ type: 'progress', stage: 'download', pool, loaded: 0 });
    text = await download(pool, url);
    void writeShard({ pool, url, snapshot, text, savedAt: Date.now() });
  }
  post({ type: 'progress', stage: 'index', pool });
  const data = JSON.parse(text) as ShardData;
  if (!data || !Array.isArray(data.cards) || !data.meta) throw new EngineError('bad_data', 'The card data file is damaged. Reload the page to try again.');
  return data;
}

// ---- optional Scryfall fuzzy lookup ------------------------------------------------------

const SCRYFALL_NAMED = 'https://api.scryfall.com/cards/named?fuzzy=';
const fuzzyCache = new Map<string, string | undefined>();
let nextSlot = 0;
let pausedUntil = 0;
let lookups = 0;
const MAX_LOOKUPS_PER_SESSION = 60;

async function fuzzy(name: string): Promise<string | undefined> {
  const key = name.trim().toLowerCase();
  if (fuzzyCache.has(key)) return fuzzyCache.get(key);
  const now = Date.now();
  if (now < pausedUntil || lookups >= MAX_LOOKUPS_PER_SESSION) return undefined;
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + 500;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lookups++;
  try {
    // Only the CORS-safelisted Accept header: no preflight, and the browser's own User-Agent.
    const res = await fetch(SCRYFALL_NAMED + encodeURIComponent(name), { headers: { Accept: 'application/json' }, credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (res.status === 429) {
      pausedUntil = Date.now() + 30_000;
      return undefined;
    }
    const id = res.ok ? ((await res.json()) as { oracle_id?: unknown }).oracle_id : undefined;
    const value = typeof id === 'string' ? id : undefined;
    fuzzyCache.set(key, value);
    return value;
  } catch {
    return undefined;
  }
}

const engine = new Engine(loadShard, { fuzzy });
const handle = createHandler({
  engine,
  post,
  configure: (req) => {
    urls = req.shards;
    snapshot = req.snapshot;
  },
  cached: () => lastFromCache,
});

scope.addEventListener('message', (event) => {
  void handle(event.data);
});
