// Placeholder so a build that skipped `node scripts/sw.ts` still registers cleanly.
// scripts/sw.ts overwrites this file with the real Workbox service worker after `astro build`.
// If this stub ever ships, it takes over from an older worker and clears only Whetstone's caches
// (other projects on the same github.io origin keep theirs).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  const scope = self.registration.scope;
  event.waitUntil(
    caches
      .keys()
      .then((keys) => keys.filter((key) => key.startsWith('whetstone-') || key.includes(scope)))
      .then((keys) => Promise.all(keys.map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});
