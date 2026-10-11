/**
 * Service-worker cache names and the offline fallback page, shared by scripts/sw.ts (which
 * generates sw.js) and src/pages/offline.astro (which lists the saved pages). Browser-safe.
 *
 * Bump SW_CACHE_VERSION to drop every runtime cache on the next visit: the new worker deletes any
 * `whetstone-*` cache whose name is not in SW_CACHES (precaches are cleaned by Workbox itself).
 */
export const SW_CACHE_VERSION = 2;

export const SW_CACHES = {
  pages: `whetstone-pages-v${SW_CACHE_VERSION}`,
  data: `whetstone-data-v${SW_CACHE_VERSION}`,
  workers: `whetstone-workers-v${SW_CACHE_VERSION}`,
  images: `whetstone-images-v${SW_CACHE_VERSION}`,
} as const;

/** Prefix of every cache the site creates (runtime caches and Workbox's `whetstone-precache-…`). */
export const SW_CACHE_PREFIX = 'whetstone-';

/** Base-relative path of the page served when a navigation fails offline. */
export const OFFLINE_PATH = 'offline/';
