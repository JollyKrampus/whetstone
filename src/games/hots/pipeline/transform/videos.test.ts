import { describe, expect, it } from 'vitest';
import { VideosSchema, type CreatorsFile } from '../../schema.ts';
import type { RawVideo } from '../sources/youtube.ts';
import { buildVideos, createMatcher, normalizeTitle, videoKind } from './videos.ts';

const heroes = [
  { id: 'Ana1', names: ['Ana', 'ana amari'] },
  { id: 'Wiza', names: ['Li-Ming', 'liming', 'li ming', 'ming'] },
  { id: 'chogall', names: ['Cho', 'Gall', "Cho'gall"] },
  { id: 'Thra', names: ['Thrall'] },
  { id: 'Lucio', names: ['Lúcio'] },
];
const maps = [{ id: 'sky-temple', names: ['Sky Temple'] }];
const creators: CreatorsFile = {
  reviewed: '2026-10-08',
  creators: [
    { id: 'c1', name: 'Creator One', youtube: { channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa' }, lang: 'en', kinds: ['guide'], verified: '2026-10-08', excludeTitles: ['star wars'] },
    { id: 'c2', name: 'Creator Two', youtube: { channelId: 'UCbbbbbbbbbbbbbbbbbbbbbb' }, lang: 'und', kinds: ['gameplay'], verified: '2026-10-08' },
  ],
};
const video = (over: Partial<RawVideo>): RawVideo => ({
  id: 'abcdefghijk',
  channelId: 'UCaaaaaaaaaaaaaaaaaaaaaa',
  channel: 'Creator One',
  title: 'x',
  description: '',
  published: '2026-10-07T10:00:00Z',
  durationSec: 900,
  views: 1234,
  ...over,
});

describe('normalizeTitle and matching', () => {
  it('strips possessives, accents and punctuation', () => {
    expect(normalizeTitle("Thrall's Lúcio-Guide: Li-Ming!")).toBe('thrall lucio guide li ming');
  });

  it('matches whole words, longest alias first', () => {
    const m = createMatcher(heroes);
    expect(m.match('Banana build for Ming')).toEqual(['Wiza']);
    expect(m.match('Ana and Li Ming duo')).toEqual(['Ana1', 'Wiza']);
    expect(m.match("Cho'gall is back")).toEqual(['chogall']);
    expect(m.match("Thrall's new build")).toEqual(['Thra']);
    expect(m.match('Lucio Sky Temple')).toEqual(['Lucio']);
  });

  it('drops aliases two targets share', () => {
    expect(createMatcher([{ id: 'A', names: ['dup'] }, { id: 'B', names: ['dup', 'bee'] }]).match('dup bee')).toEqual(['B']);
  });

  it('classifies kinds', () => {
    expect(videoKind('Xal’atath Guide - Talents')).toBe('guide');
    expect(videoKind('Copium Cup Grand Final')).toBe('tournament');
    expect(videoKind('Patch 2.57 nerfs')).toBe('patch');
    expect(videoKind('Ranked games with friends')).toBe('gameplay');
  });
});

describe('buildVideos', () => {
  const out = buildVideos({
    raw: [
      video({ id: 'aaaaaaaaaaa', title: 'Li-Ming guide on Sky Temple', published: '2026-10-06T10:00:00Z' }),
      video({ id: 'bbbbbbbbbbb', title: 'Short clip', durationSec: 45 }),
      video({ id: 'ccccccccccc', title: 'Star Wars episode 4' }),
      video({ id: 'ddddddddddd', title: 'Zero to hero', description: 'Playing Thrall today', channelId: 'UCbbbbbbbbbbbbbbbbbbbbbb', channel: '' }),
      video({ id: 'eeeeeeeeeee', title: 'Unknown channel', channelId: 'UCcccccccccccccccccccccc' }),
      video({ id: 'aaaaaaaaaaa', title: 'Duplicate' }),
    ],
    creators,
    heroes,
    maps,
    fetchedAt: '2026-10-08T10:00:00.000Z',
  });

  it('drops Shorts, excluded titles, unknown channels and duplicates; sorts newest first', () => {
    expect(out.videos.map((v) => v.id)).toEqual(['ddddddddddd', 'aaaaaaaaaaa']);
    expect(VideosSchema.safeParse(out).success).toBe(true);
  });

  it('matches heroes in the title, else the description, and maps in the title', () => {
    expect(out.videos[1]).toMatchObject({ heroes: ['Wiza'], maps: ['sky-temple'], kind: 'guide', lang: 'en', views: 1234 });
    expect(out.videos[0]).toMatchObject({ heroes: ['Thra'], channel: 'Creator Two' });
    expect(out.videos[0]?.lang).toBeUndefined();
  });
});
