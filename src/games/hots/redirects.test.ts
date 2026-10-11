import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { repoRoot } from '../../lib/datadir.ts';
import { getDraftableEntities, getMaps } from './load.ts';
import {
  SECTION_REDIRECTS,
  heroRedirectsFor,
  heroSlugRedirects,
  mapRedirectsFor,
  mapSlugRedirects,
  redirectHtml,
  redirectPaths,
  sectionRedirectResponse,
} from './redirects.ts';
import { AliasesFileSchema } from './schema.ts';
import { loadCurated } from './theory/curated.ts';

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

/**
 * Every hero and map slug heroescounters.com used (its hero list of 85 and map list of 16, as
 * recorded in the parity research), checked against the curated roster in the repository: all 90
 * per-hero files and every map in maps.yaml, with aliases.yaml. Fixtures only hold a sample, so
 * the roster comes from the curated files rather than from the data directory.
 */
const HC_HERO_SLUGS = [
  'abathur', 'alarak', 'alexstrasza', 'ana', 'anduin', 'anubarak', 'artanis', 'arthas', 'auriel', 'azmodan', 'blaze', 'brightwing',
  'cassia', 'chen', 'chogall', 'chromie', 'dva', 'deckard', 'dehaka', 'diablo', 'etc', 'falstad', 'fenix', 'garrosh', 'gazlowe',
  'genji', 'greymane', 'guldan', 'hanzo', 'illidan', 'imperius', 'jaina', 'johanna', 'junkrat', 'kaelthas', 'kelthuzad', 'kerrigan',
  'kharazim', 'leoric', 'lili', 'li-ming', 'ltmorales', 'lucio', 'lunara', 'maiev', 'malganis', 'malfurion', 'malthael', 'medivh',
  'mephisto', 'muradin', 'murky', 'nazeebo', 'nova', 'orphea', 'probius', 'ragnaros', 'raynor', 'rehgar', 'rexxar', 'samuro',
  'sgthammer', 'sonya', 'stitches', 'stukov', 'sylvanas', 'tassadar', 'thebutcher', 'thelostvikings', 'thrall', 'tracer', 'tychus',
  'tyrael', 'tyrande', 'uther', 'valeera', 'valla', 'varian', 'whitemane', 'xul', 'yrel', 'zagara', 'zarya', 'zeratul', 'zuljin',
];
const HC_MAP_SLUGS = [
  'hauntedmines', 'dragonshire', 'cursedhollow', 'blackheartsbay', 'gardenofterror', 'skytemple', 'tombofthespiderqueen',
  'battlefieldofeternity', 'infernalshrines', 'towersofdoom', 'lostcaverns', 'braxisholdout', 'warheadjunction', 'hanamura',
  'volskayafoundry', 'alteracpass',
];

describe('heroescounters.com paths (curated roster)', () => {
  const root = repoRoot();
  const aliases = AliasesFileSchema.parse(parseYaml(fs.readFileSync(path.join(root, 'curated/hots/aliases.yaml'), 'utf8')));
  const curated = loadCurated(root);
  const heroSlugs = curated.files.map((f) => f.replace(/^heroes\/|\.yaml$/g, ''));
  const mapIds = Object.keys(curated.maps.maps);

  it('resolves every heroescounters.com hero slug to a hero page or a redirect to one', () => {
    expect(HC_HERO_SLUGS).toHaveLength(85);
    const redirects = heroRedirectsFor(
      heroSlugs.map((slug) => ({ slug, aliases: aliases.heroes[slug] ?? [] })),
      [
        { slug: 'cho', composite: 'chogall' },
        { slug: 'gall', composite: 'chogall' },
      ],
    );
    const to = new Map(redirects.map((r) => [r.from, r.to]));
    for (const slug of HC_HERO_SLUGS) {
      const target = heroSlugs.includes(slug) ? slug : to.get(slug);
      expect(target && heroSlugs.includes(target), `/hero/${slug}`).toBe(true);
    }
  });

  it('resolves every heroescounters.com map slug to a map page or a redirect to one', () => {
    expect(HC_MAP_SLUGS).toHaveLength(16);
    const to = new Map(mapRedirectsFor(mapIds.map((id) => ({ id })), new Map(Object.entries(aliases.maps))).map((r) => [r.from, r.to]));
    for (const slug of HC_MAP_SLUGS) {
      const target = mapIds.includes(slug) ? slug : to.get(slug);
      expect(target && mapIds.includes(target), `/map/${slug}`).toBe(true);
    }
    expect(to.get('lostcaverns')).toBe('lost-cavern');
  });

  it('redirects the section paths to their Whetstone equivalents and keeps them out of the sitemap', () => {
    expect(Object.fromEntries(SECTION_REDIRECTS.map((r) => [r.from, r.to]))).toEqual({ hero: '', map: 'maps/', teampicker: 'draft/', 'watch/live': 'live/' });
    const paths = redirectPaths('/whetstone/');
    for (const from of ['hero', 'map', 'teampicker', 'watch/live']) expect(paths).toContain(`/whetstone/hots/${from}/`);
    const res = sectionRedirectResponse('teampicker', new URL('https://jollykrampus.github.io/whetstone/'));
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(() => sectionRedirectResponse('nowhere', undefined)).toThrow();
  });

  it('emits the compact form of multi-word aliases, never an ambiguous one', () => {
    const maps = [{ id: 'lost-cavern' }, { id: 'silver-city' }];
    expect(mapRedirectsFor(maps, new Map([['lost-cavern', ['lost caverns']]]))).toContainEqual({ from: 'lostcaverns', to: 'lost-cavern' });
    const clash = mapRedirectsFor(maps, new Map([['lost-cavern', ['the map']], ['silver-city', ['the-map']]]));
    expect(clash.some((r) => r.from === 'themap')).toBe(false);
  });
});
