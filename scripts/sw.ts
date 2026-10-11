/**
 * Post-build: generate the offline service worker (dist/sw.js) with Workbox over the built site.
 *
 *   node scripts/sw.ts [--dist <dir>]      (default: $WHETSTONE_OUT_DIR, else dist/)
 *
 * Precaches only the hashed/static assets every visitor needs (scripts, styles, icons) and the
 * offline page. Pages, data and the large lazily created worker chunks are cached at runtime as
 * they are used, so the precache stays small even with hundreds of entity pages:
 *   navigations              -> NetworkFirst (fresh when online, last copy when offline, kept 7
 *                               days); a navigation that fails with no saved copy gets the
 *                               precached offline page (src/pages/offline.astro)
 *   /whetstone/data/**.json   -> StaleWhileRevalidate (draft/dex shards: instant, refreshed behind,
 *                               kept 7 days), except anything under a "_"-prefixed name: internal
 *                               shards such as the MTGA card index, which its worker keeps in
 *                               IndexedDB itself, and the _private/ shards that carry class-B/C
 *                               overlays (pipeline/stage.ts), which must never outlive a deploy
 *   _astro/*.worker-*.js      -> CacheFirst (content-hashed; only visitors of that tool download it)
 *   same-origin images       -> CacheFirst (portraits and icons are content-addressed per build tag)
 * Runtime cache names carry SW_CACHE_VERSION (src/components/offline.ts): on activation the worker
 * deletes every other `whetstone-*` cache it does not own, so bumping the version (or renaming a
 * cache) clears what older workers saved. Registered from Base.astro in production builds only.
 * Skips with a warning when the build is absent.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSW } from 'workbox-build';
import { OFFLINE_PATH, SW_CACHES, SW_CACHE_PREFIX } from '../src/components/offline.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** Must match `base` in astro.config.mjs. */
export const BASE = '/whetstone/';

/**
 * Left out of the precache: the service worker itself, data shards (versioned per deploy, some
 * large) and Web Worker chunks, which Vite names `<name>.worker-<hash>.js` and which pages create
 * only on first use (the Pokémon damage calc is ~500 KB, the MTGA analyzer ~170 KB).
 */
export const PRECACHE_IGNORES = ['sw.js', 'workbox-*.js', 'data/**', '_astro/*.worker-*.js'];

/**
 * Data shards under /whetstone/data/, except when any path segment starts with "_": internal
 * shards (`_cards.arena.<hash>.json`) and the class-B/C overlays staged under `_private/`.
 * Route patterns are RegExps, not functions: Workbox serialises them into sw.js, where a
 * function could not see module constants.
 */
export const DATA_ROUTE = /\/whetstone\/data\/(?:[^_/?#][^/?#]*\/)*[^_/?#][^/?#]*\.json$/;

/** The hashed Web Worker chunks left out of the precache. */
export const WORKER_ROUTE = /\/whetstone\/_astro\/[^/?#]+\.worker-[^/?#]+\.js$/;

/** Saved pages and data shards are dropped after this long (images keep 30 days). */
export const RUNTIME_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;

/**
 * Appended to the generated sw.js: on activation, delete every Whetstone cache this worker does
 * not use (older runtime cache versions, renamed caches). Workbox's own precache
 * (`whetstone-precache-…`) is left to cleanupOutdatedCaches.
 */
export function cleanupSnippet(keep: readonly string[] = Object.values(SW_CACHES)): string {
  const precache = `${SW_CACHE_PREFIX}precache`;
  return `
self.addEventListener('activate', (event) => {
  const keep = new Set(${JSON.stringify([...keep])});
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(
        names
          .filter((name) => name.startsWith(${JSON.stringify(SW_CACHE_PREFIX)}) && !name.startsWith(${JSON.stringify(precache)}) && !keep.has(name))
          .map((name) => caches.delete(name)),
      ),
    ),
  );
});
`;
}

export function resolveDist(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): string {
  const i = argv.indexOf('--dist');
  const fromArg = i >= 0 ? argv[i + 1] : undefined;
  return path.resolve(ROOT, fromArg ?? env.WHETSTONE_OUT_DIR ?? 'dist');
}

export interface SwResult {
  skipped: boolean;
  swDest: string;
  count: number;
  size: number;
  warnings: string[];
}

export async function buildServiceWorker(dist: string, opts: { quiet?: boolean } = {}): Promise<SwResult> {
  const swDest = path.join(dist, 'sw.js');
  if (!existsSync(path.join(dist, 'index.html'))) {
    console.warn(`[sw] No built site in ${dist}; skipping service worker. Run "astro build" first.`);
    return { skipped: true, swDest, count: 0, size: 0, warnings: [] };
  }

  // The offline page is precached under its directory URL, which is also what the navigation
  // fallback asks for; its revision is the page's content hash.
  const offlineHtml = path.join(dist, ...OFFLINE_PATH.split('/').filter(Boolean), 'index.html');
  const offlineUrl = `${BASE}${OFFLINE_PATH}`;
  const offlineEntry = existsSync(offlineHtml)
    ? [{ url: offlineUrl, revision: createHash('sha256').update(readFileSync(offlineHtml)).digest('hex').slice(0, 16) }]
    : [];

  const { count, size, warnings } = await generateSW({
    globDirectory: dist,
    globPatterns: ['**/*.{js,css,svg,webmanifest,woff2}', 'icons/*.png'],
    globIgnores: PRECACHE_IGNORES,
    swDest,
    modifyURLPrefix: { '': BASE },
    // Astro's _astro/ files carry a content hash in their names already.
    dontCacheBustURLsMatching: /_astro\//,
    additionalManifestEntries: offlineEntry,
    navigateFallback: null,
    cleanupOutdatedCaches: true,
    clientsClaim: true,
    skipWaiting: true,
    inlineWorkboxRuntime: true,
    sourcemap: false,
    mode: 'production',
    cacheId: 'whetstone',
    runtimeCaching: [
      {
        urlPattern: ({ request }) => request.mode === 'navigate',
        handler: 'NetworkFirst',
        options: {
          cacheName: SW_CACHES.pages,
          networkTimeoutSeconds: 4,
          expiration: { maxEntries: 80, maxAgeSeconds: RUNTIME_MAX_AGE_SECONDS },
          cacheableResponse: { statuses: [200] },
          ...(offlineEntry.length > 0 ? { precacheFallback: { fallbackURL: offlineUrl } } : {}),
        },
      },
      {
        urlPattern: DATA_ROUTE,
        handler: 'StaleWhileRevalidate',
        options: {
          cacheName: SW_CACHES.data,
          expiration: { maxEntries: 60, maxAgeSeconds: RUNTIME_MAX_AGE_SECONDS },
          cacheableResponse: { statuses: [200] },
        },
      },
      {
        urlPattern: WORKER_ROUTE,
        handler: 'CacheFirst',
        options: {
          cacheName: SW_CACHES.workers,
          expiration: { maxEntries: 8 },
          cacheableResponse: { statuses: [200] },
        },
      },
      {
        // Same-origin only: opaque cross-origin images (e.g. Scryfall) would bloat the quota.
        urlPattern: ({ request, sameOrigin }) => sameOrigin && request.destination === 'image',
        handler: 'CacheFirst',
        options: {
          cacheName: SW_CACHES.images,
          expiration: { maxEntries: 1500, maxAgeSeconds: 60 * 60 * 24 * 30 },
          cacheableResponse: { statuses: [200] },
        },
      },
    ],
  });

  appendFileSync(swDest, cleanupSnippet());

  if (!opts.quiet) {
    for (const warning of warnings) console.warn(`[sw] ${warning}`);
    console.log(`[sw] Wrote ${path.relative(ROOT, swDest) || swDest}: ${count} precached files, ${(size / 1024).toFixed(1)} KiB.`);
  }
  return { skipped: false, swDest, count, size, warnings };
}

const invokedDirectly = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  await buildServiceWorker(resolveDist(process.argv.slice(2)));
}
