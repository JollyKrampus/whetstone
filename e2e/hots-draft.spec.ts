/**
 * HotS draft helper and ARAM helper flows (SPEC §7) against the committed fixtures:
 * a full 16-step Storm League draft by clicking, Cho'gall step rules, share-link restore,
 * free mode, keyboard use, the ARAM ranking, a phone viewport and statistics mode.
 *
 * Statistics mode needs the class-B `stats` block in the draft shard. The statistics build
 * (WHETSTONE_FIXTURE_PRIVATE=1 npm run build, see e2e/hots-pages.spec.ts) gets it from
 * fixtures/hots/_private/public/draft.json, merged by pipeline/stage.ts as on the live site. Against
 * the default theory build, the statistics tests serve that same committed overlay merged into
 * the shard, so both builds cover the flow.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/** Mirrors e2e/hots-pages.spec.ts: which build is being served. */
const STATS = process.env.WHETSTONE_FIXTURE_PRIVATE === '1';

const DRAFT = 'hots/draft/';
const ARAM = 'hots/aram/';

function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('response', (res) => {
    if (res.status() >= 400 && new URL(res.url()).pathname.startsWith('/whetstone/')) errors.push(`http ${res.status()}: ${res.url()}`);
  });
  return errors;
}

async function ready(page: Page) {
  await expect(page.locator('.dt[data-ready="true"]')).toBeVisible();
}

const tile = (page: Page, id: string) => page.locator(`.dt-picker button[data-hero="${id}"]`);
const stepTitle = (page: Page) => page.locator('#dt-now-title');
const suggestionsText = (page: Page) => page.locator('.dt-now .sg-list').innerText();

async function choose(page: Page, id: string | null) {
  if (id === null) await page.getByRole('button', { name: 'Skip this ban' }).click();
  else await tile(page, id).click();
}

test.describe('Storm League draft', () => {
  test('a full 16-step draft by clicking, with suggestions changing after every step', async ({ page }) => {
    const errors = watch(page);
    await page.goto(DRAFT);
    await ready(page);
    await expect(stepTitle(page)).toHaveText('Your ban');
    await expect(page.locator('.dt-step__count')).toHaveText('Step 1 of 16');
    await expect(page.locator('.sg-basis')).toContainText(STATS ? 'Stats' : 'Theory');

    // A-ban B-ban A-ban B-ban A-pick B-pick(Cho'gall ×2) A-pick A-pick B-ban A-ban B-pick B-pick A-pick A-pick B-pick
    const plan: (string | null)[] = ['Abat', null, null, 'Diab', 'Mura', 'chogall', 'Malf', 'Wiza', null, 'Zera', 'Demo', 'Tra0', 'Vari', 'HXAL', 'Anub'];
    let before = await suggestionsText(page);
    for (const [i, id] of plan.entries()) {
      await choose(page, id);
      if (i < plan.length - 1) {
        const after = await suggestionsText(page);
        expect(after, `suggestions after decision ${i + 1}`).not.toBe(before);
        before = after;
      }
    }

    await expect(stepTitle(page)).toHaveText('Draft complete');
    await expect(page.locator('.dt-step__count')).toHaveText('All 16 steps done');
    const you = page.locator('.tp--a');
    const enemy = page.locator('.tp--b');
    for (const name of ['Muradin', 'Malfurion', 'Li-Ming', 'Varian', "Xal'atath"]) await expect(you.locator('.tp__picks')).toContainText(name);
    for (const name of ["Cho'gall", 'Valla', 'Tracer', "Anub'arak"]) await expect(enemy.locator('.tp__picks')).toContainText(name);
    await expect(you.locator('.tp__bans')).toContainText('Abathur');
    await expect(enemy.locator('.tp__bans')).toContainText('Diablo');
    await expect(you.locator('.tp__bans')).toContainText('Zeratul');
    await expect(enemy.locator('.tp__picks .tp-slot--filled')).toHaveCount(5);
    // Nothing is selectable any more, and the reason is visible on the tile.
    await expect(tile(page, 'Crus')).toHaveAttribute('aria-disabled', 'true');
    await expect(tile(page, 'Crus')).toContainText('Draft done');
    expect(new URL(page.url()).hash).toMatch(/^#v=1&s=[0-9a-z-]{30}$/);
    expect(errors).toEqual([]);
  });

  test("Cho'gall is only selectable where a team picks twice in a row", async ({ page }) => {
    const errors = watch(page);
    await page.goto(DRAFT);
    await ready(page);
    // Bans ignore the rule.
    await expect(tile(page, 'chogall')).not.toHaveAttribute('aria-disabled', 'true');
    for (let i = 0; i < 4; i++) await choose(page, null);
    // Step 5 (your single pick): not allowed, with a written reason.
    await expect(stepTitle(page)).toHaveText('Your pick');
    await expect(tile(page, 'chogall')).toHaveAttribute('aria-disabled', 'true');
    await expect(tile(page, 'chogall')).toContainText('Needs 2 picks');
    // aria-disabled tiles stay operable so they can explain themselves (force: Playwright treats them as disabled).
    await tile(page, 'chogall').click({ force: true });
    await expect(page.locator('#dt-pick-msg')).toContainText('6, 8, 12 or 14');
    await expect(page.locator('.tp--a .tp-slot--filled')).toHaveCount(0);
    await expect(page.locator('.dt-now .sg-list [data-hero="chogall"]')).toHaveCount(0);
    // Step 6 (enemy double pick): allowed and fills both slots.
    await choose(page, 'Mura');
    await expect(tile(page, 'chogall')).not.toHaveAttribute('aria-disabled', 'true');
    await choose(page, 'chogall');
    await expect(page.locator('.tp--b .tp__picks .tp-slot--filled')).toHaveCount(2);
    await expect(page.locator('.dt-step__count')).toHaveText('Step 8 of 16');
    expect(errors).toEqual([]);
  });

  test('picks from suggestions, undo, first-pick toggle and map choice', async ({ page }) => {
    const errors = watch(page);
    await page.goto(DRAFT);
    await ready(page);
    await page.locator('#dt-map').selectOption('cursed-hollow');
    await expect(page.locator('.sg-modes__chip', { hasText: 'Map' })).not.toHaveAttribute('aria-disabled', 'true');
    if (STATS) {
      await expect(page.locator('.sg-modes__chip', { hasText: 'Win rate' })).not.toHaveAttribute('aria-disabled', 'true');
    } else {
      // Stats-only modes are visibly disabled, with the reason in text.
      await expect(page.locator('.sg-modes__chip', { hasText: 'Win rate' })).toHaveAttribute('aria-disabled', 'true');
      await expect(page.locator('.sg-modes__why')).toContainText('need match statistics');
    }

    const first = page.locator('.dt-now .sg-item').first();
    const name = (await first.locator('.sg-item__name').innerText()).replace(/^Rank \d+:\s*/, '').trim();
    await first.getByRole('button', { name: `Ban ${name}` }).click();
    await expect(page.locator('.tp--a .tp__bans')).toContainText(name);
    await expect(stepTitle(page)).toBeFocused();

    // The breakdown opens on tap and explains the score.
    const why = page.locator('.dt-now .sg-item').first().locator('.sg-item__why');
    await expect(why).toHaveText('Why this score?');
    await why.click();
    await expect(why).toHaveAttribute('aria-expanded', 'true');
    await expect(why).toHaveText('Hide breakdown');
    await expect(page.locator('.sg-break').first()).toContainText('Total');

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.tp--a .tp__bans .tp-slot--filled')).toHaveCount(0);
    await expect(stepTitle(page)).toHaveText('Your ban');

    await page.locator('#dt-fp-label + .dt-seg').getByRole('button', { name: 'Enemy' }).click();
    await expect(stepTitle(page)).toHaveText('Enemy ban');
    await expect(page.locator('.tp--b .badge')).toHaveText('First pick');
    expect(new URL(page.url()).hash).toBe('#v=1&m=cursed-hollow&fp=b');
    expect(errors).toEqual([]);
  });

  test('the share link restores the same draft in a new page', async ({ page, context }) => {
    const errors = watch(page);
    await page.goto(DRAFT);
    await ready(page);
    await page.locator('#dt-map').selectOption('towers-of-doom');
    for (const id of ['Abat', null, 'Zera', null, 'Malf', 'chogall', 'Mura']) await choose(page, id);
    const url = page.url();
    expect(new URL(url).hash).toMatch(/^#v=1&m=towers-of-doom&s=/);
    const board = await page.locator('.dt-board').innerText();

    const other = await context.newPage();
    const otherErrors = watch(other);
    await other.goto(url);
    await ready(other);
    await expect(other.locator('#dt-map')).toHaveValue('towers-of-doom');
    await expect.poll(() => other.locator('.dt-board').innerText()).toBe(board);
    await expect(other.locator('.dt-step__count')).toHaveText('Step 9 of 16');

    // A doctored link keeps the longest legal prefix and says so.
    const bad = `${url.split('#')[0]}#v=1&s=${new URL(url).hash.match(/s=([0-9a-z-]+)/)![1]!.slice(0, 10)}${new URL(url).hash.match(/s=([0-9a-z-]+)/)![1]!.slice(8, 10)}`;
    await other.goto('about:blank');
    await other.goto(bad);
    await ready(other);
    await expect(other.locator('.dt-notice')).toContainText('Restored 5 of 6 steps');
    expect(errors).toEqual([]);
    expect(otherErrors).toEqual([]);
  });

  test('keyboard: search with Enter, arrows across the grid, explained disabled tiles', async ({ page }) => {
    const errors = watch(page);
    await page.goto(DRAFT);
    await ready(page);
    const search = page.locator('#dt-pick-search');
    await search.fill('xal');
    await search.press('Enter');
    await expect(page.locator('.tp--a .tp__bans')).toContainText("Xal'atath");
    await search.fill('');
    await search.press('ArrowDown');
    const focused = page.locator('.dt-picker button[data-hero]:focus');
    await expect(focused).toHaveAttribute('data-hero', 'Abat');
    // The next tile in the grid (Anub'arak in the fixtures, Alarak with live data).
    const next = page.locator('.dt-picker button[data-hero]').nth(1);
    const nextId = (await next.getAttribute('data-hero')) ?? '';
    const nextName = ((await next.getAttribute('aria-label')) ?? '').replace(/^\S+ /, '').split(',')[0] ?? '';
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.dt-picker button[data-hero]:focus')).toHaveAttribute('data-hero', nextId);
    await page.keyboard.press('Enter');
    await expect(page.locator('.tp--b .tp__bans')).toContainText(nextName);
    // Alias search: nicknames rank their hero first; a unique nickname finds only that hero.
    await search.fill('ming');
    await expect(page.locator('.dt-picker button[data-hero]').first()).toHaveAttribute('data-hero', 'Wiza');
    await search.fill('slapathur');
    await expect(page.locator('.dt-picker button[data-hero]')).toHaveCount(1);
    await expect(page.locator('.dt-picker button[data-hero]')).toHaveAttribute('data-hero', 'Abat');
    expect(errors).toEqual([]);
  });
});

test.describe('free mode', () => {
  test('adds heroes to either team in any order, removes them, and shares', async ({ page }) => {
    const errors = watch(page);
    await page.goto(DRAFT);
    await ready(page);
    await page.getByRole('button', { name: 'Free', exact: true }).click();
    await expect(stepTitle(page)).toHaveText('Your picks');
    await choose(page, 'Malf');
    await choose(page, 'chogall');
    await expect(page.locator('.tp--a .tp__picks .tp-slot--filled')).toHaveCount(3);
    // Choose the enemy's bans by tapping an empty slot.
    await page.locator('.tp--b .tp__bans button').first().click();
    await expect(stepTitle(page)).toHaveText('Enemy bans');
    await expect(page.locator('.dt-now h3')).toHaveText('Likely enemy bans');
    await choose(page, 'Zera');
    await expect(page.locator('.tp--b .tp__bans')).toContainText('Zeratul');
    await page.locator('.dt-targets').getByRole('button', { name: 'Enemy picks' }).click();
    await choose(page, 'Mura');
    await expect(tile(page, 'Mura')).toContainText('Enemy team');
    // Remove by tapping the placed hero.
    await page.getByRole('button', { name: "Remove Cho'gall from your team" }).first().click();
    await expect(page.locator('.tp--a .tp__picks .tp-slot--filled')).toHaveCount(1);
    const hash = new URL(page.url()).hash;
    expect(hash).toContain('mode=free');
    await page.reload();
    await ready(page);
    await expect(page.getByRole('button', { name: 'Free', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.tp--a .tp__picks')).toContainText('Malfurion');
    await expect(page.locator('.tp--b .tp__picks')).toContainText('Muradin');
    await expect(page.locator('.tp--b .tp__bans')).toContainText('Zeratul');
    expect(errors).toEqual([]);
  });
});

test.describe('pool filter', () => {
  test('suggests only owned, favourite and free heroes for your picks', async ({ page }) => {
    const errors = watch(page);
    await page.addInitScript(() => {
      localStorage.setItem('whetstone:hots:pool', JSON.stringify({ v: 1, d: { v: 1, owned: ['Zera'], favorites: ['xalatath'] } }));
    });
    await page.goto(`${DRAFT}#v=1&s=--------`);
    await ready(page);
    await expect(stepTitle(page)).toHaveText('Your pick');
    await page.locator('#dt-from').selectOption('pool');
    // With a short list there is no 'Show all' button; never wait for one.
    const showAll = page.getByRole('button', { name: /Show all/ });
    if ((await showAll.count()) > 0) await showAll.click();
    const ids = await page.locator('.dt-now .sg-item').evaluateAll((els) => els.map((el) => el.getAttribute('data-hero')));
    // Owned Zeratul, favourite Xal'atath, plus this week's free rotation (those tiles say "Free").
    const free = await page
      .locator('.dt-picker button[data-hero]')
      .evaluateAll((els) => els.filter((el) => /(^|, )Free(,|$)/.test(el.getAttribute('aria-label') ?? '')).map((el) => el.getAttribute('data-hero')));
    const allowed = new Set(['Zera', 'HXAL', ...free]);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(allowed.has(id!), `${id} is in the pool`).toBe(true);
    await expect(page.locator('.dt-now .sg-item[data-hero="HXAL"]')).toContainText('One of your favourites');
    await expect(tile(page, 'HXAL')).toHaveAttribute('aria-label', /Favourite/);
    expect(errors).toEqual([]);
  });
});

test.describe('ARAM helper', () => {
  test('ranks the offered heroes for your team', async ({ page }) => {
    const errors = watch(page);
    await page.goto(ARAM);
    await ready(page);
    const add = async (q: string) => {
      const search = page.locator('#ar-pick-search');
      await search.fill(q);
      await search.press('Enter');
    };
    for (const q of ['valla', 'tracer', 'malfurion']) await add(q);
    // After three options the helper moves on to teammates.
    await expect(page.locator('.dt-targets').getByRole('button', { name: /Teammates/ })).toHaveAttribute('aria-pressed', 'true');
    for (const q of ['muradin', 'li-ming', 'zeratul', 'xal']) await add(q);
    const items = page.locator('.ar-now .sg-item');
    await expect(items).toHaveCount(3);
    await expect(items.first()).toContainText('Malfurion');
    await expect(items.first()).toContainText('Best pick');
    await expect(items.nth(1)).toContainText('Leaves your team without a Healer');
    expect(new URL(page.url()).hash).toMatch(/^#v=1&o=[0-9a-z]{6}&a=[0-9a-z]{8}$/);

    // Mirror matches: an enemy can hold one of your options.
    await page.locator('.dt-targets').getByRole('button', { name: /Enemies/ }).click();
    await add('valla');
    await expect(page.locator('.ar-list--enemies')).toContainText('Valla');
    await page.reload();
    await ready(page);
    await expect(page.locator('.ar-now .sg-item').first()).toContainText('Malfurion');
    await expect(page.locator('.ar-list--enemies')).toContainText('Valla');
    expect(errors).toEqual([]);
  });
});

test.describe('phone viewport', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('step and suggestions come first, the picker below, no sideways scroll', async ({ page }) => {
    const errors = watch(page);
    await page.goto(DRAFT);
    await ready(page);
    const now = await page.locator('.dt-now').boundingBox();
    const board = await page.locator('.dt-board').boundingBox();
    const picker = await page.locator('.dt-picker').boundingBox();
    expect(now!.y).toBeLessThan(board!.y);
    expect(board!.y).toBeLessThan(picker!.y);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    // Drafting from the suggestions alone works on a phone.
    await page.locator('.dt-now .sg-item').first().locator('.sg-item__go').click();
    await expect(page.locator('.dt-step__count')).toHaveText('Step 2 of 16');
    await page.goto(ARAM);
    await ready(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect(errors).toEqual([]);
  });
});

/** In the theory build, serve the shard with the committed synthetic overlay, as stage.ts merges it. */
async function withStats(page: Page) {
  if (STATS) return;
  const read = (rel: string) => JSON.parse(readFileSync(rel, 'utf8')) as Record<string, unknown>;
  const merged = { ...read('fixtures/hots/public/draft.json'), ...read('fixtures/hots/_private/public/draft.json') };
  await page.route('**/data/hots/draft.*.json', (route) => route.fulfill({ json: merged }));
}

test.describe('statistics mode', () => {
  test('uses Heroes Profile numbers with an inline credit when the overlay is present', async ({ page }) => {
    const errors = watch(page);
    await withStats(page);
    await page.goto(`${DRAFT}#v=1&m=cursed-hollow&s=--------`);
    await ready(page);
    await expect(page.locator('.sg-basis')).toContainText('Stats');
    const credit = page.locator('.sg-credit[data-source="heroesprofile"]');
    await expect(credit).toContainText('Data provided by');
    await expect(credit.getByRole('link', { name: 'Heroes Profile' })).toHaveAttribute('href', 'https://www.heroesprofile.com');
    const winrate = page.locator('.sg-modes__chip', { hasText: 'Win rate' });
    await expect(winrate).not.toHaveAttribute('aria-disabled', 'true');
    await winrate.click();
    await expect(winrate).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.dt-now .sg-item').first().locator('.sg-reason--stat')).toContainText('win rate this patch');
    await expect(page.locator('.dt-now .sg-item').first().locator('.sg-reason__meta').first()).toContainText('n =');
    await expect(page.locator('.dt-now .sg-item').first().locator('.sg-reason__meta').first()).toContainText('Heroes Profile');
    expect(errors).toEqual([]);
  });

  test('the ARAM helper ignores Storm League statistics', async ({ page }) => {
    await withStats(page);
    await page.goto(`${ARAM}`);
    await ready(page);
    await page.locator('#ar-pick-search').fill('valla');
    await page.locator('#ar-pick-search').press('Enter');
    await expect(page.locator('.ar-now .sg-basis')).toContainText('Theory');
    await expect(page.locator('.sg-credit')).toHaveCount(0);
  });
});
