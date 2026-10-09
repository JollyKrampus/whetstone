import { describe, expect, it } from 'vitest';
import type { Http } from '../../../../core/game.ts';
import { fetchReleaseDates } from '../sources/heroesData.ts';
import { fetchImageTags } from '../sources/heroesImages.ts';
import { rawJson } from '../test-helpers.ts';
import { buildOfTag, parseJsdelivrVersions, parseReleasesApi, parseReleasesAtom, parseTagsApi } from './github.ts';

const ATOM = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Repository/1214769032/v2.57.0.98348</id>
    <updated>2026-10-05T21:54:00Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/HeroesToolChest/heroes-data2/releases/tag/v2.57.0.98348"/>
    <title>v2.57.0.98348</title>
  </entry>
  <entry>
    <updated>2026-07-04T19:14:50Z</updated>
    <link rel="alternate" type="text/html" href="https://github.com/HeroesToolChest/heroes-data2/releases/tag/2.55.17.97449_ptr"/>
    <title>2.55.17.97449_ptr</title>
  </entry>
</feed>`;

describe('release and tag listings', () => {
  it('reads builds from tags', () => {
    expect(['v2.57.0.98348', '2.55.17.97449_ptr', 'v2.55.16.97039_2', 'v20250516.1'].map(buildOfTag)).toEqual(['2.57.0.98348', '2.55.17.97449_ptr', '2.55.16.97039', null]);
  });

  it('parses the releases API and the Atom feed to the same dates', () => {
    expect(parseReleasesApi(rawJson('heroes-data2/releases.json'))).toContainEqual({ build: '2.57.0.98348', date: '2026-10-05' });
    expect(parseReleasesAtom(ATOM)).toEqual([
      { build: '2.57.0.98348', date: '2026-10-05' },
      { build: '2.55.17.97449_ptr', date: '2026-07-04' },
    ]);
    expect(() => parseReleasesAtom('<feed></feed>')).toThrow();
  });

  it('parses tag lists from GitHub and jsDelivr', () => {
    expect(parseTagsApi([{ name: 'v2.57.0.98285' }, { nope: 1 }])).toEqual(['v2.57.0.98285']);
    expect(parseJsdelivrVersions({ versions: [{ version: '2.57.0.98285' }, { version: '20250516.1' }] })).toEqual(['v2.57.0.98285', 'v20250516.1']);
    expect(() => parseJsdelivrVersions({ versions: [] })).toThrow();
  });
});

describe('fallbacks when the GitHub API is rate-limited', () => {
  const http = (answers: Record<string, unknown>): Http => {
    const pick = (url: string): unknown => {
      const key = Object.keys(answers).find((k) => url.includes(k));
      if (!key) throw new Error('API rate limit exceeded');
      return answers[key];
    };
    return {
      json: async <T>(url: string) => pick(url) as T,
      text: async (url: string) => String(pick(url)),
      bytes: async () => new Uint8Array(),
      head: async () => ({}),
      request: async (url: string) => ({ status: 200, headers: {}, body: new TextEncoder().encode(String(pick(url))) }),
    };
  };

  it('dates releases from the Atom feed', async () => {
    expect(await fetchReleaseDates(http({ 'releases.atom': ATOM }))).toHaveLength(2);
  });

  it('lists image tags from jsDelivr', async () => {
    expect(await fetchImageTags(http({ 'data.jsdelivr.com': { versions: [{ version: '2.57.0.98285' }] } }))).toEqual(['v2.57.0.98285']);
  });

  it('reports the original error when every source fails', async () => {
    await expect(fetchImageTags(http({}))).rejects.toThrow(/rate limit/);
  });
});
