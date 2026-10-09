/**
 * HeroesToolChest heroes-data2 (network only). The release zip is downloaded over HTTPS from
 * github.com releases; `.version.json` gates which build exists; the GitHub releases API (one
 * unauthenticated call) supplies build publish dates for patch/diff dating.
 */
import { unzipSync } from 'fflate';
import type { Http } from '../../../../core/game.ts';
import { readRelease, wantedEntry, type RawRelease } from '../transform/release.ts';
import type { BuildDate } from '../transform/patchset.ts';
import { BUILD_RE, isRecord } from '../util.ts';

export const HD2_REPO = 'HeroesToolChest/heroes-data2';
export const VERSION_URL = `https://raw.githubusercontent.com/${HD2_REPO}/main/heroesdata/.version.json`;
export const RELEASES_API = `https://api.github.com/repos/${HD2_REPO}/releases?per_page=100`;

export interface VersionInfo {
  latest: string;
  versions: string[];
}

export async function fetchVersionInfo(http: Http): Promise<VersionInfo> {
  const raw = await http.json<unknown>(VERSION_URL, { fixture: 'heroes-data2/version', ttlHours: 1 });
  if (!isRecord(raw) || typeof raw.latest !== 'string' || !Array.isArray(raw.versions)) throw new Error('.version.json has no "latest"/"versions"');
  const versions = raw.versions.filter((v): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+\.\d+(_ptr)?$/.test(v));
  return { latest: raw.latest, versions };
}

/** Release tag → publish date for every heroes-data2 release (empty on failure: dates are optional). */
export async function fetchReleaseDates(http: Http): Promise<BuildDate[]> {
  const raw = await http.json<unknown>(RELEASES_API, {
    fixture: 'heroes-data2/releases',
    ttlHours: 6,
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!Array.isArray(raw)) throw new Error('GitHub releases API did not return a list');
  const out: BuildDate[] = [];
  for (const r of raw) {
    if (!isRecord(r) || typeof r.tag_name !== 'string' || typeof r.published_at !== 'string') continue;
    const build = r.tag_name.replace(/^v/, '').replace(/_\d+$/, '');
    if (!BUILD_RE.test(build.replace(/_ptr$/, ''))) continue;
    out.push({ build, date: r.published_at.slice(0, 10) });
  }
  return out;
}

export function releaseZipUrl(tag: string, build: string): string {
  return `https://github.com/${HD2_REPO}/releases/download/${tag}/heroes-data-no-maps-${build}.zip`;
}

/** Downloads and unzips one release (`v<build>` tag, falling back to the bare build tag). */
export async function fetchRelease(http: Http, build: string, opts: { locales: boolean }): Promise<RawRelease> {
  let bytes: Uint8Array | null = null;
  let lastError: unknown = null;
  for (const tag of [`v${build}`, build]) {
    try {
      bytes = await http.bytes(releaseZipUrl(tag, build), { fixture: `heroes-data2/heroes-data-no-maps-${build}`, ttlHours: 24 * 30, timeoutMs: 180_000 });
      break;
    } catch (err) {
      lastError = err;
      if (!(err instanceof Error && 'status' in err && (err as { status: number }).status === 404)) break;
    }
  }
  if (!bytes) throw lastError instanceof Error ? lastError : new Error(`release ${build} could not be downloaded`);
  const files = unzipSync(bytes, { filter: (f) => wantedEntry(f.name, opts) });
  return readRelease(files);
}
