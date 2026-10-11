/**
 * Pokémon Champions user flows against the production build (fixtures data): Pokémon page,
 * builder import → legality → threats → share link, damage calc, team preview, speed tiers,
 * tournament teams → builder, and every Pokémon route at 360 px without overflow or console
 * errors. Run with SMOKE_PORT set to the port astro preview serves on.
 */
import { expect, test, type Page } from '@playwright/test';

/** Console errors, uncaught exceptions and failing same-origin requests. */
function watch(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console: ${msg.text()}`);
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('response', (res) => {
    const url = new URL(res.url());
    if (url.hostname === 'localhost' && url.pathname.startsWith('/whetstone/') && res.status() >= 400) errors.push(`http ${res.status()}: ${url.pathname}`);
  });
  return errors;
}

/** Resolves once every client:load island on the page has hydrated (Astro drops their ssr attribute). */
async function hydrated(page: Page): Promise<void> {
  await page.waitForFunction(() => [...document.querySelectorAll('astro-island[client="load"]')].every((island) => !island.hasAttribute('ssr')));
}

/** EV-style paste (SV era), so the import has to convert to Stat Points. */
const EV_PASTE = `Rillaboom @ Miracle Seed
Ability: Grassy Surge
Level: 50
EVs: 252 HP / 252 Atk / 4 SpD
Adamant Nature
- Fake Out
- Grassy Glide
- Wood Hammer
- High Horsepower

Incineroar @ Sitrus Berry
Ability: Intimidate
EVs: 252 HP / 4 Def / 252 SpD
Careful Nature
- Fake Out
- Flare Blitz
- Heat Wave
- Parting Shot

Garchomp @ Life Orb
Ability: Rough Skin
EVs: 4 HP / 252 Atk / 252 Spe
Jolly Nature
- Earthquake
- Dragon Claw
- Rock Slide
- Protect

Pelipper @ Focus Sash
Ability: Drizzle
EVs: 252 SpA / 252 Spe
Timid Nature
- Hurricane
- Weather Ball
- Tailwind
- Protect`;

/** Champions paste (Stat Points in the EVs line) with an Item Clause problem. */
const SP_PASTE_DUPLICATE_ITEM = `Kingambit @ Life Orb
Ability: Defiant
EVs: 32 HP / 32 Atk / 2 SpD
Adamant Nature
- Kowtow Cleave
- Sucker Punch

Garchomp @ Life Orb
Ability: Rough Skin
EVs: 2 HP / 32 Atk / 32 Spe
Jolly Nature
- Earthquake`;

test.describe('Pokémon pages', () => {
  test('home shows the regulation countdown and the usage grid', async ({ page }) => {
    const errors = watch(page);
    await page.goto('pokemon/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('meta');
    await expect(page.locator('[data-countdown-value]')).toHaveText(/\d+ d \d+ h|\d+ h \d+ min|\d+ min|under a minute|Ended/);
    await expect(page.locator('#pokemon-grid a').first()).toBeVisible();
    await expect(page.getByText(/Smogon/).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Pokémon page: stats planner, Mega tab, matchups and outbound links', async ({ page }) => {
    const errors = watch(page);
    await page.goto('pokemon/mon/salamence/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Salamence');
    // Formes are tabs (links without JS), the most used forme first.
    await expect(page.locator('[data-tab="salamencemega"]')).toHaveText(/Mega Salamence/);
    await expect(page.locator('[data-tab="salamence"]')).toBeVisible();
    const panel = page.locator('[data-forme="salamencemega"]');
    await expect(panel.getByRole('heading', { name: 'Checks and counters' })).toBeAttached();
    await expect(panel.getByRole('heading', { name: 'Good with' })).toBeAttached();
    // Stat Point planner: the Speed output follows the points (client:visible island).
    const planner = panel.locator('[data-planner="salamencemega"]');
    await planner.scrollIntoViewIfNeeded();
    // client:visible: wait until Astro has hydrated the island (it drops the ssr attribute).
    await expect(page.locator('astro-island:has([data-planner="salamencemega"])')).not.toHaveAttribute('ssr', /.*/);
    const speed = planner.locator('#salamencemega-sp-spe');
    await speed.fill('0');
    await speed.blur();
    await expect(planner.locator('output[for="salamencemega-sp-spe"]')).toHaveText(/^1[0-9]{2}/);
    await expect(planner.locator('.pk-planner__total')).toContainText('/ 66 Stat Points');
    for (const name of ['Smogon Pokédex', 'Bulbapedia', 'Victory Road', 'Pikalytics']) {
      await expect(page.locator('.pk-links').getByRole('link', { name: new RegExp(name) })).toHaveAttribute('href', /^https:\/\//);
    }
    expect(errors).toEqual([]);
  });

  test('tier list shows usage tiers with sample sizes', async ({ page }) => {
    const errors = watch(page);
    await page.goto('pokemon/tiers/');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tier list');
    await expect(page.getByText(/n \d/).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('speed tiers reorder under Trick Room', async ({ page }) => {
    const errors = watch(page);
    await page.goto('pokemon/speed/');
    await hydrated(page);
    const firstRow = page.locator('table.pk-table tbody tr').first().locator('th');
    const fastest = await firstRow.innerText();
    await page.getByLabel('Trick Room (slowest moves first)').check();
    await expect(firstRow).not.toHaveText(fastest);
    expect(errors).toEqual([]);
  });
});

test.describe('team builder', () => {
  test('import an EV paste → Stat Points, legality, threats and a share link', async ({ page }) => {
    const errors = watch(page);
    await page.goto('pokemon/builder/');
    await expect(page.locator('.pk-builder[data-ready]')).toBeVisible();
    await page.locator('#pk-paste').fill(EV_PASTE);
    await page.getByRole('button', { name: 'Import (replaces the team)' }).click();

    await expect(page.locator('.pk-slots .pk-slot[data-slot]')).toHaveCount(4);
    await expect(page.getByText('Imported 4 Pokémon (EVs converted to Stat Points).')).toBeVisible();
    // 252 EVs → 32 points, 4 EVs → 1 point (HOME rule).
    await expect(page.locator('#slot1-sp-hp')).toHaveValue('32');
    await expect(page.locator('#slot1-sp-spd')).toHaveValue('1');
    await expect(page.locator('.pk-teambar__state')).toContainText('Legal for Regulation Set M-C');
    await expect(page.locator('#pk-export')).toHaveValue(/EVs: 32 HP \/ 32 Atk \/ 1 SpD/);

    await expect(page.locator('.pk-matrix tbody tr')).toHaveCount(18);
    await expect(page.locator('.pk-threats > li').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.pk-threats > li').first()).toContainText(/OHKOs \d/);

    // The team is in the link: a fresh page restores it.
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/^#v=1&t=/);
    const url = page.url();
    const second = await page.context().newPage();
    const errors2 = watch(second);
    await second.goto(url);
    await expect(second.getByText('Loaded the team from the link.')).toBeVisible();
    await expect(second.locator('.pk-slots .pk-slot[data-slot]')).toHaveCount(4);
    expect([...errors, ...errors2]).toEqual([]);
  });

  test('flags Item Clause and incomplete sets, and saves teams locally', async ({ page }) => {
    const errors = watch(page);
    await page.goto('pokemon/builder/');
    await expect(page.locator('.pk-builder[data-ready]')).toBeVisible();
    await page.locator('#pk-paste').fill(SP_PASTE_DUPLICATE_ITEM);
    await page.getByRole('button', { name: 'Import (replaces the team)' }).click();
    await expect(page.locator('.pk-teambar__state')).toContainText('problem');
    await expect(page.getByText('Item Clause: 2 Pokémon hold Life Orb.').first()).toBeVisible();
    await expect(page.getByText(/Register at least 4 Pokémon/)).toBeVisible();
    // Stat Points stayed Stat Points (nothing above 32).
    await expect(page.locator('#slot2-sp-spe')).toHaveValue('32');

    await page.locator('#pk-team-name').fill('Ladder test');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.pk-saved')).toContainText('Ladder test');
    await page.reload();
    await expect(page.locator('.pk-saved')).toContainText('Ladder test');
    expect(errors).toEqual([]);
  });

  test('add a Pokémon by name and edit its set', async ({ page }) => {
    const errors = watch(page);
    await page.goto('pokemon/builder/');
    await expect(page.locator('.pk-builder[data-ready]')).toBeVisible();
    await page.locator('#pk-add-species').fill('Garchomp');
    await page.locator('#pk-add-species').press('Enter');
    await expect(page.locator('#slot1-species')).toHaveValue('Garchomp');
    await expect(page.locator('#pk-add-species')).toHaveValue('');
    await page.locator('#slot1-move1').fill('Earthquake');
    await page.locator('#slot1-move1').press('Enter');
    await page.locator('#slot1-sp-spe').fill('32');
    await page.locator('#slot1-nature').selectOption('Jolly');
    await expect(page.locator('#pk-export')).toHaveValue(/Garchomp\nAbility: Sand Veil\nLevel: 50\nEVs: 32 Spe\nJolly Nature\n- Earthquake/);
    // Speed 102 base, 32 SP, Jolly: floor((102 + 32 + 20) × 1.1) = 169.
    await expect(page.locator('output[for="slot1-sp-spe"]')).toHaveText('169');
    expect(errors).toEqual([]);
  });
});

test.describe('damage calc', () => {
  test('reproduces a verified Champions calc with Doubles spread damage', async ({ page }) => {
    const errors = watch(page);
    await page.goto('pokemon/calc/');
    await expect(page.locator('.pk-calc[data-ready]')).toBeVisible();
    await expect(page.locator('.pk-result').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('.pk-result__pct').first()).toHaveText(/\d+(\.\d)?–\d+(\.\d)?%|No damage/);

    // Left: Jolly Garchomp 2 HP / 32 Atk / 32 Spe with Earthquake.
    await page.locator('#atk-species').fill('Garchomp');
    await page.locator('#atk-species').press('Enter');
    await page.locator('#atk-item').fill('');
    await page.locator('#atk-item').press('Enter');
    await page.locator('#atk-ability').selectOption('roughskin');
    await page.locator('#atk-nature').selectOption('Jolly');
    for (const [stat, value] of [['spd', '0'], ['hp', '2'], ['atk', '32'], ['def', '0'], ['spa', '0'], ['spe', '32']] as const) {
      await page.locator(`#atk-sp-${stat}`).fill(value);
    }
    await page.locator('#atk-move1').fill('Earthquake');
    await page.locator('#atk-move1').press('Enter');

    // Right: Careful Incineroar 32 HP / 2 Def / 32 SpD.
    await page.locator('#def-preset').selectOption('incineroar');
    await page.locator('#def-nature').selectOption('Careful');
    for (const [stat, value] of [['def', '2'], ['spd', '32'], ['hp', '32']] as const) {
      await page.locator(`#def-sp-${stat}`).fill(value);
    }
    await page.getByLabel('Terrain').selectOption('');
    await page.getByLabel('Weather').selectOption('');

    const eq = page.locator('.pk-result[data-move="earthquake"]').first();
    await expect(eq.locator('.pk-result__pct')).toHaveText('68.3–81.1%');
    await expect(eq).toContainText('guaranteed 2HKO');
    await expect(eq).toContainText('spread ×0.75');

    // Singles drops the spread modifier.
    await page.getByRole('button', { name: 'Singles' }).click();
    await expect(eq.locator('.pk-result__pct')).not.toHaveText('68.3–81.1%');
    await expect(page.locator('.pk-calc__results .pk-status')).toContainText('moves before');
    expect(errors).toEqual([]);
  });
});

test.describe('team preview', () => {
  test('ranks your six against theirs and explains the bring-four', async ({ page }) => {
    const errors = watch(page);
    await page.goto('pokemon/builder/');
    await expect(page.locator('.pk-builder[data-ready]')).toBeVisible();
    await page.getByRole('button', { name: 'Start from the top six' }).click();
    await expect(page.locator('.pk-slots .pk-slot[data-slot]')).toHaveCount(6);

    await page.getByRole('link', { name: 'Team preview →' }).click();
    await expect(page.locator('.pk-tool[data-ready]')).toBeVisible();
    await expect(page.getByRole('list', { name: 'Your team' }).locator('li')).toHaveCount(6);
    for (const name of ['Sneasler', 'Kingambit', 'Whimsicott', 'Archaludon', 'Pelipper', 'Farigiraf']) {
      await page.locator('#pv-add-theirs').fill(name);
      await page.locator('#pv-add-theirs').press('Enter');
    }
    await expect(page.getByRole('list', { name: 'Their team' }).locator('li')).toHaveCount(6);
    await expect(page.locator('section[aria-labelledby="pv-plan-h"] > .pk-status')).toHaveText('Ranked with replay results, types, speed and damage.', { timeout: 20_000 });

    const plan = page.locator('[data-plan]');
    await expect(plan.locator('[data-lead]')).toHaveCount(2);
    const ranked = page.locator('.pk-ranked > li');
    await expect(ranked).toHaveCount(6);
    await expect(page.locator('.pk-ranked > li[data-pick="lead"]')).toHaveCount(2);
    await expect(page.locator('.pk-ranked > li[data-pick="bring"]')).toHaveCount(2);
    await expect(page.locator('.pk-ranked > li[data-pick="leave"]')).toHaveCount(2);
    // Reasons carry their evidence: sample sizes from replays, the calc or the type chart.
    await expect(page.locator('.pk-ranked .reason__meta').first()).toBeVisible();
    await expect(page.locator('.pk-ranked')).toContainText(/n = \d+|@smogon\/calc|type chart/);
    // Their likely four add up to four.
    const chances = await page.locator('#pv-their-h ~ .pk-bars .pk-bar__value').allInnerTexts();
    const total = chances.map((t) => Number.parseInt(t, 10)).reduce((a, b) => a + b, 0);
    expect(Math.abs(total - 400)).toBeLessThanOrEqual(3);

    // Presets re-rank without errors; the matchup is in the link.
    await page.getByRole('button', { name: 'Types', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Types', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/&o=/);
    expect(errors).toEqual([]);
  });
});

test.describe('tournament teams', () => {
  test('opens a top-cut team in the builder through its share link', async ({ page }) => {
    const errors = watch(page);
    await page.goto('pokemon/teams/');
    await page.getByRole('link', { name: 'Open in builder' }).first().click();
    await expect(page.getByText('Loaded the team from the link.')).toBeVisible();
    await expect(page.locator('.pk-slots .pk-slot[data-slot]').first()).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('360 px', () => {
  test.use({ viewport: { width: 360, height: 780 } });
  const routes = ['pokemon/', 'pokemon/mon/salamence/', 'pokemon/tiers/', 'pokemon/builder/', 'pokemon/calc/', 'pokemon/speed/', 'pokemon/teams/', 'pokemon/preview/', 'pokemon/about/'];
  for (const route of routes) {
    test(`${route} fits without horizontal scrolling`, async ({ page }) => {
      const errors = watch(page);
      await page.goto(route);
      await hydrated(page);
      if (route.endsWith('preview/')) await expect(page.locator('.pk-tool[data-ready]')).toBeVisible();
      if (route.endsWith('builder/')) {
        await expect(page.locator('.pk-builder[data-ready]')).toBeVisible();
        await page.getByRole('button', { name: 'Start from the top six' }).click();
        await expect(page.locator('.pk-threats > li').first()).toBeVisible({ timeout: 20_000 });
      }
      if (route.endsWith('calc/')) await expect(page.locator('.pk-result').first()).toBeVisible({ timeout: 20_000 });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(0);
      expect(errors).toEqual([]);
    });
  }
});
