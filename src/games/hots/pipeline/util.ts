/**
 * Small pure helpers shared by the HotS pipeline (sources, transforms, orchestration).
 * Node-only module tree, but nothing here touches the network or the file system.
 */
import { compareStrings, sha256 } from '../../../../pipeline/hash.ts';
import type { SourceState, SourceStatus, ValidationIssue } from '../../../core/game.ts';

export { compareStrings, sha256 };

/** Source ids, matching module.ts `sources[].id` (meta.json statuses are keyed by them). */
export const SOURCE_IDS = [
  'tact',
  'heroes-data2',
  'heroes-images',
  'blizzard-news',
  'nexus-compendium',
  'liquipedia',
  'heroesprofile',
  'youtube',
  'twitch',
] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export function warn(message: string, source?: SourceId): ValidationIssue {
  return source === undefined ? { level: 'warn', message } : { level: 'warn', source, message };
}

export function error(message: string, source?: SourceId): ValidationIssue {
  return source === undefined ? { level: 'error', message } : { level: 'error', source, message };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Lowercase, accent-free letters and digits only (same key as load.ts `searchKey`). */
export function searchKey(text: string): string {
  return deaccent(text).toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

export function deaccent(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}

/** Hero slug (SPEC §5): lowercase ASCII alphanumerics of the English name (`Li-Ming` → `liming`). */
export function heroSlug(name: string): string {
  return deaccent(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Kebab-case slug for maps (`Blackheart's Bay` → `blackhearts-bay`). */
export function kebabSlug(name: string): string {
  return deaccent(name)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Outbound slug used by most fan sites (hots-meta-extra §3.2): accents and apostrophes and dots
 * removed, spaces to dashes. `Li-Ming` → `li-ming`, `E.T.C.` → `etc`, `The Butcher` → `the-butcher`.
 */
export function outboundSlug(name: string): string {
  return deaccent(name).toLowerCase().replace(/['’]/g, '').replace(/\./g, '').trim().replace(/\s+/g, '-');
}

/** `2.57.0.98348` → [2, 57, 0, 98348]; `_ptr` suffix ignored. */
export function buildParts(build: string): number[] {
  return build.replace(/_ptr$/, '').split('.').map((p) => Number(p));
}

/** Numeric build comparison (`2.55.17.98025` < `2.57.0.98285`). */
export function compareBuilds(a: string, b: string): number {
  const pa = buildParts(a);
  const pb = buildParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export function isPtrBuild(build: string): boolean {
  return /_ptr$/.test(build);
}

/** Major patch of a build (`2.57.0.98348` → `2.57`). */
export function majorOf(build: string): string {
  const [a, b] = buildParts(build);
  return `${a}.${b}`;
}

export const BUILD_RE = /^\d+\.\d+\.\d+\.\d+$/;

/** `YYYY-MM-DD` of a Date or ISO string, in UTC. */
export function isoDate(value: Date | string): string {
  return (typeof value === 'string' ? new Date(value) : value).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

/** Whole days from `a` to `b` (`YYYY-MM-DD` or ISO). */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b.length === 10 ? `${b}T00:00:00Z` : b) - Date.parse(a.length === 10 ? `${a}T00:00:00Z` : a)) / 86_400_000);
}

export function round(value: number, digits = 4): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

export function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareStrings);
}

export function byKey<T>(key: (x: T) => string): (a: T, b: T) => number {
  return (a, b) => compareStrings(key(a), key(b));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

/** First 16 hex chars of sha256 (content hashes stored in data files). */
export function hash16(text: string | Uint8Array): string {
  return sha256(text).slice(0, 16);
}

/** Status entry helpers (omit optional keys instead of writing undefined). */
export function status(id: SourceId, state: SourceState, fetchedAt: string | null, detail?: string): SourceStatus {
  return detail === undefined ? { id, fetchedAt, status: state } : { id, fetchedAt, status: state, detail };
}

/** HTML entity decoding for the handful of entities that occur in game text and articles. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, ent: string) => {
    const lower = ent.toLowerCase();
    if (lower.startsWith('#x')) return safeCodePoint(parseInt(lower.slice(2), 16), m);
    if (lower.startsWith('#')) return safeCodePoint(parseInt(lower.slice(1), 10), m);
    return NAMED_ENTITIES[lower] ?? m;
  });
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  hellip: '…',
  rarr: '→',
  times: '×',
};

function safeCodePoint(cp: number, fallback: string): string {
  return Number.isInteger(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : fallback;
}

/** Collapse whitespace, drop zero-width characters and trim. */
export function cleanText(text: string): string {
  return text.replace(/[\u200B-\u200D\uFEFF]/g, '').replace(/\s+/g, ' ').trim();
}
