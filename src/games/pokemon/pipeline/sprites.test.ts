import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { Species } from '../schema.ts';
import { collectSprites, SPRITE_SOURCE, spritePath, toWebp } from './sprites.ts';
import { fakeContext, fakeHttp } from './test-support.ts';

const png = async (): Promise<Uint8Array> =>
  new Uint8Array(await sharp({ create: { width: 4, height: 4, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 1 } } }).png().toBuffer());

const mon = (id: string): Species => ({
  id,
  name: id,
  num: 1,
  types: ['Normal'],
  base: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 },
  abilities: ['x'],
  weightkg: 1,
  legal: ['M-C'],
});

const isWebp = (b: Uint8Array): boolean => new TextDecoder().decode(b.slice(8, 12)) === 'WEBP';

describe('sprites', () => {
  it('converts PNG to lossless WebP', async () => {
    const out = await toWebp(await png());
    expect(isWebp(out)).toBe(true);
    const meta = await sharp(out).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['webp', 4, 4]);
  });

  it('emits nothing when the last-good tree already has every sprite', async () => {
    const old = new Uint8Array([1, 2, 3]);
    const http = fakeHttp({});
    const ctx = fakeContext({ http, previous: { [spritePath('a')]: old, [spritePath('b')]: old } });
    const r = await collectSprites(ctx, [mon('a'), mon('b')], { a: 'a', b: 'b' });
    expect(r.files).toEqual([]);
    expect([...r.paths]).toEqual([
      ['a', 'img/sprites/a.webp'],
      ['b', 'img/sprites/b.webp'],
    ]);
    expect(http.calls).toEqual([]);
  });

  it('fetches the missing ones and re-emits the complete set so stale images get pruned', async () => {
    const old = new Uint8Array([1, 2, 3]);
    const image = await png();
    const http = fakeHttp({ [`${SPRITE_SOURCE}b-mega.png`]: image, [`${SPRITE_SOURCE}c.png`]: new Error('GET -> 404') });
    const ctx = fakeContext({ http, previous: { [spritePath('a')]: old } });
    const r = await collectSprites(ctx, [mon('a'), mon('bmega'), mon('c'), mon('d')], { a: 'a', bmega: 'b-mega', c: 'c' });
    expect(http.calls).toEqual([`bytes ${SPRITE_SOURCE}b-mega.png`, `bytes ${SPRITE_SOURCE}c.png`]);
    expect(r.files.map((f) => f.path)).toEqual(['img/sprites/a.webp', 'img/sprites/bmega.webp']);
    expect(r.files[0]?.bytes).toEqual(old);
    expect(isWebp(r.files[1]?.bytes as Uint8Array)).toBe(true);
    expect(r.files.every((f) => f.custody === 'A')).toBe(true);
    expect(r.fetched).toBe(1);
    expect(r.missing).toEqual(['c', 'd']);
    expect([...r.paths.keys()]).toEqual(['a', 'bmega']);
    // Polite: spaced, cached and keyed for offline fixtures.
    expect(http.inits[0]).toMatchObject({ spacingMs: 250, fixture: 'sprites/b-mega' });
  });

  it('never downloads offline or when the dex was reused', async () => {
    const http = fakeHttp({});
    const offline = await collectSprites(fakeContext({ http, offline: true }), [mon('a')], { a: 'a' });
    const reused = await collectSprites(fakeContext({ http }), [mon('a')], null);
    expect([offline.files, reused.files]).toEqual([[], []]);
    expect(offline.missing).toEqual(['a']);
    expect(http.calls).toEqual([]);
  });
});
