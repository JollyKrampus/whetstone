/**
 * Card images, hotlinked from Scryfall's image CDN (cards.scryfall.io) with credit, built from
 * the Scryfall id stored in the card shards so no API call is needed. Images are shown whole
 * (never cropped), keeping the artist and copyright lines Scryfall asks us to keep.
 * Browser-safe.
 */

export type ImageSize = 'small' | 'normal' | 'large';

/** Native pixel sizes of Scryfall's JPG versions (for width/height attributes, no layout shift). */
export const IMAGE_SIZES: Readonly<Record<ImageSize, { width: number; height: number }>> = {
  small: { width: 146, height: 204 },
  normal: { width: 488, height: 680 },
  large: { width: 672, height: 936 },
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Layouts whose back face has its own image. */
const TWO_IMAGE_LAYOUTS = new Set(['transform', 'modal_dfc', 'double_faced_token', 'reversible_card']);

export const IMAGE_CREDIT = 'Card image: Scryfall';

/** https://cards.scryfall.io/<size>/<face>/<a>/<b>/<id>.jpg, or null for a malformed id. */
export function cardImageUrl(scryfallId: string | undefined, size: ImageSize = 'normal', face: 'front' | 'back' = 'front'): string | null {
  if (!scryfallId || !UUID.test(scryfallId)) return null;
  return `https://cards.scryfall.io/${size}/${face}/${scryfallId[0]}/${scryfallId[1]}/${scryfallId}.jpg`;
}

export function hasBackImage(layout: string): boolean {
  return TWO_IMAGE_LAYOUTS.has(layout);
}

/** The card's page on scryfall.com (printing used for the image). */
export function scryfallCardUrl(set: string | undefined, cn: string | undefined, name: string): string {
  if (set && cn) return `https://scryfall.com/card/${encodeURIComponent(set)}/${encodeURIComponent(cn)}`;
  return `https://scryfall.com/search?q=${encodeURIComponent(`!"${name}"`)}`;
}
