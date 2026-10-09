/**
 * Fails the run when the server on SMOKE_PORT is not serving the build under test.
 *
 * `astro preview --port N` quietly moves to the next free port when N is taken, and a server left
 * running from another checkout answers on the same URL. Either way the suite would pass or fail
 * against someone else's build. The webServer is started before this runs, so compare the home
 * page it serves with the index.html of the build we mean to test (dist/, or $WHETSTONE_OUT_DIR).
 * Every build embeds hashed asset names and its data stamp in that page, so two builds differ.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FullConfig } from '@playwright/test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export default async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) throw new Error('[e2e] playwright.config.ts has no baseURL');
  const outDir = path.resolve(ROOT, process.env.WHETSTONE_OUT_DIR || 'dist');
  const indexFile = path.join(outDir, 'index.html');
  if (!existsSync(indexFile)) throw new Error(`[e2e] No build at ${outDir}: run "npm run build" first.`);

  let served: string;
  try {
    const res = await fetch(baseURL);
    served = await res.text();
  } catch (err) {
    throw new Error(`[e2e] Nothing answers at ${baseURL}: ${(err as Error).message}`, { cause: err });
  }
  if (served !== readFileSync(indexFile, 'utf8')) {
    throw new Error(
      `[e2e] ${baseURL} is not serving ${outDir}. Another server probably holds the port ` +
        '(a stale "astro preview" from another checkout?). Stop it or pick a free SMOKE_PORT.',
    );
  }
}
