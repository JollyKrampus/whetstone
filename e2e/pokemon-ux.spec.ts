/**
 * Pokémon tools under poor conditions and on phones, against the production build (fixtures
 * data): text pasted before the builder hydrates is kept, a failed dex load explains itself and
 * retries, the calc and team preview do not shift the page while the dex loads, bars keep their
 * numbers readable at 360 px, regulation dates use one format, and speeds count Choice Scarf.
 * Run with SMOKE_PORT set to the port astro preview serves on.
 */
import { expect, test, type Page } from '@playwright/test';

/** Console errors and uncaught exceptions (failed requests a test provokes are left out). */
function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !/Failed to load resource/.test(msg.text())) errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  return errors;
}

async function hydrated(page: Page): Promise<void> {
  await page.waitForFunction(() => [...document.querySelectorAll('astro-island[client="load"]')].every((island) => !island.hasAttribute('ssr')));
}

const DEX = '**/data/pokemon/dex.*.json';

const PASTE = `Garchomp @ Life Orb
Ability: Rough Skin
EVs: 2 HP / 32 Atk / 32 Spe
Jolly Nature
- Earthquake`;

test.describe('slow and failed loads', () => {
  test('the builder keeps a paste typed before it hydrated', async ({ page }) => {
    const errors = watch(page);
    // Hold the island scripts back so the visitor gets to the server-rendered box first. Module
    // scripts are deferred, so DOMContentLoaded waits for them too: only wait for the response.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/_astro/*.js', async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto('pokemon/builder/', { waitUntil: 'commit' });
    await page.locator('#pk-paste').fill(PASTE);
    await page.locator('#pk-team-name').fill('Sand core');
    // Still the server HTML: nothing has hydrated yet.
    expect(await page.locator('astro-island[ssr]').count()).toBeGreaterThan(0);
    release();
    await hydrated(page);
    await expect(page.locator('.pk-builder[data-ready]')).toBeVisible();
    await expect(page.locator('#pk-paste')).toHaveValue(PASTE);
    await expect(page.locator('#pk-team-name')).toHaveValue('Sand core');
    const importButton = page.getByRole('button', { name: 'Import (replaces the team)' });
    await expect(importButton).toBeEnabled();
    await importButton.click();
    await expect(page.locator('#slot1-species')).toHaveValue('Garchomp');
    expect(errors).toEqual([]);
  });

  for (const [route, ready] of [
    ['pokemon/calc/', '.pk-calc[data-ready]'],
    ['pokemon/preview/', '.pk-tool[data-ready]'],
    ['pokemon/builder/', '.pk-builder[data-ready]'],
  ] as const) {
    test(`${route} explains a failed dex load and tries again`, async ({ page }) => {
      const errors = watch(page);
      let fail = true;
      await page.route(DEX, (r) => (fail ? r.abort('internetdisconnected') : r.continue()));
      await page.goto(route);
      const alert = page.getByRole('alert').filter({ hasText: 'The Champions Pokédex could not load' });
      await expect(alert).toBeVisible();
      await expect(alert).toContainText('Check your connection and try again.');
      fail = false;
      await alert.getByRole('button', { name: 'Try again' }).click();
      await expect(page.locator(ready)).toBeVisible();
      await expect(alert).toHaveCount(0);
      expect(errors).toEqual([]);
    });
  }

  for (const width of [375, 1280]) {
    for (const route of ['pokemon/calc/', 'pokemon/preview/']) {
      test(`${route} keeps its layout while the dex loads (${width} px)`, async ({ page }) => {
        await page.setViewportSize({ width, height: width < 768 ? 812 : 800 });
        await page.addInitScript(() => {
          const w = window as unknown as { __cls: number };
          w.__cls = 0;
          new PerformanceObserver((list) => {
            for (const e of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) if (!e.hadRecentInput) w.__cls += e.value;
          }).observe({ type: 'layout-shift', buffered: true });
        });
        await page.route(DEX, async (r) => {
          await new Promise((resolve) => setTimeout(resolve, 1200));
          await r.continue();
        });
        await page.goto(route);
        // The server frame already fills the first screen: no footer in view while loading.
        await expect(page.locator('[data-loading]')).toBeVisible();
        const footerTop = await page.evaluate(() => document.querySelector('footer')?.getBoundingClientRect().top ?? 0);
        expect(footerTop).toBeGreaterThan(page.viewportSize()!.height);
        if (route.includes('calc')) await expect(page.locator('.pk-result:not(.pk-result--pending)').first()).toBeVisible({ timeout: 20_000 });
        else await expect(page.locator('.pk-tool[data-ready]')).toBeVisible();
        await page.waitForTimeout(800);
        const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
        expect(cls).toBeLessThan(0.1);
      });
    }
  }
});

test.describe('readable numbers', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  test('usage and archetype bars wrap instead of cutting the win rate off', async ({ page }) => {
    await page.goto('pokemon/');
    const snapshot = page.locator('section[aria-labelledby="tour-h"]');
    const labels = snapshot.locator('.pk-bar__label');
    await expect(labels.first()).toBeVisible();
    const clipped = await labels.evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent));
    expect(clipped).toEqual([]);
    // "WR" stays on the same line as its number (no-break space) wherever the label wraps.
    const wr = await labels.evaluateAll((els) => els.map((e) => e.textContent ?? '').filter((t) => /WR/.test(t)));
    expect(wr.length).toBeGreaterThan(0);
    for (const text of wr) expect(text).toMatch(/WR\u00a0\d+(\.\d)?%/);
  });

  test('the regulation banner writes both dates the same way', async ({ page }) => {
    await page.goto('pokemon/');
    const day = String.raw`\d{1,2} [A-Z][a-z]{2} \d{4}, \d{2}:\d{2} UTC`;
    await expect(page.locator('.pk-reg__window')).toHaveText(new RegExp(String.raw`^\s*${day} to ${day}`));
  });

  test('the weakness matrix spells out neutral and ability cells for screen readers', async ({ page }) => {
    await page.goto('pokemon/builder/');
    await expect(page.locator('.pk-builder[data-ready]')).toBeVisible();
    await page.getByRole('button', { name: 'Start from the top six' }).click();
    const matrix = page.locator('.pk-matrix');
    await expect(matrix.locator('tbody tr')).toHaveCount(18);
    expect(await matrix.locator('span[aria-label]').count()).toBe(0);
    await expect(matrix.locator('.visually-hidden', { hasText: 'neutral' }).first()).toBeAttached();
  });
});

test.describe('speed in battle', () => {
  test('a Pokémon page compares its common set with the most used Pokémon', async ({ page }) => {
    await page.goto('pokemon/mon/rillaboom/');
    // #1 in usage at Speed 105: it outspeeds the slower ones among the most used, not 0 of the fastest.
    await expect(page.locator('[data-forme="rillaboom"] [data-speed-position]')).toHaveText(/^\s*At Speed 105, it outspeeds [1-9]\d* of the other \d+ Pokémon in the top \d+/);
    await page.goto('pokemon/mon/gholdengo/');
    await expect(page.locator('[data-forme="gholdengo"] [data-speed-position]')).toHaveText(/^\s*With Scarf \(Speed 223\), it outspeeds/);
  });

  test('team preview counts Choice Scarf on their common set', async ({ page }) => {
    await page.goto('pokemon/builder/');
    await expect(page.locator('.pk-builder[data-ready]')).toBeVisible();
    await page.getByRole('button', { name: 'Start from the top six' }).click();
    await page.getByRole('link', { name: 'Team preview →' }).click();
    await expect(page.locator('.pk-tool[data-ready]')).toBeVisible();
    for (const name of ['Gholdengo', 'Kingambit', 'Whimsicott', 'Archaludon']) {
      await page.locator('#pv-add-theirs').fill(name);
      await page.locator('#pv-add-theirs').press('Enter');
    }
    const theirs = page.locator('#pv-their-h ~ .pk-bars');
    await expect(theirs.getByText(/Gholdengo/)).toContainText('Speed 223 (Scarf)');
  });
});
