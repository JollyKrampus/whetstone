/**
 * HotS content pages: hero grid, hero pages, maps, tier list, patches, catch-up, pro, live, about.
 *
 * Runs against a build of the committed fixtures, in one of the two data modes the pages support:
 *
 *   Theory only (default; what `npm run build && npm run e2e` and CI test):
 *     npm run build
 *     SMOKE_PORT=4321 npx playwright test e2e/hots-pages.spec.ts
 *
 *   Statistics (synthetic statistics, YouTube and Twitch fixtures from fixtures/hots/_private/),
 *   built into its own directory so dist/ keeps the theory build:
 *     WHETSTONE_FIXTURE_PRIVATE=1 WHETSTONE_OUT_DIR=.cache/dist-stats npm run build
 *     WHETSTONE_FIXTURE_PRIVATE=1 WHETSTONE_OUT_DIR=.cache/dist-stats SMOKE_PORT=4322 npx playwright test e2e/hots-pages.spec.ts
 *
 * WHETSTONE_OUT_DIR makes the config's `astro preview` serve that directory, and
 * WHETSTONE_FIXTURE_PRIVATE=1 tells this file which mode to expect. The first test fails loudly if
 * the server it reached serves the other mode (playwright reuses a running server on the same port,
 * so give each mode its own SMOKE_PORT). Mode-specific tests skip in the other mode; everything else
 * runs in both. CI should run the statistics pass as a second step after the default e2e step.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';

const STATS = process.env.WHETSTONE_FIXTURE_PRIVATE === '1';
const MODE = STATS ? 'stats' : 'theory';
const BASE = '/whetstone/';

// The site registers a service worker; block it so route mocks and fresh-load checks are reliable.
test.use({ serviceWorkers: 'block' });

/** Collects console errors, uncaught exceptions and failing same-origin requests. */
function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (url.hostname === 'localhost' && url.pathname.startsWith(BASE) && res.status() >= 400) errors.push(`http ${res.status()}: ${url.pathname}`);
  });
  return errors;
}

/** Never let a test reach a third-party player: answer them with an empty page. */
async function stubPlayers(context: BrowserContext): Promise<string[]> {
  const hits: string[] = [];
  await context.route(/^https:\/\/(player\.twitch\.tv|www\.youtube-nocookie\.com)\//, (route) => {
    hits.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>player</title>' });
  });
  return hits;
}

/** Islands are server-rendered first; wait until the one containing `selector` has hydrated. */
async function hydrated(page: Page, selector: string): Promise<void> {
  await expect(page.locator(`astro-island:has(${selector})`).first()).not.toHaveAttribute('ssr', /.*/);
}

/** The credit next to statistics: whichever source the statistics file names (StatsCredit). */
const statsCredit = (page: Page) => page.locator('[data-stats-credit]');
/** Its inline credit link (SourceAttribution), whatever the source is. */
const statsCreditLink = (page: Page) => page.locator('[data-stats-credit] [data-attribution="inline"] a');

/** Routes every page template of this suite, with the fixture entities they are tested on. */
const ROUTES = [
  'hots/',
  'hots/hero/abathur/',
  'hots/hero/chogall/',
  'hots/hero/xalatath/',
  'hots/maps/',
  'hots/map/cursed-hollow/',
  'hots/map/braxis-outpost/',
  'hots/tierlist/',
  'hots/patches/',
  'hots/patches/2026-09-28-patch/',
  'hots/patches/2026-10-05-hotfix/',
  'hots/catch-up/',
  'hots/pro/',
  'hots/live/',
  'hots/about/',
];

test.describe(`HotS pages (${MODE} build)`, () => {
  test('the server serves the expected data mode', async ({ page }) => {
    await page.goto('hots/hero/abathur/');
    await expect(page.locator('article.hpage'), 'wrong build behind this port: see the header of this file').toHaveAttribute('data-basis', MODE);
  });

  test.describe('hero grid', () => {
    test('searches names and nicknames and filters by role, franchise and rotation', async ({ page }) => {
      const errors = watch(page);
      await page.goto('hots/');
      const grid = page.locator('#hero-grid');
      const tiles = grid.locator('[data-entity]');
      const total = await tiles.count();
      expect(total).toBeGreaterThan(5);
      await expect(page.getByRole('status').filter({ hasText: `${total} heroes` })).toBeVisible();

      const search = page.locator('#search');
      await search.fill('ming');
      await expect(grid.locator('[data-entity]:visible')).toHaveCount(1);
      await expect(grid.locator('[data-entity]:visible')).toContainText('Li-Ming');

      // Member names find the composite.
      await search.fill('gall');
      await expect(grid.locator('[data-entity]:visible').first()).toContainText("Cho'gall");

      await search.fill('');
      await expect(grid.locator('[data-entity]:visible')).toHaveCount(total);

      await page.getByRole('button', { name: /^Healer\b/ }).click();
      await expect(page).toHaveURL(/[?&]role=Healer/);
      await expect(grid.locator('[data-entity]:visible')).toHaveCount(await grid.locator('[data-entity][data-f-role*="Healer"]').count());
      await page.getByRole('button', { name: /^Healer\b/ }).click();

      const freeChip = page.getByRole('button', { name: /^Free this week\b/ });
      if ((await freeChip.count()) > 0) {
        await freeChip.click();
        const free = await grid.locator('[data-entity][data-f-avail*="free"]').count();
        expect(free).toBeGreaterThan(0);
        await expect(grid.locator('[data-entity]:visible')).toHaveCount(free);
        for (const tile of await grid.locator('[data-entity]:visible').all()) await expect(tile).toContainText('Free');
        await page.getByRole('button', { name: 'Clear filters' }).click();
      } else {
        // Live data can carry last week's rotation (Nexus Compendium lagging): nobody is marked free.
        await expect(page.locator('.pbanner__rot')).toContainText("aren't listed yet");
        await expect(grid.locator('[data-entity][data-f-avail*="free"]')).toHaveCount(0);
      }
      await page.getByRole('button', { name: /^Warcraft\b/ }).click();
      await expect(grid.locator('[data-entity]:visible')).toHaveCount(await grid.locator('[data-entity][data-f-franchise="Warcraft"]').count());

      await expect(page.locator('[data-entity="HXAL"]')).toContainText('New');
      expect(errors).toEqual([]);
    });

    test('links the live patch and the catch-up page', async ({ page }) => {
      await page.goto('hots/');
      const banner = page.getByRole('region', { name: 'Current patch' });
      await expect(banner).toContainText('Patch 2.57');
      await banner.getByRole('link', { name: 'Read the patch notes' }).click();
      await expect(page).toHaveURL(/\/hots\/patches\/2026-10-05-hotfix\/$/);
    });

    test('keeps an owned-heroes list in the shared pool and dims the rest', async ({ page }) => {
      await page.goto('hots/');
      await hydrated(page, '[data-pool-bar]');
      await page.locator('[data-pool-edit]').click();
      const dialog = page.locator('[data-pool-dialog]');
      await expect(dialog).toBeVisible();
      await dialog.locator('[data-pool-pick="Abat"]').click();
      await expect(dialog.locator('[data-pool-pick="Abat"]')).toHaveAttribute('aria-pressed', 'true');
      await dialog.getByRole('button', { name: /^Favourites/ }).click();
      await dialog.locator('[data-pool-pick="Tra0"]').click();
      await dialog.getByRole('button', { name: 'Done' }).click();
      await expect(dialog).toBeHidden();

      const stored = await page.evaluate(() => localStorage.getItem('whetstone:hots:pool'));
      expect(JSON.parse(stored ?? 'null')).toEqual({ v: 1, d: { v: 1, owned: ['Abat'], favorites: ['Tra0'] } });

      await page.locator('[data-pool-dim]').click();
      await expect(page.locator('[data-entity="Abat"]')).not.toHaveAttribute('data-unowned');
      await expect(page.locator('[data-entity="Diab"]')).toHaveAttribute('data-unowned');
      await expect(page.locator('[data-entity="Tra0"]')).toHaveAttribute('data-favorite');

      await page.reload();
      await expect(page.locator('[data-pool-bar]')).toContainText('You own 1 of');
      await expect(page.locator('[data-entity="Diab"]')).toHaveAttribute('data-unowned');
    });

    test('shows tier badges with the statistics credit only when statistics exist', async ({ page }) => {
      await page.goto('hots/');
      if (STATS) {
        await expect(statsCreditLink(page).first()).toBeVisible();
        await expect(page.locator('#hero-grid .badge--stats', { hasText: /^T[1-5]:/ }).first()).toBeVisible();
      } else {
        await expect(statsCredit(page)).toHaveCount(0);
        await expect(page.locator('#hero-grid .badge--stats', { hasText: /^T[1-5]:/ })).toHaveCount(0);
      }
    });
  });

  test.describe('hero page', () => {
    test('header, counters and every tab render', async ({ page }) => {
      const errors = watch(page);
      await page.goto('hots/hero/abathur/');
      await expect(page).toHaveTitle(/Abathur counters, synergies and best maps/);
      await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /Abathur, Evolution Master/);
      await expect(page.getByRole('heading', { level: 1, name: 'Abathur' })).toBeVisible();
      await expect(page.locator('.hhead')).toContainText('Evolution Master');
      await expect(page.locator('.hhead__ratings')).toContainText('Complexity');

      for (const list of ['Abathur is strong against', 'Abathur is weak against', 'Abathur works well with']) {
        await expect(page.getByRole('heading', { name: list }).first()).toBeVisible();
      }
      const firstWhy = page.locator('#counters .mrow__why').first();
      await firstWhy.locator('summary').click();
      await expect(firstWhy.locator('li').first()).toBeVisible();

      const correction = page.getByRole('link', { name: 'Suggest a correction' });
      const href = new URL((await correction.getAttribute('href')) ?? '');
      expect(href.pathname).toBe('/JollyKrampus/whetstone/issues/new');
      expect(href.searchParams.get('template')).toBe('counter-theory.yml');
      expect(href.searchParams.get('a')).toBe('Abathur');
      expect(href.searchParams.get('patch')).toBe('2.57');

      await page.locator('a[data-tab="maps"]').click();
      await expect(page).toHaveURL(/#maps$/);
      await expect(page.getByRole('heading', { name: 'Best maps for Abathur' }).first()).toBeVisible();

      await page.locator('a[data-tab="talents"]').click();
      await expect(page.locator('#talents .ttier')).toHaveCount(7);
      await expect(page.locator('#talents [data-talent="AbathurCombatStyleLocustBrood"]')).toBeVisible();

      await page.locator('a[data-tab="abilities"]').click();
      await expect(page.locator('#abilities .abil').first()).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Mechanics tags' })).toBeVisible();
      await expect(page.locator('#abilities .mtag').first()).toBeVisible();

      await page.locator('a[data-tab="history"]').click();
      const entry = page.locator('#history .pentry').first();
      await expect(entry).toBeVisible();
      await expect(entry.locator('.hx-dir').first()).toHaveText(/Buff|Nerf|Change|Rework/);

      await page.locator('a[data-tab="guides"]').click();
      await expect(page.locator('#guides .glink').first()).toBeVisible();
      expect(errors).toEqual([]);
    });

    test('theory mode explains itself and never claims statistics', async ({ page }) => {
      test.skip(STATS, 'theory build only');
      await page.goto('hots/hero/abathur/');
      const notice = page.locator('#counters [data-theory-notice]');
      await expect(notice).toContainText('Scores come from mechanics and curated matchups, not from match statistics');
      await expect(notice.getByRole('link', { name: 'How theory scores work' })).toHaveAttribute('href', `${BASE}hots/about/#theory`);
      await expect(page.locator('#counters .mrow .badge', { hasText: 'Theory' }).first()).toBeVisible();
      await expect(page.locator('.mrow .badge', { hasText: 'Stats' })).toHaveCount(0);
      await expect(page.locator('fieldset.mswitch__switch, fieldset.period__switch')).toHaveCount(0);
      await expect(statsCredit(page)).toHaveCount(0);
    });

    test('lists each opponent in one counter list only, with folded rows as a light list', async ({ page }) => {
      test.skip(STATS, 'theory build only');
      for (const slug of ['abathur', 'johanna', 'xalatath']) {
        await page.goto(`hots/hero/${slug}/`);
        const ids = async (list: string) =>
          page.locator(`#counters [data-list="${list}"] .mrow[data-id], #counters [data-list="${list}"] .lrow[data-id]`).evaluateAll((els) => els.map((e) => e.getAttribute('data-id')));
        const strong = await ids('strong');
        const weak = await ids('weak');
        expect(strong.filter((id) => weak.includes(id)), `${slug}: opponents in both lists`).toEqual([]);
        // Folded rows (the rest of a list, and below the bar) are light text rows: no portrait or score ring.
        await expect(page.locator('#counters :is(.flist__fold, .ccols__below) :is(.mrow, .score-ring)')).toHaveCount(0);
        for (const list of ['strong', 'weak', 'synergy']) expect(await page.locator(`#counters [data-list="${list}"] .mrow`).count()).toBeLessThanOrEqual(6);
      }
      const rest = page.locator('#counters details[data-rest]').first();
      if ((await rest.count()) > 0) {
        await rest.locator(':scope > summary').click();
        await expect(rest.locator('.lrow').first()).toBeVisible();
      }
      const below = page.locator('#counters details[data-below]').first();
      if ((await below.count()) > 0) {
        await below.locator(':scope > summary').click();
        await expect(below.locator('.lrow').first()).toBeVisible();
        await expect(below.locator('.lrow__score').first()).toContainText(/\d/);
      }
    });

    test('best maps list only maps above neutral; harder maps get their own list', async ({ page }) => {
      for (const slug of ['abathur', 'johanna', 'xalatath']) {
        await page.goto(`hots/hero/${slug}/#maps`);
        const scoresOf = async (heading: RegExp): Promise<number[]> => {
          const list = page.locator('#maps .flist').filter({ has: page.getByRole('heading', { name: heading }) }).first();
          if ((await list.count()) === 0) return [];
          const full = await list
            .locator('.mrow')
            .evaluateAll((rows) => rows.map((r) => Number(/score (\d+)/.exec(r.querySelector('[role="img"][aria-label*="score"]')?.getAttribute('aria-label') ?? '')?.[1] ?? 'NaN')));
          // Folded rows are light text rows; their score is plain text.
          const light = await list.locator('.lrow__score').evaluateAll((els) => els.map((e) => Number(/\d+/.exec(e.textContent ?? '')?.[0] ?? 'NaN')));
          return [...full, ...light];
        };
        const best = await scoresOf(/^Best maps for /);
        expect(best.every((n) => Number.isFinite(n)), `${slug}: unreadable best-map score`).toBe(true);
        for (const score of best) expect(score, `${slug}: best map at or below 50`).toBeGreaterThan(50);
        for (const score of await scoresOf(/^Harder maps for /)) expect(score, `${slug}: harder map at or above 50`).toBeLessThan(50);
      }
    });

    test('statistics mode credits its source and switches mode and patch window', async ({ page }) => {
      test.skip(!STATS, 'statistics build only');
      await page.goto('hots/hero/abathur/');
      await expect(statsCreditLink(page).first()).toBeVisible();

      const label = page.locator('#counters .wlabel:visible');
      await expect(label).toHaveText(/Storm League · 2\.57/);
      await expect(page.locator('#counters .mrow .badge:visible', { hasText: 'Stats' }).first()).toBeVisible();
      await expect(page.locator('#counters .mrow:visible .mrow__n').first()).toContainText('n =');

      await page.locator('label.period__option', { hasText: 'Previous patch' }).click();
      await expect(label).toHaveText(/Storm League · 2\.55/);
      await page.locator('label.period__option', { hasText: 'Current patch' }).click();
      await page.locator('label.mswitch__option', { hasText: 'ARAM' }).click();
      await expect(label).toHaveText(/ARAM · 2\.57/);
      await expect(statsCreditLink(page).first()).toBeVisible();
      await page.locator('label.mswitch__option', { hasText: 'Storm League' }).click();

      await page.locator('#counters details.compare > summary').click();
      await expect(page.locator('#counters .compare [data-theory-notice]')).toBeVisible();

      await page.locator('a[data-tab="talents"]').click();
      const builds = page.locator('#talents .tbuilds:visible');
      await expect(builds.getByRole('heading', { name: 'Builds from match data' })).toBeVisible();
      await expect(builds.locator('.tbuild__code').first()).toHaveText(/^\[T[0-7]{7},Abathur\]$/);
      await expect(builds.getByRole('button', { name: 'Copy build' }).first()).toBeVisible();
      await expect(builds.locator('.tbuild__meta').first()).toContainText('n =');
      await expect(statsCreditLink(page).first()).toBeVisible();
    });

    test('statistics mode loads videos only on demand from youtube-nocookie', async ({ page, context }) => {
      test.skip(!STATS, 'statistics build only');
      await page.clock.setFixedTime(new Date('2026-10-08T12:00:00Z'));
      const hits = await stubPlayers(context);
      await page.goto('hots/hero/xalatath/#guides');
      const video = page.locator('#guides [data-facade]').first();
      await expect(video).toBeVisible();
      expect(hits).toEqual([]);
      // YouTube API Services policies: the terms link sits next to the YouTube credit.
      await expect(page.locator('#guides [data-youtube-terms] a[href="https://www.youtube.com/t/terms"]')).toBeVisible();
      await video.getByRole('button', { name: /Play here/ }).click();
      await expect(video.locator('iframe')).toHaveAttribute('src', /^https:\/\/www\.youtube-nocookie\.com\/embed\//);
    });

    test('member slugs redirect to the composite page', async ({ page }) => {
      for (const slug of ['cho', 'gall']) {
        await page.goto(`hots/hero/${slug}/`);
        await expect(page).toHaveURL(new RegExp(`${BASE}hots/hero/chogall/$`));
        await expect(page.getByRole('heading', { level: 1, name: "Cho'gall" })).toBeVisible();
      }
      await expect(page.locator('.hhead__members')).toContainText('two players sharing one hero');
      await page.locator('a[data-tab="talents"]').click();
      await expect(page.locator('#talents .ttiers__name')).toHaveText(['Cho', 'Gall']);
    });

    test('heroescounters-style slugs redirect and stay out of the sitemap', async ({ page, request }) => {
      await page.goto('hots/hero/li-ming/');
      await expect(page).toHaveURL(new RegExp(`${BASE}hots/hero/liming/$`));
      await page.goto('hots/map/cursedhollow/');
      await expect(page).toHaveURL(new RegExp(`${BASE}hots/map/cursed-hollow/$`));
      const sitemap = await (await request.get('sitemap-0.xml')).text();
      expect(sitemap).toContain('/hots/hero/liming/');
      for (const slug of ['hero/cho/', 'hero/gall/', 'hero/li-ming/', 'map/cursedhollow/']) expect(sitemap, slug).not.toContain(`/hots/${slug}`);
    });

    test('heroescounters section paths redirect to their Whetstone pages', async ({ page, request }) => {
      for (const [from, to] of [
        ['teampicker/', 'draft/'],
        ['map/', 'maps/'],
        ['watch/live/', 'live/'],
        ['hero/', ''],
      ]) {
        await page.goto(`hots/${from}`);
        await expect(page, from).toHaveURL(new RegExp(`${BASE}hots/${to}$`));
      }
      const sitemap = await (await request.get('sitemap-0.xml')).text();
      for (const from of ['teampicker/', 'map/', 'watch/live/', 'hero/']) expect(sitemap, from).not.toContain(`/hots/${from}<`);
    });
  });

  test.describe('hero page links', () => {
    test('heroescounters-style #videos opens the Guides tab', async ({ page }) => {
      await page.goto('hots/hero/abathur/#videos');
      await expect(page).toHaveURL(/#guides$/);
      await expect(page.locator('#guides .glink').first()).toBeVisible();
    });

    test('new heroes carry a provisional-data notice', async ({ page }) => {
      await page.goto('hots/hero/xalatath/');
      await expect(page.locator('[data-new-hero]')).toContainText('New hero.');
      await page.goto('hots/hero/abathur/');
      await expect(page.locator('[data-new-hero]')).toHaveCount(0);
    });
  });

  test.describe('maps', () => {
    test('map index groups the ranked pool and ARAM; map pages rank heroes', async ({ page }) => {
      const errors = watch(page);
      await page.goto('hots/maps/');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await page.getByRole('link', { name: /Cursed Hollow/ }).first().click();
      await expect(page).toHaveURL(/\/hots\/map\/cursed-hollow\/$/);
      await expect(page.getByText('Ranked pool').first()).toBeVisible();
      await expect(page.locator('.mrow:visible').first()).toBeVisible();
      if (STATS) await expect(statsCreditLink(page).first()).toBeVisible();
      else await expect(page.locator('[data-theory-notice]').first()).toBeVisible();
      await expect(page.locator('.mapsx__source, [data-ranked-source]')).toHaveCount(0);

      await page.goto('hots/map/braxis-outpost/');
      await expect(page.getByRole('heading', { name: 'Playing ARAM here' })).toBeVisible();
      expect(errors).toEqual([]);
    });
  });

  test.describe('tier list', () => {
    test('theory build shows the labelled alternative, never a win-rate tier list', async ({ page }) => {
      test.skip(STATS, 'theory build only');
      await page.goto('hots/tierlist/');
      await expect(page.locator('[data-alt-view]')).toBeVisible();
      await expect(page.getByText('Not a tier list')).toHaveCount(2);
      await expect(page.getByRole('heading', { name: 'Pro presence' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Patch momentum' })).toBeVisible();
      await expect(page.locator('[data-attribution="inline"] [data-source="liquipedia"]')).toContainText('CC-BY-SA 3.0');
      await expect(page.locator('.tierlist, [data-tier]')).toHaveCount(0);
      await expect(statsCredit(page)).toHaveCount(0);
    });

    test('statistics build bands heroes per mode and window with the credit', async ({ page }) => {
      test.skip(!STATS, 'statistics build only');
      await page.goto('hots/tierlist/');
      await expect(statsCreditLink(page).first()).toBeVisible();
      await expect(page.locator('.wlabel:visible')).toHaveText(/Storm League · 2\.57/);
      await expect(page.getByText(/Early data/).first()).toBeVisible();
      const bans = page.locator('[data-ban-priority]:visible');
      await expect(bans.getByRole('heading', { name: 'Ban priority' })).toBeVisible();
      await expect(bans.locator('.presence__meta').first()).toContainText('n =');
      await page.locator('label.mswitch__option', { hasText: 'ARAM' }).click();
      await expect(page.locator('.wlabel:visible')).toHaveText(/ARAM · 2\.57/);
    });
  });

  test.describe('patches', () => {
    test('list and detail pages show direction chips, general changes, hotfix markers and the source', async ({ page }) => {
      const errors = watch(page);
      await page.goto('hots/patches/');
      await expect(page.getByRole('heading', { level: 1, name: 'Patch notes' })).toBeVisible();
      await expect(page.locator('[data-patch="2026-10-05-hotfix"][data-kind="hotfix"]')).toBeVisible();
      await page.locator('[data-patch="2026-09-28-patch"] a').first().click();
      await expect(page).toHaveURL(/\/hots\/patches\/2026-09-28-patch\/$/);
      await expect(page.getByRole('heading', { name: 'General' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Heroes', exact: true })).toBeVisible();
      await expect(page.locator('.hx-dir[data-dir="nerf"]').first()).toBeVisible();
      await expect(page.getByRole('link', { name: /Read Blizzard's full notes/ })).toHaveAttribute('href', /^https:\/\/news\.blizzard\.com\//);

      await page.goto('hots/patches/2026-10-05-hotfix/');
      await expect(page.locator('[data-hotfix]')).toBeVisible();
      await expect(page.locator('.hx-dir[data-dir="nerf"]').first()).toBeVisible();
      expect(errors).toEqual([]);
    });
  });

  test.describe('catch-up', () => {
    test('defaults to the current major and follows the picked date in a shareable hash', async ({ page }) => {
      const errors = watch(page);
      await page.goto('hots/catch-up/');
      const summary = page.locator('[data-catchup-summary]');
      const date = page.locator('[data-catchup-date]');
      await expect(date).toHaveValue('2026-09-27');
      await expect(summary).toContainText('Since 27 Sep 2026: 3 patches');
      await expect(page.locator('.hx-group[data-hero="Abat"]')).toBeVisible();
      await expect(page.locator('.hx-group[data-hero="HXAL"][data-new="true"]')).toBeVisible();

      await hydrated(page, '[data-catchup]');
      await date.fill('2026-10-01');
      await expect(page).toHaveURL(/#since=2026-10-01$/);
      await expect(summary).toContainText('Since 1 Oct 2026: 1 patch, 1 hero changed');
      await expect(page.locator('.hx-group[data-hero="Abat"]')).toHaveCount(0);

      await date.fill('2026-10-07');
      await expect(summary).toContainText("You're up to date");

      // A shared link opens straight on its date.
      await page.goto('hots/catch-up/#since=2026-10-01');
      await expect(date).toHaveValue('2026-10-01');
      await expect(summary).toContainText('1 patch');
      await page.getByRole('button', { name: 'Before Patch 2.57' }).click();
      await expect(page).toHaveURL(/#since=2026-09-27$/);
      await expect(summary).toContainText('3 patches');
      expect(errors).toEqual([]);
    });
  });

  test.describe('pro, live and about', () => {
    test('pro presence table carries the CC-BY-SA credit', async ({ page }) => {
      await page.goto('hots/pro/');
      await expect(page.locator('table.ptable tbody tr').first()).toBeVisible();
      await expect(page.locator('[data-pro-maps]')).toContainText('drafted maps');
      await expect(page.locator('[data-attribution="inline"] [data-source="liquipedia"]')).toContainText('CC-BY-SA 3.0');
    });

    test('live page links the Twitch category and loads featured players only on Play', async ({ page, context }) => {
      const hits = await stubPlayers(context);
      await page.goto('hots/live/');
      await expect(page.getByRole('link', { name: /Browse live Heroes of the Storm streams on Twitch/ })).toHaveAttribute(
        'href',
        'https://www.twitch.tv/directory/category/heroes-of-the-storm',
      );
      const facade = page.locator('[data-facade]').first();
      await expect(facade).toBeVisible();
      expect(hits).toEqual([]);
      await facade.getByRole('button', { name: /Play here/ }).click();
      const src = (await facade.locator('iframe').getAttribute('src')) ?? '';
      expect(src).toMatch(/^https:\/\/player\.twitch\.tv\/\?channel=/);
      expect(src).toContain('parent=jollykrampus.github.io');
      expect(src).toContain('parent=localhost');
    });

    test('live list shows fresh streams with credit and hides them after 90 minutes', async ({ browser }) => {
      test.skip(!STATS, 'statistics build only (streams.json fixture)');
      for (const [time, fresh] of [
        ['2026-10-08T10:30:00Z', true],
        ['2026-10-08T12:00:00Z', false],
      ] as const) {
        const context = await browser.newContext({ serviceWorkers: 'block' });
        const page = await context.newPage();
        await page.clock.setFixedTime(new Date(time));
        await page.goto('hots/live/');
        if (fresh) {
          await expect(page.locator('[data-live-list]')).toBeVisible();
          await expect(page.locator('[data-live-list] .stream').first()).toBeVisible();
          await expect(page.locator('[data-live-list] [data-source="twitch"]')).toBeVisible();
          await expect(page.locator('[data-live-stale]')).toBeHidden();
        } else {
          await expect(page.locator('[data-live-list]')).toBeHidden();
          await expect(page.locator('[data-live-stale]')).toBeVisible();
        }
        await context.close();
      }
    });

    test('about renders the HotS methodology and every source', async ({ page }) => {
      await page.goto('hots/about/');
      await expect(page.getByRole('heading', { level: 1, name: 'How the HotS numbers work' })).toBeVisible();
      await expect(page.locator('#theory')).toContainText('Read the kits');
      const method = page.locator('.method');
      await expect(method.getByRole('heading', { name: /Counters and synergies/ })).toBeVisible();
      await expect(method).not.toContainText('Pokémon Champions');
      await expect(page.locator('#status')).toContainText(STATS ? 'Statistics on' : 'Theory only');
      await expect(page.locator('#sources [data-source="liquipedia"]')).toContainText('CC-BY-SA 3.0');
    });
  });

  test.describe('every page', () => {
    test('renders at 360 px without horizontal overflow or console errors', async ({ page }) => {
      test.setTimeout(90_000);
      await page.setViewportSize({ width: 360, height: 780 });
      const errors = watch(page);
      for (const route of ROUTES) {
        const res = await page.goto(route);
        expect(res?.status(), route).toBe(200);
        await expect(page.locator('h1').first(), route).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${route} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
      }
      expect(errors).toEqual([]);
    });

    test('statistics are always credited to their source on the same screen', async ({ page }) => {
      for (const route of ROUTES) {
        await page.goto(route);
        const statsShown = await page.locator('.mrow .badge:visible', { hasText: /^Stats$/ }).count();
        const credits = await statsCredit(page).count();
        if (!STATS) {
          expect(credits, route).toBe(0);
          expect(statsShown, route).toBe(0);
        } else if (statsShown > 0) {
          await expect(statsCreditLink(page).first(), route).toBeVisible();
        }
      }
    });
  });
});
