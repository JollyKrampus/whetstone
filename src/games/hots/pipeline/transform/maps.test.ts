import { describe, expect, it } from 'vitest';
import { MapsFileSchema } from '../../schema.ts';
import { fixtureRelease, testCurated } from '../test-helpers.ts';
import { buildMaps } from './maps.ts';

const curated = testCurated();
const mapdata = fixtureRelease('2.57.0.98348').maps;

describe('buildMaps', () => {
  const built = buildMaps(mapdata, curated.maps, curated.rankedPool);

  it('publishes every curated map found in mapdata, sorted, schema-valid', () => {
    expect(built.maps.map((m) => m.id)).toEqual(Object.keys(curated.maps.maps).sort());
    expect(MapsFileSchema.safeParse(built.maps).success).toBe(true);
    expect(built.issues).toEqual([]);
  });

  it('always takes the ranked flag from ranked-pool.yaml', () => {
    for (const m of built.maps) {
      expect(m.rankedSource).toBe('curated');
      expect(m.ranked).toBe(m.kind === 'standard' && curated.rankedPool.maps.includes(m.id));
    }
    expect(built.maps.find((m) => m.id === 'cursed-hollow')).toMatchObject({ kind: 'standard', ranked: true, image: 'img/maps/replayspreviewimage_cursedhollow.webp' });
  });

  it('never ranks ARAM maps and writes no third-party map ids', () => {
    expect(built.maps.filter((m) => m.kind === 'aram').every((m) => !m.ranked)).toBe(true);
    // curated/hots/maps.yaml may still carry legacy Heroes Profile map refs; maps.json never does.
    expect(built.maps.every((m) => !('hp' in m))).toBe(true);
  });

  it('lists the preview image of every published map', () => {
    expect(built.images.map((i) => i.out).sort()).toEqual(built.maps.map((m) => m.image).sort());
    expect(built.images.every((i) => i.folder === 'replaypreviews')).toBe(true);
  });

  it('reports curated maps missing upstream and unknown non-brawl maps', () => {
    const { Lost: _drop, ...rest } = { Lost: null, ...mapdata };
    const trimmed = Object.fromEntries(Object.entries(rest).filter(([k]) => k !== 'Cursed Hollow'));
    const r = buildMaps({ ...trimmed, 'Brand New Valley': { replayPreviewImage: 'x.png' } }, curated.maps, curated.rankedPool);
    expect(r.maps.some((m) => m.id === 'cursed-hollow')).toBe(false);
    expect(r.issues.map((i) => i.message).join('\n')).toMatch(/cursed-hollow is curated but not in heroes-data2/);
    expect(r.issues.map((i) => i.message).join('\n')).toMatch(/Brand New Valley/);
    expect(r.issues.map((i) => i.message).join('\n')).not.toMatch(/Sandbox|Arena|Lunar Rocket Racing/);
  });
});
