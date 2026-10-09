import { describe, expect, it } from 'vitest';
import { getDraftableEntities, getMaps } from './load.ts';
import { heroSlugRedirects, mapSlugRedirects, redirectHtml, redirectPaths } from './redirects.ts';

describe('slug redirects (fixtures)', () => {
  it('sends composite members and hyphenated aliases to a real hero page', () => {
    const heroes = heroSlugRedirects();
    expect(heroes).toEqual(
      expect.arrayContaining([
        { from: 'cho', to: 'chogall' },
        { from: 'gall', to: 'chogall' },
        { from: 'li-ming', to: 'liming' },
      ]),
    );
    const slugs = new Set(getDraftableEntities().map((h) => h.slug));
    for (const r of heroes) {
      expect(slugs.has(r.to), r.to).toBe(true);
      expect(slugs.has(r.from), r.from).toBe(false);
    }
    expect(new Set(heroes.map((r) => r.from)).size).toBe(heroes.length);
  });

  it('sends compact map slugs (heroescounters style) to the map page', () => {
    const maps = mapSlugRedirects();
    expect(maps).toEqual(expect.arrayContaining([{ from: 'cursedhollow', to: 'cursed-hollow' }, { from: 'hanamura', to: 'hanamura-temple' }]));
    const ids = new Set(getMaps().map((m) => m.id));
    for (const r of maps) expect(ids.has(r.to) && !ids.has(r.from)).toBe(true);
  });

  it('lists every redirect path for the sitemap filter', () => {
    const paths = redirectPaths('/whetstone/');
    expect(paths).toContain('/whetstone/hots/hero/li-ming/');
    expect(paths).toContain('/whetstone/hots/map/cursedhollow/');
    expect(paths).not.toContain('/whetstone/hots/hero/liming/');
  });

  it('renders a noindex refresh page with a canonical link', () => {
    const html = redirectHtml('/whetstone/hots/hero/liming/', 'https://jollykrampus.github.io/whetstone/hots/hero/liming/', 'Continue');
    expect(html).toContain('<meta name="robots" content="noindex">');
    expect(html).toContain('<meta http-equiv="refresh" content="0;url=/whetstone/hots/hero/liming/">');
    expect(html).toContain('rel="canonical" href="https://jollykrampus.github.io/whetstone/hots/hero/liming/"');
  });
});
