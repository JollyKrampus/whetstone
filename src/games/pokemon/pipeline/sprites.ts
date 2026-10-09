/**
 * Self-hosted sprite subset (critique D12): one small WebP per exported species/Mega under
 * img/sprites/<id>.webp, converted from Pokémon Showdown's gen5-style sprite set.
 *
 * Why this is defensible: the images stay © Nintendo/Creatures/GAME FREAK/The Pokémon Company
 * (the newer ones were drawn by the Smogon sprite project for Showdown); Whetstone is
 * non-commercial, credits the source, carries the non-affiliation notice on every page, and
 * self-hosts rather than hotlinking, as Showdown and @pkmn/img ask third parties to do. Only
 * the legal roster (~350 images, a few hundred KB) is mirrored, and only when it changes.
 * When a sprite is missing upstream the species simply has no `sprite` and the UI falls back
 * to type-coloured initials.
 *
 * img/ rule (docs/DATA.md): when every species already has its image in the last-good tree,
 * nothing under img/ is emitted and the tree is kept as is; otherwise the complete set is
 * re-emitted (previous bytes + newly fetched ones), so the runner can prune stale images.
 */
import type { OutputFile, PipelineContext } from '../../../core/game.ts';
import type { Species } from '../schema.ts';
import { errorMessage } from './common.ts';

export const SPRITE_SOURCE = 'https://play.pokemonshowdown.com/sprites/gen5/';
export const SPRITE_CREDIT = 'Sprites: Pokémon Showdown gen5 sprite set (Smogon sprite project); Pokémon images © Nintendo, Creatures and GAME FREAK.';
/** Polite spacing between sprite downloads (only on roster changes). */
const SPRITE_SPACING_MS = 250;

export const spritePath = (id: string): string => `img/sprites/${id}.webp`;

export interface SpriteResult {
  /** img/** outputs; empty when the existing tree already covers every species. */
  files: OutputFile[];
  /** species id → img path, for species that have a sprite after this run. */
  paths: Map<string, string>;
  fetched: number;
  missing: string[];
}

/** PNG (or any image sharp reads) → lossless WebP, which keeps pixel art crisp and small. */
export async function toWebp(png: Uint8Array): Promise<Uint8Array> {
  const sharp = (await import('sharp')).default;
  const out = await sharp(png).webp({ lossless: true, effort: 6 }).toBuffer();
  return new Uint8Array(out);
}

export async function collectSprites(
  ctx: PipelineContext,
  species: readonly Species[],
  /** species id → Showdown sprite id (e.g. garchomp-megaz); absent when the dex was reused. */
  spriteIds: Readonly<Record<string, string>> | null,
): Promise<SpriteResult> {
  const previous = new Map<string, Uint8Array>();
  for (const s of species) {
    const bytes = await ctx.previous(spritePath(s.id));
    if (bytes instanceof Uint8Array && bytes.byteLength > 0) previous.set(s.id, bytes);
  }
  const paths = new Map<string, string>();
  const lacking = species.filter((s) => !previous.has(s.id));
  if (lacking.length === 0 || ctx.offline || !spriteIds) {
    for (const id of previous.keys()) paths.set(id, spritePath(id));
    return { files: [], paths, fetched: 0, missing: lacking.map((s) => s.id) };
  }

  const fresh = new Map<string, Uint8Array>();
  const missing: string[] = [];
  for (const s of lacking) {
    const spriteId = spriteIds[s.id];
    if (!spriteId) {
      missing.push(s.id);
      continue;
    }
    try {
      const png = await ctx.http.bytes(`${SPRITE_SOURCE}${spriteId}.png`, { spacingMs: SPRITE_SPACING_MS, ttlHours: 24 * 30, fixture: `sprites/${spriteId}` });
      fresh.set(s.id, await toWebp(png));
    } catch (err) {
      ctx.log(`sprite ${spriteId}: ${errorMessage(err)}`);
      missing.push(s.id);
    }
  }
  const files: OutputFile[] = [];
  for (const s of species) {
    const bytes = fresh.get(s.id) ?? previous.get(s.id);
    if (!bytes) continue;
    files.push({ path: spritePath(s.id), data: null, bytes, custody: 'A' });
    paths.set(s.id, spritePath(s.id));
  }
  return { files, paths, fetched: fresh.size, missing };
}
