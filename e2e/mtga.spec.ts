/**
 * MTG Arena user flows against the built site (works with fixtures or live data): paste a deck
 * and get an analysis from the worker, share-link round trip with a seeded hand, upgrades with
 * undo, Limited table sorting and filters, card search with the card dialog, and saving a
 * meta list that the analyzer then compares against.
 */
import { expect, test, type Page } from '@playwright/test';

const DECK = `About
Name E2E Boros

Deck
4 Emberheart Challenger
4 Slickshot Show-Off
4 Voice of Victory
4 Inti, Seneschal of the Sun
4 Razorkin Needlehead
4 Hired Claw
2 Sunspine Lynx
4 Burst Lightning
4 Lightning Strike
4 Shock
2 Stroke of Midnight
4 Sacred Foundry
4 Inspiring Vantage
2 Sunbillow Verge
2 Elegant Parlor
6 Mountain
2 Plains

Sideboard
3 Abrade
2 Boltwave`;

const MONO_RED = `Deck
4 Hired Claw
4 Razorkin Needlehead
4 Emberheart Challenger
4 Slickshot Show-Off
4 Burst Lightning
4 Shock
4 Lightning Strike
4 Boltwave
2 Fear of Missing Out
2 Sunspine Lynx
24 Mountain`;

/** 1×1 PNG served in place of Scryfall card images, so the tests never depend on an outside host. */
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

test.beforeEach(async ({ context }) => {
  await context.route('https://cards.scryfall.io/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PIXEL }));
  await context.route('https://api.scryfall.com/**', (route) => route.fulfill({ status: 404, contentType: 'application/json', body: '{"object":"error"}' }));
});

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(e.message));
  return errors;
}

/** Islands render on the server first; wait until every one on the page has hydrated. */
async function ready(page: Page) {
  await expect(page.locator('astro-island[ssr]')).toHaveCount(0, { timeout: 15_000 });
}

async function analyze(page: Page, text: string) {
  await page.goto('mtga/deck/');
  await ready(page);
  await page.getByLabel('Arena export').fill(text);
  await page.getByRole('button', { name: 'Analyze deck' }).click();
  await expect(page.locator('#deck-summary-title')).toBeVisible({ timeout: 60_000 });
}

test.describe('MTGA deck analyzer', () => {
  test('a pasted deck gets the full analysis', async ({ page }) => {
    const errors = collectErrors(page);
    await analyze(page, DECK);
    await expect(page.locator('#deck-summary-title')).toHaveText('E2E Boros');
    const pills = page.getByRole('list', { name: 'Legality by format' }).getByRole('listitem');
    await expect(pills).toHaveCount(6);
    await expect(pills.first()).toContainText('Standard');
    await expect(page.locator('#deck-legality .legal__item')).toHaveCount(6);
    await expect(page.locator('#deck-power .power__name')).not.toBeEmpty();
    await expect(page.locator('#deck-power .dim')).toHaveCount(5);
    await expect(page.locator('#deck-curve .curve__col')).toHaveCount(8);
    await expect(page.locator('#deck-mana')).toContainText('Karsten');
    await expect(page.locator('#deck-list .role').first()).toBeVisible();
    await expect(page.locator('#deck-wildcards .wc__item')).toHaveCount(4);
    await expect(page.locator('#deck-hands .stats')).toContainText('Keepable seven');

    // Card names open the card dialog (no hover needed) and Escape closes it.
    await page.locator('#deck-list').getByRole('button', { name: 'Lightning Strike' }).click();
    const dialog = page.getByRole('dialog', { name: 'Lightning Strike' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Legal in');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Re-analyze in another format from the legality section.
    await page.locator('#deck-legality').getByRole('button', { name: 'Pioneer', exact: true }).click();
    await expect(page.locator('#deck-legality').getByRole('button', { name: 'Pioneer', exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: 60_000 });
    expect(errors).toEqual([]);
  });

  test('unknown names are reported with suggestions that fix the line', async ({ page }) => {
    await analyze(page, DECK.replace('4 Lightning Strike', '4 Lightnig Strike'));
    const notice = page.getByRole('note').filter({ hasText: 'not recognized' });
    await expect(notice).toContainText('Lightnig Strike');
    await notice.getByRole('button', { name: 'Lightning Strike' }).click();
    await expect(page.getByRole('note').filter({ hasText: 'not recognized' })).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByLabel('Arena export')).toHaveValue(/4 Lightning Strike/);
  });

  test('a share link reopens the same deck and the same sample hand', async ({ page, context }) => {
    await analyze(page, DECK);
    await page.getByRole('button', { name: 'Deal a hand' }).click();
    const hand = page.getByRole('list', { name: 'Opening hand' });
    await expect(hand.getByRole('listitem')).toHaveCount(7);
    const cards = await hand.locator('.handcards__name').allTextContents();
    await expect(page).toHaveURL(/#v=1&d=z[\w-]+.*&s=\d+/);
    const url = page.url();

    const other = await context.newPage();
    const errors = collectErrors(other);
    await other.goto(url);
    await expect(other.locator('#deck-summary-title')).toHaveText('E2E Boros', { timeout: 60_000 });
    await expect(other.getByLabel('Arena export')).toHaveValue(/4 Emberheart Challenger/);
    const again = other.getByRole('list', { name: 'Opening hand' });
    await expect(again.getByRole('listitem')).toHaveCount(7, { timeout: 30_000 });
    expect(await again.locator('.handcards__name').allTextContents()).toEqual(cards);
    expect(errors).toEqual([]);
  });

  test('upgrades can be applied and undone', async ({ page }) => {
    await analyze(page, MONO_RED);
    await page.getByRole('radio', { name: /Heavy/ }).check();
    await page.getByRole('button', { name: 'Suggest upgrades' }).click();
    const out = page.locator('.upg__out');
    await expect(out).toBeVisible({ timeout: 30_000 });
    const apply = out.getByRole('button', { name: /^Apply/ });
    if ((await apply.count()) === 0) {
      await expect(out).toContainText('No upgrade');
      return;
    }
    const before = await page.getByLabel('Arena export').inputValue();
    await apply.click();
    await expect(page.getByRole('button', { name: 'Undo upgrade' })).toBeVisible({ timeout: 60_000 });
    expect(await page.getByLabel('Arena export').inputValue()).not.toBe(before);
    await page.getByRole('button', { name: 'Undo upgrade' }).click();
    await expect(page.getByRole('button', { name: 'Undo upgrade' })).toHaveCount(0, { timeout: 60_000 });
    await expect(page.getByLabel('Arena export')).toHaveValue(/24 Mountain/);
  });
});

test.describe('MTGA meta lists', () => {
  test('a saved list is kept and the analyzer compares against it', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('mtga/meta/');
    await ready(page);
    await page.getByLabel('Deck name').fill('Mono-Red Test');
    await page.getByLabel(/Meta share/).fill('20');
    await page.getByLabel('Decklist (Arena export)').fill(MONO_RED);
    await page.getByRole('button', { name: 'Save list' }).click();
    const item = page.locator('.mlist').filter({ hasText: 'Mono-Red Test' });
    await expect(item).toBeVisible();
    await expect(item).toContainText('20.0% of the meta');
    await expect(item.locator('.mlist__check')).toContainText('60 cards', { timeout: 60_000 });

    await page.reload();
    await expect(page.locator('.mlist').filter({ hasText: 'Mono-Red Test' })).toBeVisible();

    await analyze(page, DECK);
    await expect(page.locator('#deck-meta .closest')).toContainText('Mono-Red Test');
    await expect(page.locator('#deck-power .badge--warning')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('MTGA Limited ratings', () => {
  test('17Lands credit sits at the top and the table sorts and filters', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('mtga/limited/');
    await expect(page.locator('[data-attribution="top"]')).toContainText('17Lands');
    // Wait for the set page itself: ready() on the index (which has no islands) would pass at
    // once and let the sort click below land on server HTML before the table hydrates.
    await Promise.all([page.waitForURL(/\/mtga\/limited\/[a-z0-9]+\/$/), page.locator('.lset__name a').first().click()]);
    await ready(page);
    await expect(page.locator('[data-attribution="top"]')).toContainText('CC BY 4.0');
    const table = page.locator('.ltable__table');
    await expect(table.locator('tbody tr').first()).toBeVisible();

    const gih = table.locator('thead th').filter({ hasText: 'GIH WR' }).first();
    await expect(gih).toHaveAttribute('aria-sort', 'descending');
    const values = async (col: number) =>
      (await table.locator(`tbody tr td:nth-child(${col})`).allTextContents()).map((t) => Number.parseFloat(t)).filter((n) => Number.isFinite(n));
    const desc = await values(2);
    expect(desc.length).toBeGreaterThan(2);
    expect(desc).toEqual([...desc].sort((a, b) => b - a));

    await gih.getByRole('button').click();
    await expect(gih).toHaveAttribute('aria-sort', 'ascending');
    const asc = await values(2);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    await expect(page).toHaveURL(/#v=1&d=asc/);

    // Sort by ATA (lower first) and keep only commons; the view survives a reload.
    await table.locator('thead th').filter({ hasText: 'ATA' }).getByRole('button').click();
    await page.getByRole('button', { name: 'Common', exact: true }).click();
    await expect(page).toHaveURL(/s=ata/);
    await page.reload();
    await ready(page);
    await expect(table.locator('thead th').filter({ hasText: 'ATA' })).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.getByRole('button', { name: 'Common', exact: true })).toHaveAttribute('aria-pressed', 'true');
    const rarities = await table.locator('tbody .ltable__rar').allTextContents();
    expect(rarities.length).toBeGreaterThan(0);
    expect(new Set(rarities.map((r) => r.trim()))).toEqual(new Set(['Common']));

    await table.locator('tbody .cardref').first().click();
    await expect(page.locator('dialog.peek[open]')).toContainText('GIH WR');
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
});

test.describe('MTGA card search', () => {
  test('a Scryfall-style query lists matching cards and opens one', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('mtga/search/');
    await ready(page);
    await page.getByLabel('Search Arena cards').fill('t:creature mv<=2 c:r');
    await page.locator('.csearch__form').getByRole('button', { name: 'Search', exact: true }).click();
    const count = page.locator('.csearch__count');
    await expect(count).toContainText(/cards?\./, { timeout: 60_000 });
    const types = await page.locator('.cgrid__type').allTextContents();
    expect(types.length).toBeGreaterThan(0);
    for (const t of types) expect(t).toContain('Creature');
    await expect(page).toHaveURL(/q=t%3Acreature/);

    await page.locator('.cgrid__btn').first().click();
    await expect(page.locator('dialog.peek[open] .peek__title')).not.toBeEmpty();
    await page.keyboard.press('Escape');

    await page.getByLabel('Search Arena cards').fill('mv<<<');
    await page.locator('.csearch__form').getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('note').filter({ hasText: 'could not be read' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
