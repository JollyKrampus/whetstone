import { describe, expect, it } from 'vitest';
import type { Http } from '../../../../core/game.ts';
import { fetchUploads, parseDuration } from './youtube.ts';

describe('parseDuration', () => {
  it('reads ISO 8601 durations', () => {
    expect(parseDuration('PT45S')).toBe(45);
    expect(parseDuration('PT1H2M3S')).toBe(3723);
    expect(parseDuration('P1DT1M')).toBe(86460);
    expect(parseDuration('nonsense')).toBeUndefined();
    expect(parseDuration(undefined)).toBeUndefined();
  });
});

describe('fetchUploads', () => {
  it('reads uploads playlists, then video details, with the key redacted from fixture names', async () => {
    const urls: string[] = [];
    const fixtures: string[] = [];
    const http: Http = {
      async json<T>(url: string, init?: { fixture?: string }): Promise<T> {
        urls.push(url);
        fixtures.push(init?.fixture ?? '');
        if (url.includes('/channels?')) return { items: [{ id: 'UCaaaaaaaaaaaaaaaaaaaaaa', contentDetails: { relatedPlaylists: { uploads: 'UUaaaa' } } }] } as T;
        if (url.includes('/playlistItems?')) return { items: [{ contentDetails: { videoId: 'abcdefghijk' } }] } as T;
        return {
          items: [
            {
              id: 'abcdefghijk',
              snippet: { channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', channelTitle: 'C', title: 'T', publishedAt: '2026-10-07T10:00:00Z', description: 'd', defaultAudioLanguage: 'en' },
              contentDetails: { duration: 'PT10M' },
              statistics: { viewCount: '42' },
            },
          ],
        } as T;
      },
      text: async () => '',
      bytes: async () => new Uint8Array(),
      head: async () => ({}),
    };
    const out = await fetchUploads(http, 'KEY', ['UCaaaaaaaaaaaaaaaaaaaaaa']);
    expect(out).toEqual([{ id: 'abcdefghijk', channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa', channel: 'C', title: 'T', description: 'd', published: '2026-10-07T10:00:00Z', durationSec: 600, views: 42, lang: 'en' }]);
    expect(urls).toHaveLength(3);
    expect(fixtures.every((f) => f.startsWith('youtube/') && !f.includes('KEY'))).toBe(true);
  });
});
