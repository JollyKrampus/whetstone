import { describe, expect, it } from 'vitest';
import { MapsFileSchema } from '../../schema.ts';
import { fixtureRelease, testCurated } from '../test-helpers.ts';
import { RANKED_MIN_SHARE, buildMaps } from './maps.ts';

const curated = testCurated();
const mapdata = fixtureRelease('2.57.0.98348').maps;

describe('buildMaps', () => {
  const built = buildMaps(mapdata, curated.maps, curated.rankedPool, null);

  it('publishes every curated map found in mapdata, sorted, schema-valid', () => {
    expect(built.maps.map((m) => m.id)).toEqual(Object.keys(curated.maps.maps).sort());
    expect(MapsFileSchema.safeParse(built.maps).success).toBe(true);
    expect(built.issues).toEqual([]);
  });

  it('takes the ranked flag from ranked-pool.yaml without stats', () => {
    for (const m of built.maps) {
      expect(m.rankedSource).toBe('curated');
      expect(m.ranked).toBe(m.kind === 'standard' && curated.rankedPool.maps.includes(m.id));
    }
    expect(built.maps.find((m) => m.id === 'cursed-hollow')).toMatchObject({ kind: 'standard', ranked: true, image: 'img/maps/replayspreviewimage_cursedhollow.webp' });
  });

  it('uses Storm League game shares when stats exist', () => {
    const shares = new Map([
      ['cursed-hollow', 0.1],
      ['blackhearts-bay', RANKED_MIN_SHARE],
      ['sky-temple', 0.001],
    ]);
    const s = buildMaps(mapdata, curated.maps, curated.rankedPool, shares).maps;
    const ranked = (id: string) => s.find((m) => m.id === id)?.ranked;
    expect(ranked('cursed-hollow')).toBe(true);
    expect(ranked('blackhearts-bay')).toBe(true);
    expect(ranked('sky-temple')).toBe(false);
    expect(s.every((m) => m.rankedSource === 'stats')).toBe(true);
    // ARAM maps are never in the Storm League pool.
    expect(s.filter((m) => m.kind === 'aram').every((m) => !m.ranked)).toBe(true);
  });

  it('lists the preview image of every published map', () => {
    expect(built.images.map((i) => i.out).sort()).toEqual(built.maps.map((m) => m.image).sort());
    expect(built.images.every((i) => i.folder === 'replaypreviews')).toBe(true);
  });

  it('reports curated maps missing upstream and unknown non-brawl maps', () => {
    const { Lost: _drop, ...rest } = { Lost: null, ...mapdata };
    const trimmed = Object.fromEntries(Object.entries(rest).filter(([k]) => k !== 'Cursed Hollow'));
    const r = buildMaps({ ...trimmed, 'Brand New Valley': { replayPreviewImage: 'x.png' } }, curated.maps, curated.rankedPool, null);
    expect(r.maps.some((m) => m.id === 'cursed-hollow')).toBe(false);
    expect(r.issues.map((i) => i.message).join('\n')).toMatch(/cursed-hollow is curated but not in heroes-data2/);
    expect(r.issues.map((i) => i.message).join('\n')).toMatch(/Brand New Valley/);
    expect(r.issues.map((i) => i.message).join('\n')).not.toMatch(/Sandbox|Arena|Lunar Rocket Racing/);
  });
});
