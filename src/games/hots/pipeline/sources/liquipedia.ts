/**
 * Liquipedia MediaWiki API (network only), per its API terms: a custom User-Agent with contact,
 * gzip, at most one request per 2 seconds, `action=query` only (no `action=parse`, no HTML pages).
 * Batches up to 50 titles per request.
 */
import type { Http } from '../../../../core/game.ts';
import { isRecord } from '../util.ts';

export const API_URL = 'https://liquipedia.net/heroes/api.php';
export const SPACING_MS = 2100;
const BATCH = 50;

export function liquipediaUserAgent(contact?: string): string {
  const extra = contact?.trim();
  return `Whetstone/0.1 (+https://github.com/JollyKrampus/whetstone; contact via GitHub issues${extra ? `; ${extra}` : ''})`;
}

export interface LiquipediaClient {
  query(params: Record<string, string>, fixture: string): Promise<Record<string, unknown>>;
}

export function createLiquipediaClient(http: Http, contact?: string): LiquipediaClient {
  const ua = liquipediaUserAgent(contact);
  return {
    async query(params, fixture) {
      const qs = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params });
      const raw = await http.json<unknown>(`${API_URL}?${qs.toString()}`, {
        fixture: `liquipedia/${fixture}`,
        spacingMs: SPACING_MS,
        ttlHours: 6,
        timeoutMs: 60_000,
        headers: { 'user-agent': ua, 'accept-encoding': 'gzip' },
      });
      if (!isRecord(raw)) throw new Error('Liquipedia API returned no object');
      if (isRecord(raw.error)) throw new Error(`Liquipedia API error: ${String(raw.error.info ?? raw.error.code ?? 'unknown')}`);
      return raw;
    },
  };
}

function pagesOf(raw: Record<string, unknown>): Record<string, unknown>[] {
  const q = isRecord(raw.query) ? raw.query : {};
  return Array.isArray(q.pages) ? q.pages.filter(isRecord) : [];
}

/** Titles of main-namespace pages edited since `since` (ISO). */
export async function recentChanges(lp: LiquipediaClient, since: string): Promise<string[]> {
  const raw = await lp.query({ list: 'recentchanges', rcnamespace: '0', rclimit: '500', rcprop: 'title|timestamp', rcend: since, rctype: 'edit|new' }, 'recentchanges');
  const q = isRecord(raw.query) ? raw.query : {};
  const list = Array.isArray(q.recentchanges) ? q.recentchanges.filter(isRecord) : [];
  return [...new Set(list.map((c) => c.title).filter((t): t is string => typeof t === 'string'))];
}

/** Tournament page titles whose infobox starts in `year` (`sdate=` and the one-day `date=` form). */
export async function searchTournaments(lp: LiquipediaClient, year: number): Promise<string[]> {
  const titles = new Set<string>();
  for (const field of ['sdate', 'date'] as const) {
    const raw = await lp.query({ list: 'search', srsearch: `insource:"${field}=${year}"`, srlimit: '100', srnamespace: '0', srprop: 'timestamp' }, `search-${field}-${year}`);
    const q = isRecord(raw.query) ? raw.query : {};
    for (const s of Array.isArray(q.search) ? q.search.filter(isRecord) : []) if (typeof s.title === 'string') titles.add(s.title);
  }
  return [...titles].sort();
}

export interface WikiPage {
  title: string;
  wikitext: string;
  revid: number;
}

/** Latest wikitext of each title (missing pages are left out). */
export async function fetchPages(lp: LiquipediaClient, titles: readonly string[], fixturePrefix = 'revisions'): Promise<WikiPage[]> {
  const out: WikiPage[] = [];
  for (let i = 0; i < titles.length; i += BATCH) {
    const batch = titles.slice(i, i + BATCH);
    const raw = await lp.query({ prop: 'revisions', rvprop: 'content|ids', rvslots: 'main', titles: batch.join('|') }, `${fixturePrefix}-${i / BATCH + 1}`);
    for (const p of pagesOf(raw)) {
      const rev = Array.isArray(p.revisions) && isRecord(p.revisions[0]) ? p.revisions[0] : null;
      const slots = rev && isRecord(rev.slots) && isRecord(rev.slots.main) ? rev.slots.main : null;
      const content = slots && typeof slots.content === 'string' ? slots.content : null;
      if (typeof p.title === 'string' && content !== null) out.push({ title: p.title, wikitext: content, revid: typeof rev?.revid === 'number' ? rev.revid : 0 });
    }
  }
  return out;
}

/** Requested title → existing (normalised) page title, for titles whose page exists. */
export async function existingPages(lp: LiquipediaClient, titles: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < titles.length; i += BATCH) {
    const batch = titles.slice(i, i + BATCH);
    const raw = await lp.query({ titles: batch.join('|'), redirects: '1' }, `pages-${i / BATCH + 1}`);
    const q = isRecord(raw.query) ? raw.query : {};
    const rename = new Map<string, string>();
    for (const key of ['normalized', 'redirects'] as const) {
      for (const n of Array.isArray(q[key]) ? (q[key] as unknown[]).filter(isRecord) : []) if (typeof n.from === 'string' && typeof n.to === 'string') rename.set(n.from, n.to);
    }
    const existing = new Set(pagesOf(raw).filter((p) => p.missing !== true && p.invalid !== true && typeof p.title === 'string').map((p) => p.title as string));
    for (const t of batch) {
      let final = t;
      for (let hops = 0; hops < 3 && rename.has(final); hops++) final = rename.get(final) as string;
      if (existing.has(final)) out.set(t, final);
    }
  }
  return out;
}
