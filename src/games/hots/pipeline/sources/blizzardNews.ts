/**
 * Blizzard news (network only): the Heroes of the Storm feed JSON (15 items per page) and
 * article HTML (hots-static.md §5.1 #5/#6). Polite: a few requests a day, 1.5 s apart.
 */
import type { Http } from '../../../../core/game.ts';
import { asString, isRecord } from '../util.ts';

export const FEED_URL = 'https://news.blizzard.com/en-us/api/feed/heroes-of-the-storm';
const SPACING_MS = 1500;
const MAX_PAGES = 6;

export interface FeedItem {
  newsId: string;
  title: string;
  url: string;
  /** ISO timestamp (feed `lastUpdated`). */
  published: string;
}

/** Feed items newer than `since` (YYYY-MM-DD), newest first. */
export async function fetchFeed(http: Http, since: string): Promise<FeedItem[]> {
  const items: FeedItem[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * 15;
    const raw = await http.json<unknown>(`${FEED_URL}?offset=${offset}`, { fixture: `blizzard-news/feed-${offset}`, spacingMs: SPACING_MS, ttlHours: 2 });
    if (!isRecord(raw) || !Array.isArray(raw.contentItems)) throw new Error('news feed has no contentItems');
    let oldest = '9999';
    for (const it of raw.contentItems) {
      const p = isRecord(it) && isRecord(it.properties) ? it.properties : null;
      if (!p) continue;
      const title = asString(p.title);
      const url = asString(p.newsUrl);
      const published = asString(p.lastUpdated);
      const newsId = asString(p.newsId) ?? (typeof p.newsId === 'number' ? String(p.newsId) : undefined);
      if (!title || !url || !published || !newsId) continue;
      if (published < oldest) oldest = published;
      if (published.slice(0, 10) >= since) items.push({ newsId, title, url, published });
    }
    const hasNext = isRecord(raw.pagination) && raw.pagination.hasNextPage === true;
    if (!hasNext || oldest.slice(0, 10) < since) break;
  }
  return items;
}

export async function fetchArticle(http: Http, item: FeedItem): Promise<string> {
  return http.text(item.url, { fixture: `blizzard-news/article-${item.newsId}`, spacingMs: SPACING_MS, ttlHours: 6, headers: { accept: 'text/html' } });
}
