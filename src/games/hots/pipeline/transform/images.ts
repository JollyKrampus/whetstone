/**
 * Image set for img/** (SPEC §5): which heroes-images files the data references, whether the
 * set must be re-emitted, and the WebP conversion. Pure apart from `toWebp` (sharp, CPU only).
 *
 * img/ follows pipeline/run.ts rules: a run that emits no img/** keeps the previous tree; a run
 * that emits any img/** must emit the complete set. So the set is re-emitted only when the
 * heroes-images tag, the converter settings or the referenced files change, and unchanged files
 * are then copied from the previous tree instead of being downloaded again. `img/_index.json`
 * records the tag, converter and each file's source path and git blob id.
 */
import sharp from 'sharp';
import { compareStrings, isRecord } from '../util.ts';

export type ImageFolder = 'heroportraits' | 'abilitytalents' | 'replaypreviews';

export interface ImageRef {
  /** Output path, e.g. `img/icons/storm_ui_icon_abathur_symbiote.webp`. */
  out: string;
  /** File name in heroes-images, e.g. `storm_ui_icon_abathur_symbiote.png`. */
  file: string;
  folder: ImageFolder;
}

/** Size rules per output directory: [max width, max height]. Portraits keep their native size. */
const SIZES: Record<string, [number, number]> = {
  'img/icons/': [64, 64],
  'img/heroes/': [256, 256],
  'img/maps/': [480, 270],
};
export const WEBP_QUALITY = 82;
/** Bump when sizes or encoder settings change: forces a full re-conversion. */
export const CONVERTER = `sharp-webp-q${WEBP_QUALITY}-icons64-v1`;
export const INDEX_PATH = 'img/_index.json';
export const IMAGES_REPO = 'HeroesToolChest/heroes-images';

export interface ImageIndexEntry {
  src: string;
  /** git blob sha of the source at the tag (or sha256 of the downloaded bytes when unknown). */
  blob: string;
}

export interface ImageIndex {
  schema: 1;
  repo: string;
  tag: string;
  converter: string;
  files: Record<string, ImageIndexEntry>;
}

export function srcPath(ref: Pick<ImageRef, 'folder' | 'file'>): string {
  return `heroesimages/${ref.folder}/${ref.file}`;
}

export function parseImageIndex(value: unknown): ImageIndex | null {
  if (!isRecord(value) || value.schema !== 1 || typeof value.tag !== 'string' || typeof value.converter !== 'string' || !isRecord(value.files)) return null;
  const files: Record<string, ImageIndexEntry> = {};
  for (const [k, v] of Object.entries(value.files)) {
    if (isRecord(v) && typeof v.src === 'string' && typeof v.blob === 'string') files[k] = { src: v.src, blob: v.blob };
  }
  return { schema: 1, repo: typeof value.repo === 'string' ? value.repo : IMAGES_REPO, tag: value.tag, converter: value.converter, files };
}

/** Deduplicated refs sorted by output path (first source wins for a shared output name). */
export function normalizeRefs(refs: Iterable<ImageRef>): ImageRef[] {
  const byOut = new Map<string, ImageRef>();
  for (const r of refs) if (!byOut.has(r.out)) byOut.set(r.out, r);
  return [...byOut.values()].sort((a, b) => compareStrings(a.out, b.out));
}

/** True when the previous index already describes exactly this tag, converter and reference set. */
export function indexUnchanged(prev: ImageIndex | null, tag: string, refs: readonly ImageRef[]): boolean {
  if (!prev || prev.tag !== tag || prev.converter !== CONVERTER) return false;
  const keys = Object.keys(prev.files);
  if (keys.length !== refs.length) return false;
  return refs.every((r) => prev.files[r.out]?.src === srcPath(r));
}

export type ImageAction = { ref: ImageRef; action: 'reuse' } | { ref: ImageRef; action: 'download' };

/**
 * Per file: reuse the previous WebP when the source is known to be identical (same blob at the
 * new tag, or same tag and same source path when blob ids are unavailable), else download.
 */
export function planImages(prev: ImageIndex | null, tag: string, refs: readonly ImageRef[], blobs: ReadonlyMap<string, string> | null): ImageAction[] {
  return refs.map((ref) => {
    const p = prev?.converter === CONVERTER ? prev.files[ref.out] : undefined;
    const src = srcPath(ref);
    if (p && p.src === src) {
      const blob = blobs?.get(src);
      if (blob ? blob === p.blob : prev?.tag === tag) return { ref, action: 'reuse' };
    }
    return { ref, action: 'download' };
  });
}

function sizeFor(out: string): [number, number] {
  for (const [prefix, size] of Object.entries(SIZES)) if (out.startsWith(prefix)) return size;
  return [256, 256];
}

/** PNG (or APNG: first frame) → WebP, shrunk to the output's size class. Deterministic for a given libvips. */
export async function toWebp(input: Uint8Array, out: string): Promise<Uint8Array> {
  const [w, h] = sizeFor(out);
  const buf = await sharp(input, { animated: false })
    .resize({ width: w, height: h, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: WEBP_QUALITY, effort: 4, smartSubsample: false })
    .toBuffer();
  return new Uint8Array(buf);
}

/** Neutral placeholder for a referenced image missing upstream (so pages never show a broken image). */
export async function placeholderWebp(out: string): Promise<Uint8Array> {
  const [w, h] = sizeFor(out);
  const size = out.startsWith('img/maps/') ? [w, Math.round((w * 9) / 16)] : [Math.min(w, 128), Math.min(h, 128)];
  const buf = await sharp({ create: { width: size[0] as number, height: size[1] as number, channels: 3, background: { r: 42, g: 38, b: 58 } } })
    .webp({ quality: WEBP_QUALITY, effort: 4 })
    .toBuffer();
  return new Uint8Array(buf);
}

export function buildImageIndex(tag: string, entries: ReadonlyMap<string, ImageIndexEntry>): ImageIndex {
  const files: Record<string, ImageIndexEntry> = {};
  for (const k of [...entries.keys()].sort(compareStrings)) files[k] = entries.get(k) as ImageIndexEntry;
  return { schema: 1, repo: IMAGES_REPO, tag, converter: CONVERTER, files };
}

/** Pick the heroes-images tag for a data build: the newest `v<build>[_n]` tag at or below it (PTR tags only for PTR builds). */
export function pickImageTag(tags: readonly string[], dataBuild: string, compare: (a: string, b: string) => number): string | null {
  const ptr = /_ptr$/.test(dataBuild);
  const candidates = tags
    .map((t) => ({ t, m: /^v?(\d+\.\d+\.\d+\.\d+)(_ptr)?(?:_(\d+))?$/.exec(t) }))
    .filter((x): x is { t: string; m: RegExpExecArray } => x.m !== null && Boolean(x.m[2]) === ptr)
    .map((x) => ({ t: x.t, build: x.m[1] as string, rev: Number(x.m[3] ?? 0) }))
    .filter((x) => compare(x.build, dataBuild.replace(/_ptr$/, '')) <= 0)
    .sort((a, b) => compare(b.build, a.build) || b.rev - a.rev);
  return candidates[0]?.t ?? null;
}
