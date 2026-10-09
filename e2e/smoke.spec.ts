/**
 * Site-wide smoke test. Data-driven so new routes are covered without editing this file:
 *   1. every global route and every nav entry of every game (from src/games/registry.ts),
 *   2. internal links found on those pages (depth 2 from home), sampled per URL pattern so
 *      hundreds of hero/card/Pokémon pages cost a few visits, not hundreds.
 * Each visited page must answer 200, render the shell, and log no console errors.
 *
 * Env: SMOKE_ALLOW_MISSING=1 skips (instead of failing) nav routes that 404, for building the
 * shell before the game pages exist. SMOKE_PER_PATTERN (default 2) sets the crawl sample size.
 */
import { expect, test, type Page } from '@playwright/test';
import { allNavRoutes, games, siteRoutes } from '../src/games/registry.ts';

const ALLOW_MISSING = process.env.SMOKE_ALLOW_MISSING === '1';
const PER_PATTERN = Number(process.env.SMOKE_PER_PATTERN ?? 2);
const BASE_PATH = '/whetstone/';

interface Watch {
  errors: string[];
}

/** Collect console errors, uncaught exceptions and failing same-origin subresources. */
function watch(page: Page): Watch {
  const w: Watch = { errors: [] };
  page.on('console', (msg) => {
    if (msg.type() === 'error') w.errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => w.errors.push(`pageerror: ${err.message}`));
  page.on('response', (res) => {
    const req = res.request();
    if (req.resourceType() === 'document') return;
    const url = new URL(res.url());
    if (url.pathname.startsWith(BASE_PATH) && url.hostname === 'localhost' && res.status() >= 400) {
      w.errors.push(`http ${res.status()}: ${url.pathname}`);
    }
  });
  return w;
}

async function expectShell(page: Page) {
  await expect(page.locator('header.site-header')).toBeVisible();
  await expect(page.locator('main#main')).toBeVisible();
  await expect(page.locator('footer.site-footer')).toBeVisible();
  await expect(page.locator('h1').first()).toBeVisible();
}

/** /whetstone/hots/hero/abathur/ -> /whetstone/hots/hero/*\/ ; one bucket per page template. */
function patternOf(pathname: string): string {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length <= 2) return pathname;
  return `/${[...parts.slice(0, -1), '*'].join('/')}/`;
}

async function internalLinks(page: Page): Promise<string[]> {
  const hrefs = await page.locator('a[href]').evaluateAll((els) => els.map((el) => (el as HTMLAnchorElement).href));
  const out = new Set<string>();
  for (const href of hrefs) {
    const url = new URL(href);
    if (url.hostname !== 'localhost' || !url.pathname.startsWith(BASE_PATH)) continue;
    // Only pages: skip files (data shards, images, feeds).
    if (/\.[a-z0-9]+$/i.test(url.pathname)) continue;
    out.add(url.pathname);
  }
  return [...out];
}

test.describe('home', () => {
  test('renders a card for every game', async ({ page }) => {
    const w = watch(page);
    const res = await page.goto('./');
    expect(res?.status()).toBe(200);
    await expectShell(page);
    await expect(page.locator('.game-card')).toHaveCount(games.length);
    for (const g of games) {
      await expect(page.locator('.game-card').filter({ hasText: g.name })).toBeVisible();
    }
    expect(w.errors).toEqual([]);
  });

  test('theme toggle flips the theme and remembers it', async ({ page }) => {
    await page.goto('./');
    const html = page.locator('html');
    const before = await html.getAttribute('data-theme');
    expect(before === 'dark' || before === 'light').toBe(true);
    const after = before === 'dark' ? 'light' : 'dark';

    await page.locator('[data-theme-toggle]').first().click();
    await expect(html).toHaveAttribute('data-theme', after);
    await expect(page.locator('[data-theme-toggle]').first()).toHaveAttribute('aria-pressed', String(after === 'dark'));

    await page.reload();
    await expect(html).toHaveAttribute('data-theme', after);
    expect(await page.evaluate(() => localStorage.getItem('whetstone:site:theme'))).toBe(after);
  });

  test('skip link is the first focus stop and targets main', async ({ page }) => {
    await page.goto('./');
    await page.keyboard.press('Tab');
    const skip = page.locator('a.skip-link');
    await expect(skip).toBeFocused();
    await expect(skip).toHaveAttribute('href', '#main');
  });

  test('footer carries every non-affiliation notice', async ({ page }) => {
    await page.goto('./');
    const footer = page.locator('footer.site-footer');
    for (const text of [
      'not affiliated',
      'Blizzard Entertainment',
      'Heroes of the Storm is a trademark of Blizzard Entertainment',
      'unofficial Fan Content permitted under the',
      'Not approved/endorsed by Wizards',
      '©Wizards of the Coast LLC',
      'The Pokémon Company',
      'heroescounters.com',
      'Heroes Profile',
    ]) {
      await expect(footer).toContainText(text);
    }
    await expect(footer.getByRole('link', { name: 'Credits' })).toHaveAttribute('href', `${BASE_PATH}credits/`);
    await expect(footer.getByRole('link', { name: 'Privacy' })).toHaveAttribute('href', `${BASE_PATH}privacy/`);
  });
});

test.describe('routes from the registry', () => {
  for (const route of allNavRoutes()) {
    test(`/${route} renders cleanly`, async ({ page }) => {
      const w = watch(page);
      const res = await page.goto(route || './');
      const status = res?.status() ?? 0;
      if (status === 404 && ALLOW_MISSING) {
        test.info().annotations.push({ type: 'missing-route', description: `/${route} not built yet` });
        test.skip(true, `/${route} is not built yet (SMOKE_ALLOW_MISSING=1)`);
      }
      expect(status, `HTTP status for /${route}`).toBe(200);
      await expectShell(page);
      expect(w.errors, `errors on /${route}`).toEqual([]);
    });
  }
});

test('pages stay within a 360 px viewport', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  const routes = [...siteRoutes, ...games.map((g) => `${g.id}/`)];
  for (const route of routes) {
    await page.goto(route || './');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect.soft(overflow, `horizontal overflow on /${route}`).toBeLessThanOrEqual(0);
  }
});

test('internal links two levels deep resolve (sampled per page template)', async ({ page }) => {
  test.setTimeout(180_000);
  const w = watch(page);
  const seeds = new Set(allNavRoutes().map((r) => `${BASE_PATH}${r}`));
  const discovered = new Set<string>();
  for (const seed of seeds) {
    const res = await page.goto(seed);
    if (!res || res.status() !== 200) continue;
    for (const link of await internalLinks(page)) if (!seeds.has(link)) discovered.add(link);
  }

  const byPattern = new Map<string, string[]>();
  for (const path of [...discovered].sort()) {
    const key = patternOf(path);
    const bucket = byPattern.get(key) ?? [];
    if (bucket.length < PER_PATTERN) bucket.push(path);
    byPattern.set(key, bucket);
  }

  for (const path of [...byPattern.values()].flat()) {
    w.errors.length = 0;
    const res = await page.goto(path);
    expect.soft(res?.status(), `HTTP status for ${path}`).toBe(200);
    expect.soft(w.errors, `errors on ${path}`).toEqual([]);
  }
});

test('unknown URLs get the 404 page', async ({ page }) => {
  const res = await page.goto('this-page-does-not-exist/');
  expect(res?.status()).toBe(404);
  await expect(page.locator('h1')).toContainText('Lost the edge');
  await expect(page.getByRole('link', { name: 'Home' })).toHaveAttribute('href', BASE_PATH);
});
