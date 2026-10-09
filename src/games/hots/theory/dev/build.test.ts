import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../../../lib/datadir.ts';
import { MapsFileSchema } from '../../schema.ts';
import { loadCurated } from '../curated.ts';
import { buildTheory } from '../engine.ts';
import { fixtureHeroInputs } from '../__fixtures__/kits.ts';
import { calibrationStats, heroesWithMechanics, mapsFromCurated, statsMarkdown, tagsReport } from './build.ts';
import { heroSlug, renderGameText } from './fromHeroesData.ts';

describe('dev adapter helpers', () => {
  it('renders heroes-data2 markup as heroes.json text', () => {
    expect(renderGameText('Deals <c val="bfd4fd">153~~0.04~~</c> damage.<n/>Lasts <w>4</w> seconds.')).toBe('Deals 153 (+4% per level) damage.\nLasts 4 seconds.');
  });

  it('slugs English names like the pipeline', () => {
    expect(heroSlug('Li-Ming')).toBe('liming');
    expect(heroSlug('The Lost Vikings')).toBe('thelostvikings');
    expect(heroSlug("Xal'atath")).toBe('xalatath');
    expect(heroSlug('Lúcio')).toBe('lucio');
  });
});

describe('dev build report', () => {
  const curated = loadCurated(repoRoot());
  const heroes = heroesWithMechanics(fixtureHeroInputs(), curated);
  const maps = mapsFromCurated(curated);

  it('turns maps.yaml into schema-valid map records', () => {
    expect(() => MapsFileSchema.parse(maps)).not.toThrow();
    expect(maps.filter((m) => m.kind === 'standard')).toHaveLength(15);
  });

  it('lists every draftable hero with its tags and marks talent-only ones', () => {
    const md = tagsReport(heroes, '98348');
    expect(md).toContain("## Cho'gall (Tank / Ranged Assassin)");
    expect(md).not.toContain('## Cho (');
    expect(md).toMatch(/- \*\*armor-shred\*\* \*\(talent only\)\*: Crippling Shot \(talent\)/);
    expect(md).toContain('curated (curated/hots/heroes/abathur.yaml)');
  });

  it('summarises calibration', () => {
    const stats = calibrationStats(buildTheory({ heroes, maps, curated }), heroes);
    expect(stats.heroes).toBe(17);
    expect(stats.counters).toBeGreaterThan(0);
    expect(Object.values(stats.counterHistogram).reduce((a, b) => a + b, 0)).toBe(stats.counters);
    expect(stats.mostCountered).toHaveLength(10);
    expect(statsMarkdown(stats)).toContain('| Score | Edges |');
  });
});
