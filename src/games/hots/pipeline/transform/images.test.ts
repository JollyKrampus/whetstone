import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { rawFixture } from '../test-helpers.ts';
import { compareBuilds } from '../util.ts';
import { CONVERTER, buildImageIndex, indexUnchanged, normalizeRefs, parseImageIndex, pickImageTag, placeholderWebp, planImages, srcPath, toWebp, type ImageRef } from './images.ts';

const TAGS = ['v20250516.1', 'v2.57.0.98285', 'v2.57.0.98217_ptr', 'v2.55.17.98025', 'v2.55.16.97039_2', 'v2.55.16.97039'];
const REFS: ImageRef[] = [
  { out: 'img/icons/a.webp', file: 'a.png', folder: 'abilitytalents' },
  { out: 'img/heroes/p.webp', file: 'p.png', folder: 'heroportraits' },
];

describe('pickImageTag', () => {
  it('pins the newest build tag at or below the data build', () => {
    expect(pickImageTag(TAGS, '2.57.0.98348', compareBuilds)).toBe('v2.57.0.98285');
    expect(pickImageTag(TAGS, '2.55.16.97039', compareBuilds)).toBe('v2.55.16.97039_2');
    expect(pickImageTag(TAGS, '2.57.0.98217_ptr', compareBuilds)).toBe('v2.57.0.98217_ptr');
    expect(pickImageTag(TAGS, '2.50.0.1', compareBuilds)).toBeNull();
  });
});

describe('index and plan', () => {
  const index = buildImageIndex(
    'v2.57.0.98285',
    new Map(REFS.map((r) => [r.out, { src: srcPath(r), blob: `sha-${r.file}` }])),
  );

  it('round-trips the index and detects an unchanged set', () => {
    expect(parseImageIndex(JSON.parse(JSON.stringify(index)))).toEqual(index);
    expect(parseImageIndex({ schema: 2 })).toBeNull();
    expect(indexUnchanged(index, 'v2.57.0.98285', normalizeRefs(REFS))).toBe(true);
    expect(indexUnchanged(index, 'v2.58.0.1', REFS)).toBe(false);
    expect(indexUnchanged(index, 'v2.57.0.98285', [REFS[0] as ImageRef])).toBe(false);
    expect(indexUnchanged({ ...index, converter: 'old' }, 'v2.57.0.98285', REFS)).toBe(false);
  });

  it('reuses files whose blob is unchanged at a new tag and downloads the rest', () => {
    const blobs = new Map([
      [srcPath(REFS[0] as ImageRef), 'sha-a.png'],
      [srcPath(REFS[1] as ImageRef), 'changed'],
    ]);
    expect(planImages(index, 'v2.58.0.1', REFS, blobs).map((p) => p.action)).toEqual(['reuse', 'download']);
    // Without blob ids, only the same tag allows reuse.
    expect(planImages(index, 'v2.58.0.1', REFS, null).map((p) => p.action)).toEqual(['download', 'download']);
    expect(planImages(index, 'v2.57.0.98285', REFS, null).map((p) => p.action)).toEqual(['reuse', 'reuse']);
    expect(planImages(null, 'v2.57.0.98285', REFS, null).map((p) => p.action)).toEqual(['download', 'download']);
    expect(index.converter).toBe(CONVERTER);
  });

  it('deduplicates refs by output path', () => {
    expect(normalizeRefs([...REFS, { ...(REFS[0] as ImageRef), file: 'other.png' }]).map((r) => r.file)).toEqual(['p.png', 'a.png']);
  });
});

describe('WebP conversion', () => {
  const png = new Uint8Array(rawFixture('heroes-images/files/storm_ui_icon_abathur_symbiote.png.bin'));

  it('converts deterministically to WebP within the size class', async () => {
    const a = await toWebp(png, 'img/icons/x.webp');
    const b = await toWebp(png, 'img/icons/x.webp');
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
    const meta = await sharp(a).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBeLessThanOrEqual(64);
  });

  it('makes neutral placeholders (16:9 for maps)', async () => {
    const icon = await sharp(await placeholderWebp('img/icons/x.webp')).metadata();
    const map = await sharp(await placeholderWebp('img/maps/x.webp')).metadata();
    expect([icon.format, icon.width, icon.height]).toEqual(['webp', 64, 64]);
    expect(map.width && map.height ? Math.round((map.width / map.height) * 9) : 0).toBe(16);
  });
});
