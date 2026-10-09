/**
 * heroes-images step: WebP portraits, ability/talent icons and map previews under img/**.
 *
 * pipeline/run.ts keeps the previous img/ tree when a run emits no img/** file and treats any
 * img/** output as the complete set. So this step emits nothing when img/_index.json already
 * describes the pinned tag, the converter and exactly the referenced files; otherwise it emits
 * every referenced image (reusing previous WebP bytes whose source blob is unchanged) plus a new
 * index. A referenced file missing upstream gets a neutral placeholder and a warning.
 */
import { jsonBytes, sha256 } from '../../../../../pipeline/hash.ts';
import { OfflineFixtureError } from '../../../../../pipeline/http.ts';
import type { OutputFile } from '../../../../core/game.ts';
import { fetchBlobIds, fetchImage, fetchImageTags } from '../sources/heroesImages.ts';
import {
  INDEX_PATH,
  buildImageIndex,
  indexUnchanged,
  normalizeRefs,
  parseImageIndex,
  pickImageTag,
  placeholderWebp,
  planImages,
  srcPath,
  toWebp,
  type ImageFolder,
  type ImageIndexEntry,
  type ImageRef,
} from '../transform/images.ts';
import { compareBuilds, errorMessage, warn } from '../util.ts';
import { mapPool, previousBytes, selected, setFallback, setNotSelected, setOk, setStatus, type RunEnv } from './common.ts';

/** Parallel downloads (each host is still spaced by pipeline/http.ts). */
const CONCURRENCY = 8;
/** More failed downloads than this share means the source is down, not a few files missing. */
const MAX_FAILED_SHARE = 0.2;
const PLACEHOLDER_TAG = 'placeholder';

export interface ImagesResult {
  files: OutputFile[];
  /** heroes-images tag the img/ tree comes from (emitted now or kept). */
  tag: string | null;
}

function isNotFound(err: unknown): boolean {
  return err instanceof Error && 'status' in err && (err as { status: number }).status === 404;
}

function indexFile(index: unknown): OutputFile {
  // Bytes, not data: img/** is the image tree (no schema), and the index travels with it.
  return { path: INDEX_PATH, data: null, custody: 'A', bytes: jsonBytes(index, true) };
}

async function placeholders(refs: readonly ImageRef[]): Promise<OutputFile[]> {
  const out: OutputFile[] = [];
  for (const r of refs) out.push({ path: r.out, data: null, custody: 'A', bytes: await placeholderWebp(r.out) });
  return out;
}

export async function runImages(env: RunEnv, rawRefs: readonly ImageRef[], dataBuild: string): Promise<ImagesResult> {
  const { ctx } = env;
  const refs = normalizeRefs(rawRefs);
  const prevIndex = parseImageIndex(await env.ctx.previous(INDEX_PATH).catch(() => null));
  const keep = (): ImagesResult => ({ files: [], tag: prevIndex?.tag ?? null });

  if (!selected(env, 'heroes-images')) {
    setNotSelected(env, 'heroes-images');
    return keep();
  }
  if (refs.length === 0) {
    // Hero data fell back to last-good: its images are already on disk.
    setStatus(env, 'heroes-images', prevIndex ? 'ok' : 'failed', prevIndex ? 'unchanged (hero data is last-good)' : 'no image references');
    return keep();
  }

  let tag: string | null = null;
  try {
    tag = pickImageTag(await fetchImageTags(ctx.http), dataBuild, compareBuilds);
    if (!tag) throw new Error(`no heroes-images tag at or below build ${dataBuild}`);
  } catch (err) {
    if (prevIndex && prevIndex.tag !== PLACEHOLDER_TAG) {
      setFallback(env, 'heroes-images', err, true, 'img/ tree');
      return keep();
    }
    setFallback(env, 'heroes-images', err, false, 'images');
    env.issues.push(warn(`heroes-images: emitted ${refs.length} placeholder images`, 'heroes-images'));
    return { files: [...(await placeholders(refs)), indexFile(buildImageIndex(PLACEHOLDER_TAG, new Map()))], tag: null };
  }

  if (indexUnchanged(prevIndex, tag, refs)) {
    setOk(env, 'heroes-images', `unchanged at ${tag}`);
    return { files: [], tag };
  }

  // Git blob ids let unchanged files carry over between tags without downloading them again.
  let blobs: Map<string, string> | null = null;
  if (prevIndex && prevIndex.tag !== tag) {
    const folders = [...new Set(refs.map((r) => r.folder))].sort() as ImageFolder[];
    try {
      blobs = await fetchBlobIds(ctx.http, tag, folders);
    } catch (err) {
      ctx.log(`heroes-images: blob ids unavailable (${errorMessage(err)}); downloading every file`);
    }
  }
  const plan = planImages(prevIndex, tag, refs, blobs);

  const missing: string[] = [];
  const failed: string[] = [];
  let downloaded = 0;
  let reused = 0;
  const entries = new Map<string, ImageIndexEntry>();
  const results = await mapPool(plan, CONCURRENCY, async ({ ref, action }): Promise<OutputFile> => {
    const src = srcPath(ref);
    if (action === 'reuse') {
      const bytes = await previousBytes(env, ref.out);
      const prev = prevIndex?.files[ref.out];
      if (bytes && prev) {
        reused++;
        entries.set(ref.out, prev);
        return { path: ref.out, data: null, custody: 'A', bytes };
      }
    }
    try {
      const raw = await fetchImage(ctx.http, tag, ref);
      const bytes = await toWebp(raw, ref.out);
      downloaded++;
      entries.set(ref.out, { src, blob: blobs?.get(src) ?? sha256(raw) });
      return { path: ref.out, data: null, custody: 'A', bytes };
    } catch (err) {
      if (isNotFound(err) || err instanceof OfflineFixtureError) missing.push(ref.file);
      else failed.push(`${ref.file}: ${errorMessage(err)}`);
      // No index entry: the next run retries the file.
      return { path: ref.out, data: null, custody: 'A', bytes: await placeholderWebp(ref.out) };
    }
  });

  if (failed.length > Math.max(5, plan.length * MAX_FAILED_SHARE)) {
    const err = new Error(`${failed.length} of ${plan.length} image downloads failed (first: ${failed[0]})`);
    if (prevIndex && prevIndex.tag !== PLACEHOLDER_TAG) {
      setFallback(env, 'heroes-images', err, true, 'img/ tree');
      return keep();
    }
    setFallback(env, 'heroes-images', err, false, 'images');
    return { files: [...results, indexFile(buildImageIndex(PLACEHOLDER_TAG, entries))], tag: null };
  }
  if (missing.length > 0) {
    const what = ctx.offline ? 'not in the offline fixtures' : `missing from heroes-images@${tag}`;
    env.issues.push(warn(`heroes-images: ${missing.length} referenced image(s) ${what}; placeholders used (${missing.sort().slice(0, 5).join(', ')}${missing.length > 5 ? ', …' : ''})`, 'heroes-images'));
  }
  if (failed.length > 0) {
    env.issues.push(warn(`heroes-images: ${failed.length} download(s) failed; placeholders used (${failed.slice(0, 3).join('; ')})`, 'heroes-images'));
  }
  ctx.log(`heroes-images@${tag}: ${refs.length} images (${downloaded} converted, ${reused} reused, ${missing.length + failed.length} placeholders)`);
  setOk(env, 'heroes-images', `${tag}: ${refs.length} images`);
  return { files: [...results, indexFile(buildImageIndex(tag, entries))], tag };
}
