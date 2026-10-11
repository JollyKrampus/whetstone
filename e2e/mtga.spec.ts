/**
 * MTG Arena user flows against the built site (works with fixtures or live data): paste a deck
 * and get an analysis from the worker (text pasted before hydration is kept), share-link round
 * trip with a seeded hand, upgrades with undo, the curated meta comparison, Limited table sorting
 * and filters, card search with the card dialog, and saving a meta list that the analyzer then
 * compares against. With WHETSTONE_FIXTURES=1 the fixture facts (paper prices, curated lists) are
 * asserted exactly; a live-data build checks the same flows where its data allows.
 */
import { expect, test, type Page } from '@playwright/test';

const FIXTURES = process.env.WHETSTONE_FIXTURES === '1';

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
    if (FIXTURES) await expect(dialog).toContainText(/Paper price\s*about \$\d/);
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    // Paper (USD) prices sit next to the wildcard counts when the card data has them.
    if (FIXTURES) {
      await expect(page.locator('#deck-wildcards .wc__usd')).toHaveCount(4);
      await expect(page.locator('#deck-wildcards')).toContainText(/Paper price of the same copies: about \$\d/);
    }

    // Re-analyze in another format from the legality section.
    await page.locator('#deck-legality').getByRole('button', { name: 'Pioneer', exact: true }).click();
    await expect(page.locator('#deck-legality').getByRole('button', { name: 'Pioneer', exact: true })).toHaveAttribute('aria-pressed', 'true', { timeout: 60_000 });
    expect(errors).toEqual([]);
  });

  test('text pasted before the analyzer loads is kept, and Analyze waits until it works', async ({ page }) => {
    // Hold the island scripts back, so the server-rendered form is all the visitor has.
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/_astro/*.js', async (route) => {
      await gate;
      await route.continue();
    });
    await page.goto('mtga/deck/', { waitUntil: 'domcontentloaded' });
    const box = page.getByLabel('Arena export');
    await box.fill(MONO_RED);
    await expect(page.getByRole('button', { name: 'Analyze deck' })).toBeDisabled();
    await expect(page.locator('#paste-loading')).toContainText('Loading the analyzer');
    release();
    await ready(page);
    await expect(box).toHaveValue(/24 Mountain/);
    await expect(page.locator('#paste-loading')).toHaveCount(0);
    await page.getByRole('button', { name: 'Analyze deck' }).click();
    await expect(page.locator('#deck-summary-title')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel('Arena export')).toHaveValue(/4 Hired Claw/);
  });

  test('the analyzer compares with the curated meta lists by default', async ({ page }) => {
    await page.goto('mtga/meta/');
    const curated = page.locator('.cdeck');
    test.skip(!FIXTURES && (await page.locator('.cmeta .badge', { hasText: 'example only' }).count()) > 0, 'this build has example lists only');
    await expect(curated.first()).toBeVisible();
    // Every curated list links to where it was published.
    await expect(curated.first().getByRole('link', { name: /Source/ })).toHaveAttribute('href', /^https:\/\/(?:www\.)?magic\.gg\//);
    await analyze(page, DECK);
    await expect(page.locator('#deck-meta .dsec__meta')).toContainText('Curated Standard lists');
    await expect(page.locator('#deck-meta .closest')).toBeVisible();
    await expect(page.locator('#deck-power .badge--warning')).toHaveCount(0);
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
    await page.getByRole('radio', { name: /Most competitive/ }).check();
    await page.getByRole('radio', { name: /Heavy/ }).check();
    await page.getByRole('button', { name: 'Suggest upgrades' }).click();
    const out = page.locator('.upg__out');
    await expect(out).toBeVisible({ timeout: 30_000 });
    const apply = out.getByRole('button', { name: /^Apply/ });
    if ((await out.locator('.swap').count()) === 0) {
      await expect(out).toContainText('No upgrade');
      return;
    }
    // Estimates without meta lists start unticked; tick every swap before applying.
    for (const box of await out.locator('.swap__pick input').all()) await box.check();
    await expect(apply).toHaveText(/Apply all swaps/);
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
    // Low-sample rows (fewer than 500 games in hand) come after all others while a win rate sorts.
    const values = async (col: number) =>
      (await table.locator(`tbody tr:not(.is-low) td:nth-child(${col})`).allTextContents()).map((t) => Number.parseFloat(t)).filter((n) => Number.isFinite(n));
    const lowLast = async () => {
      const low = await table.locator('tbody tr').evaluateAll((rows) => rows.map((r) => r.classList.contains('is-low')));
      expect(low.slice(low.indexOf(true) < 0 ? low.length : low.indexOf(true))).not.toContain(false);
    };
    const desc = await values(2);
    expect(desc.length).toBeGreaterThan(2);
    expect(desc).toEqual([...desc].sort((a, b) => b - a));
    await lowLast();
    await expect(page.locator('.ltable__note')).toContainText('listed after the others');

    await gih.getByRole('button').click();
    await expect(gih).toHaveAttribute('aria-sort', 'ascending');
    const asc = await values(2);
    expect(asc).toEqual([...asc].sort((a, b) => a - b));
    await lowLast();
    // Colour pips are announced as an image with the colour names.
    await expect(table.locator('tbody .pips').first()).toHaveAttribute('role', 'img');
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
    // Modal dialogs are centred (global.css restores the UA's margin: auto after the reset).
    const box = await page.locator('dialog.peek[open]').boundingBox();
    const width = page.viewportSize()?.width ?? 0;
    expect(Math.abs((box?.x ?? 0) + (box?.width ?? 0) / 2 - width / 2)).toBeLessThan(2);
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

    // A card banned in Standard says so on its own line, never under "Legal in".
    await page.getByLabel('Search Arena cards').fill('heartfire');
    await page.locator('.csearch__form').getByRole('button', { name: 'Search', exact: true }).click();
    await page.locator('.cgrid__btn', { hasText: 'Heartfire Hero' }).first().click();
    const peek = page.locator('dialog.peek[open]');
    await expect(peek.locator('dt', { hasText: 'Banned in' }).locator('xpath=following-sibling::dd[1]')).toContainText('Standard');
    await expect(peek.locator('dt', { hasText: 'Legal in' }).locator('xpath=following-sibling::dd[1]')).not.toContainText('Standard,');
    await expect(peek).not.toContainText('(banned)');
    await page.keyboard.press('Escape');

    await page.getByLabel('Search Arena cards').fill('mv<<<');
    await page.locator('.csearch__form').getByRole('button', { name: 'Search', exact: true }).click();
    await expect(page.getByRole('note').filter({ hasText: 'could not be read' })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
