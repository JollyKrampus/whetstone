// @ts-check
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';
import { pendingSections } from './src/lib/routes.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const BASE = '/whetstone';

// Placeholder pages for unbuilt game sections are noindex, so keep them out of the sitemap too.
const placeholderPaths = new Set(pendingSections(ROOT).map((s) => `${BASE}/${s.game}/${s.section}/`));

/** Lower-cased on Windows so drive-letter casing differences in module ids don't defeat the check. */
function normalizeId(id) {
  const clean = id.split('?')[0].replace(/\\/g, '/');
  return process.platform === 'win32' ? clean.toLowerCase() : clean;
}

/**
 * Node-only code (fs-backed data readers under src/lib/, the pipeline) must never be bundled
 * for the browser: it would either crash at runtime or leak build-machine paths and private
 * class-B data. Fail the client build loudly instead of shipping it.
 */
function serverOnlyGuard() {
  const guarded = ['src/lib/', 'pipeline/'].map((p) => normalizeId(`${ROOT}${p}`));
  return {
    name: 'whetstone:server-only-guard',
    enforce: /** @type {const} */ ('pre'),
    /** @param {{ name: string }} environment */
    applyToEnvironment(environment) {
      return environment.name === 'client';
    },
    /** @param {string} id */
    load(id) {
      const file = normalizeId(id);
      if (guarded.some((prefix) => file.startsWith(prefix))) {
        throw new Error(
          `[whetstone] ${id} is Node-only and was pulled into a client bundle. ` +
            'Read data in .astro frontmatter (or src/games/<game>/load.ts) and pass plain props to islands.',
        );
      }
      return null;
    },
  };
}

export default defineConfig({
  site: 'https://jollykrampus.github.io',
  base: BASE,
  // GitHub Pages 301s slashless directory URLs, so every emitted link ends in '/'.
  trailingSlash: 'always',
  build: { format: 'directory' },
  output: 'static',
  // Lets tooling build into a scratch directory without clobbering dist/ (astro preview has no --outDir flag).
  outDir: process.env.WHETSTONE_OUT_DIR || './dist',
  // Astro 7 defaults to JSX whitespace rules, which silently glue inline elements together
  // ("2.57·updated"). HTML-aware compression keeps authored spacing predictable.
  compressHTML: true,
  integrations: [preact(), sitemap({ filter: (page) => !placeholderPaths.has(new URL(page).pathname) })],
  vite: {
    plugins: [serverOnlyGuard()],
  },
});
