/**
 * Post-build: generate the offline service worker (dist/sw.js) with Workbox over the built site.
 *
 *   node scripts/sw.ts [--dist <dir>]      (default: $WHETSTONE_OUT_DIR, else dist/)
 *
 * Precaches only the hashed/static assets every visitor needs (scripts, styles, icons). Pages,
 * data and the large lazily created worker chunks are cached at runtime as they are used, so the
 * precache stays small even with hundreds of entity pages:
 *   navigations              -> NetworkFirst (fresh when online, last copy when offline)
 *   /whetstone/data/**.json   -> StaleWhileRevalidate (draft/dex shards: instant, refreshed behind),
 *                               except internal "_"-prefixed shards such as the MTGA card index,
 *                               which its worker keeps in IndexedDB itself (no second copy)
 *   _astro/*.worker-*.js      -> CacheFirst (content-hashed; only visitors of that tool download it)
 *   same-origin images       -> CacheFirst (portraits and icons are content-addressed per build tag)
 * Registered from Base.astro in production builds only. Skips with a warning when the build is absent.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSW } from 'workbox-build';

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
 * Data shards under /whetstone/data/, except internal shards whose file name starts with "_".
 * Route patterns are RegExps, not functions: Workbox serialises them into sw.js, where a
 * function could not see module constants.
 */
export const DATA_ROUTE = /\/whetstone\/data\/(?:[^?#]*\/)?[^_/?#][^/?#]*\.json$/;

/** The hashed Web Worker chunks left out of the precache. */
export const WORKER_ROUTE = /\/whetstone\/_astro\/[^/?#]+\.worker-[^/?#]+\.js$/;

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

  const { count, size, warnings } = await generateSW({
    globDirectory: dist,
    globPatterns: ['**/*.{js,css,svg,webmanifest,woff2}', 'icons/*.png'],
    globIgnores: PRECACHE_IGNORES,
    swDest,
    modifyURLPrefix: { '': BASE },
    // Astro's _astro/ files carry a content hash in their names already.
    dontCacheBustURLsMatching: /_astro\//,
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
          cacheName: 'whetstone-pages',
          networkTimeoutSeconds: 4,
          expiration: { maxEntries: 80 },
          cacheableResponse: { statuses: [200] },
        },
      },
      {
        urlPattern: DATA_ROUTE,
        handler: 'StaleWhileRevalidate',
        options: {
          cacheName: 'whetstone-data',
          expiration: { maxEntries: 60 },
          cacheableResponse: { statuses: [200] },
        },
      },
      {
        urlPattern: WORKER_ROUTE,
        handler: 'CacheFirst',
        options: {
          cacheName: 'whetstone-workers',
          expiration: { maxEntries: 8 },
          cacheableResponse: { statuses: [200] },
        },
      },
      {
        // Same-origin only: opaque cross-origin images (e.g. Scryfall) would bloat the quota.
        urlPattern: ({ request, sameOrigin }) => sameOrigin && request.destination === 'image',
        handler: 'CacheFirst',
        options: {
          cacheName: 'whetstone-images',
          expiration: { maxEntries: 1500, maxAgeSeconds: 60 * 60 * 24 * 30 },
          cacheableResponse: { statuses: [200] },
        },
      },
    ],
  });

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
