// @ts-check
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import sitemap from '@astrojs/sitemap';
import { accentStylesheet } from './src/games/registry.ts';
import { redirectPaths } from './src/games/hots/redirects.ts';
import { pendingSections } from './src/lib/routes.ts';
import { checkDist } from './scripts/csp-check.ts';
import { INLINE_PACKAGES, SW_PACKAGES, installedPackage, packageOf, renderLicenses } from './scripts/licenses.ts';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const BASE = '/whetstone';

// Noindex pages stay out of the sitemap too: placeholders for unbuilt game sections, and the
// HotS slugs that only redirect (cho/gall → chogall, li-ming → liming, cursedhollow → cursed-hollow).
const noindexPaths = new Set([...pendingSections(ROOT).map((s) => `${BASE}/${s.game}/${s.section}/`), ...redirectPaths(BASE), `${BASE}/offline/`]);

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
  const guarded = ['src/lib/', 'pipeline/', 'scripts/'].map((p) => normalizeId(`${ROOT}${p}`));
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

/**
 * `virtual:whetstone/accents.css`: the per-game accent colours as CSS variables, generated from
 * src/games/registry.ts so tokens.css never lists games (Base.astro imports it).
 */
function accentStyles() {
  const id = 'virtual:whetstone/accents.css';
  const resolved = '\0whetstone-accents.css';
  return {
    name: 'whetstone:accents',
    /** @param {string} source */
    resolveId(source) {
      return source === id ? resolved : null;
    },
    /** @param {string} loaded */
    load(loaded) {
      return loaded === resolved ? accentStylesheet() : null;
    },
  };
}

/** @type {Map<string, import('./scripts/licenses.ts').PackageInfo>} Packages bundled for browsers (client and worker chunks). */
const shipped = new Map();

/**
 * Records which npm packages end up in browser chunks, for dist/licenses.txt. The page build uses
 * it for the client environment only; Web Worker bundles (the damage calc, the deck analyzer) are
 * separate builds that get their own instance through `vite.worker.plugins`.
 * @param {{ worker?: boolean }} [options]
 */
function licenseCollector(options = {}) {
  return {
    name: options.worker ? 'whetstone:license-collector-worker' : 'whetstone:license-collector',
    /** @param {{ name: string }} environment */
    applyToEnvironment(environment) {
      return options.worker === true || environment.name === 'client';
    },
    /** @param {unknown} _options @param {Record<string, { type: string, moduleIds?: string[], modules?: Record<string, unknown> }>} bundle */
    generateBundle(_options, bundle) {
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== 'chunk') continue;
        for (const id of chunk.moduleIds ?? Object.keys(chunk.modules ?? {})) {
          const info = packageOf(id, ROOT);
          if (info && !shipped.has(info.name)) shipped.set(info.name, info);
        }
      }
    },
  };
}

/** Writes dist/licenses.txt once the build is done (bundled packages, the service worker's Workbox runtime and Astro's inline island runtime). */
function licensesFile() {
  return {
    name: 'whetstone:licenses',
    hooks: {
      /** @param {{ dir: URL }} options */
      'astro:build:done': ({ dir }) => {
        const always = [...SW_PACKAGES, ...INLINE_PACKAGES].map((name) => installedPackage(name, ROOT)).filter((p) => p !== null);
        const text = renderLicenses([...shipped.values(), ...always]);
        writeFileSync(new URL('licenses.txt', dir), text);
      },
    },
  };
}

/**
 * Fails the build when a page has an inline script its CSP does not allow (or an inline event
 * handler): such a script would silently stop running in browsers (scripts/csp-check.ts).
 */
function cspGuard() {
  return {
    name: 'whetstone:csp-guard',
    hooks: {
      /** @param {{ dir: URL }} options */
      'astro:build:done': ({ dir }) => {
        const problems = checkDist(fileURLToPath(dir));
        if (problems.length > 0) {
          throw new Error(
            `[whetstone] ${problems.length} CSP problem(s); register constant inline scripts with allowInlineScript() (src/lib/csp.ts) ` +
              `or update CSP_SCRIPT_HASHES in astro.config.mjs:\n${problems.slice(0, 20).join('\n')}`,
          );
        }
      },
    },
  };
}

/*
 * Content-Security-Policy (SEC-4), written by Astro as a <meta> into every page (GitHub Pages
 * cannot send headers). Astro hashes the scripts and styles it bundles; the few constant inline
 * scripts register their own hashes (src/lib/csp.ts). Styles: Astro's own, PeriodToggle's
 * per-instance <style> and the style="" custom properties (accents, score rings) need inline
 * styles, which cannot run code. Images and frames only from this site and the hosts the pages
 * actually embed (Scryfall card images, YouTube and Twitch on click).
 */
/**
 * Extra script hashes for inline scripts that cannot register their own. Empty: every constant
 * inline script registers its hash with allowInlineScript() (src/lib/csp.ts), and cspGuard() fails
 * the build when one does not.
 * @type {readonly string[]}
 */
const CSP_SCRIPT_HASHES = [];

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
  integrations: [preact(), sitemap({ filter: (page) => !noindexPaths.has(new URL(page).pathname) }), licensesFile(), cspGuard()],
  security: {
    csp: {
      algorithm: 'SHA-256',
      directives: [
        "default-src 'self'",
        "img-src 'self' data: https://cards.scryfall.io",
        "connect-src 'self' https://api.scryfall.com",
        "frame-src https://www.youtube-nocookie.com https://player.twitch.tv",
        "worker-src 'self'",
        "manifest-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ],
      scriptDirective: {
        resources: ["'self'"],
        hashes: [...CSP_SCRIPT_HASHES],
      },
      styleDirective: {
        resources: [
          "'self'",
          { resource: "'self'", kind: 'element' },
          { resource: "'unsafe-inline'", kind: 'element' },
          { resource: "'unsafe-inline'", kind: 'attribute' },
        ],
      },
    },
  },
  vite: {
    plugins: [serverOnlyGuard(), accentStyles(), licenseCollector()],
    worker: {
      plugins: () => [licenseCollector({ worker: true })],
    },
  },
});
