/**
 * HeroesToolChest heroes-images (network only): release tags and per-folder git blob ids from
 * the GitHub API (a handful of unauthenticated calls, only when the image set may change), and
 * individual files from jsDelivr pinned to the tag (immutable, CDN-cached) with
 * raw.githubusercontent.com as the fallback.
 */
import type { Http } from '../../../../core/game.ts';
import { IMAGES_REPO, type ImageFolder, type ImageRef } from '../transform/images.ts';
import { isRecord } from '../util.ts';

const API = `https://api.github.com/repos/${IMAGES_REPO}`;
const GH_HEADERS = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };

export async function fetchImageTags(http: Http): Promise<string[]> {
  const raw = await http.json<unknown>(`${API}/tags?per_page=100`, { fixture: 'heroes-images/tags', ttlHours: 6, headers: GH_HEADERS });
  if (!Array.isArray(raw)) throw new Error('GitHub tags API did not return a list');
  return raw.filter(isRecord).map((t) => t.name).filter((n): n is string => typeof n === 'string');
}

/** `heroesimages/<folder>/<file>` → git blob sha for the folders the site uses. */
export async function fetchBlobIds(http: Http, tag: string, folders: readonly ImageFolder[]): Promise<Map<string, string>> {
  const root = await http.json<unknown>(`${API}/contents/heroesimages?ref=${encodeURIComponent(tag)}`, { fixture: 'heroes-images/contents', ttlHours: 24, headers: GH_HEADERS });
  if (!Array.isArray(root)) throw new Error('GitHub contents API did not return a list');
  const shas = new Map<string, string>();
  for (const e of root) if (isRecord(e) && typeof e.name === 'string' && typeof e.sha === 'string' && e.type === 'dir') shas.set(e.name, e.sha);
  const out = new Map<string, string>();
  for (const folder of folders) {
    const sha = shas.get(folder);
    if (!sha) throw new Error(`heroes-images@${tag} has no ${folder}/ folder`);
    const tree = await http.json<unknown>(`${API}/git/trees/${sha}`, { fixture: `heroes-images/tree-${folder}`, ttlHours: 24 * 30, headers: GH_HEADERS });
    if (!isRecord(tree) || !Array.isArray(tree.tree)) throw new Error(`GitHub tree API returned no tree for ${folder}/`);
    if (tree.truncated === true) throw new Error(`GitHub tree listing for ${folder}/ is truncated`);
    for (const e of tree.tree) if (isRecord(e) && typeof e.path === 'string' && typeof e.sha === 'string') out.set(`heroesimages/${folder}/${e.path}`, e.sha);
  }
  return out;
}

export function cdnUrl(tag: string, ref: Pick<ImageRef, 'folder' | 'file'>): string {
  return `https://cdn.jsdelivr.net/gh/${IMAGES_REPO}@${tag}/heroesimages/${ref.folder}/${encodeURIComponent(ref.file)}`;
}

export function rawUrl(tag: string, ref: Pick<ImageRef, 'folder' | 'file'>): string {
  return `https://raw.githubusercontent.com/${IMAGES_REPO}/${tag}/heroesimages/${ref.folder}/${encodeURIComponent(ref.file)}`;
}

export async function fetchImage(http: Http, tag: string, ref: ImageRef): Promise<Uint8Array> {
  const fixture = `heroes-images/files/${ref.file}`;
  try {
    return await http.bytes(cdnUrl(tag, ref), { fixture, ttlHours: 24 * 90, spacingMs: 60 });
  } catch (err) {
    if (err instanceof Error && 'status' in err && (err as { status: number }).status === 404) throw err;
    return await http.bytes(rawUrl(tag, ref), { fixture, ttlHours: 24 * 90, spacingMs: 100 });
  }
}
