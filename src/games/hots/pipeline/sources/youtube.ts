/**
 * YouTube Data API v3 (network only; class C, artifact-only). Uses only documented list calls:
 * channels.list (uploads playlist ids, 1 unit), playlistItems.list (1 unit per channel) and
 * videos.list (1 unit per 50 videos) — about 15 units a day for a dozen channels. The API key
 * travels as the `key` query parameter, which pipeline/http.ts redacts from logs and caches.
 */
import type { Http } from '../../../../core/game.ts';
import { isRecord } from '../util.ts';

const API = 'https://www.googleapis.com/youtube/v3';

export interface RawVideo {
  id: string;
  channelId: string;
  channel: string;
  title: string;
  description: string;
  published: string;
  durationSec?: number;
  views?: number;
  lang?: string;
}

/** ISO 8601 duration (`PT1H2M3S`) → seconds. */
export function parseDuration(iso: string | undefined): number | undefined {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso ?? '');
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

function items(raw: unknown): Record<string, unknown>[] {
  return isRecord(raw) && Array.isArray(raw.items) ? raw.items.filter(isRecord) : [];
}

export async function fetchUploads(http: Http, key: string, channelIds: readonly string[], perChannel = 15): Promise<RawVideo[]> {
  const uploads = new Map<string, string>();
  for (let i = 0; i < channelIds.length; i += 50) {
    const ids = channelIds.slice(i, i + 50).join(',');
    const raw = await http.json<unknown>(`${API}/channels?part=contentDetails,snippet&id=${ids}&maxResults=50&key=${encodeURIComponent(key)}`, { fixture: 'youtube/channels', ttlHours: 24 });
    for (const c of items(raw)) {
      const cd = isRecord(c.contentDetails) && isRecord(c.contentDetails.relatedPlaylists) ? c.contentDetails.relatedPlaylists : null;
      if (typeof c.id === 'string' && cd && typeof cd.uploads === 'string') uploads.set(c.id, cd.uploads);
    }
  }
  const videoIds: string[] = [];
  for (const channelId of channelIds) {
    const playlist = uploads.get(channelId);
    if (!playlist) continue;
    const raw = await http.json<unknown>(`${API}/playlistItems?part=contentDetails&playlistId=${playlist}&maxResults=${perChannel}&key=${encodeURIComponent(key)}`, { fixture: `youtube/playlist-${channelId}`, ttlHours: 3 });
    for (const it of items(raw)) {
      const vid = isRecord(it.contentDetails) ? it.contentDetails.videoId : undefined;
      if (typeof vid === 'string') videoIds.push(vid);
    }
  }
  const out: RawVideo[] = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const ids = videoIds.slice(i, i + 50).join(',');
    const raw = await http.json<unknown>(`${API}/videos?part=contentDetails,snippet,statistics&id=${ids}&maxResults=50&key=${encodeURIComponent(key)}`, { fixture: `youtube/videos-${i / 50 + 1}`, ttlHours: 3 });
    for (const v of items(raw)) {
      const sn = isRecord(v.snippet) ? v.snippet : {};
      const cd = isRecord(v.contentDetails) ? v.contentDetails : {};
      const st = isRecord(v.statistics) ? v.statistics : {};
      if (typeof v.id !== 'string' || typeof sn.channelId !== 'string' || typeof sn.title !== 'string' || typeof sn.publishedAt !== 'string') continue;
      const video: RawVideo = {
        id: v.id,
        channelId: sn.channelId,
        channel: typeof sn.channelTitle === 'string' ? sn.channelTitle : '',
        title: sn.title,
        description: typeof sn.description === 'string' ? sn.description.slice(0, 500) : '',
        published: sn.publishedAt,
      };
      const d = parseDuration(typeof cd.duration === 'string' ? cd.duration : undefined);
      if (d !== undefined) video.durationSec = d;
      const views = Number(st.viewCount);
      if (Number.isInteger(views) && views >= 0) video.views = views;
      const lang = typeof sn.defaultAudioLanguage === 'string' ? sn.defaultAudioLanguage : typeof sn.defaultLanguage === 'string' ? sn.defaultLanguage : undefined;
      if (lang) video.lang = lang;
      out.push(video);
    }
  }
  return out;
}
