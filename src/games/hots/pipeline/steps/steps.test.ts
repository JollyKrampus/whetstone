import { describe, expect, it } from 'vitest';
import { DATA_LAG_HOURS, lagState, majorBuilds, newestLive } from './builds.ts';
import { MAX_CHAIN, diffChain, firstRunBaseline, firstRunChain } from './heroesData.ts';
import { pagesFromLinks, proWindow } from './liquipedia.ts';
import { fallbackBuildDates, reusableRecords } from './news.ts';
import { heroTargets } from './youtube.ts';

const VERSIONS = ['2.55.16.97039', '2.55.17.97407_ptr', '2.55.17.97605', '2.55.17.98025', '2.57.0.98126_ptr', '2.57.0.98285', '2.57.0.98304', '2.57.0.98348'];

describe('build detection', () => {
  it('picks the newest live build and lists the major newest first', () => {
    expect(newestLive([...VERSIONS, '2.57.1.99000_ptr'])).toBe('2.57.0.98348');
    expect(majorBuilds(VERSIONS, '2.57.0.98400')).toEqual(['2.57.0.98400', '2.57.0.98348', '2.57.0.98304', '2.57.0.98285']);
  });

  it('flags data pending only after the lag window', () => {
    const prev = { build: '2.57.0.98400', buildSeenAt: '2026-10-05T00:00:00.000Z' };
    expect(lagState({ live: '2.57.0.98400', dataBuild: '2.57.0.98348', nowIso: '2026-10-06T00:00:00.000Z', prev })).toMatchObject({ dataPending: false, buildSeenAt: prev.buildSeenAt });
    expect(lagState({ live: '2.57.0.98400', dataBuild: '2.57.0.98348', nowIso: '2026-10-08T00:00:01.000Z', prev })).toMatchObject({ dataPending: true });
    expect(lagState({ live: '2.57.0.98400', dataBuild: '2.57.0.98400', nowIso: '2026-10-09T00:00:00.000Z', prev }).dataPending).toBe(false);
    // A new live build restarts the clock.
    expect(lagState({ live: '2.57.0.98500', dataBuild: '2.57.0.98400', nowIso: '2026-10-09T00:00:00.000Z', prev })).toMatchObject({ buildSeenAt: '2026-10-09T00:00:00.000Z', dataPending: false });
    expect(DATA_LAG_HOURS).toBe(48);
  });
});

describe('diff chains', () => {
  it('chains every live build between two data builds', () => {
    expect(diffChain(VERSIONS, '2.57.0.98285', '2.57.0.98348')).toEqual(['2.57.0.98285', '2.57.0.98304', '2.57.0.98348']);
    const many = Array.from({ length: 10 }, (_, i) => `2.58.0.${100 + i}`);
    expect(diffChain(many, '2.58.0.100', '2.58.0.109')).toEqual(['2.58.0.100', '2.58.0.109']);
    expect(MAX_CHAIN).toBeGreaterThan(2);
  });

  it('starts the first run at the last live build of the previous major', () => {
    expect(firstRunBaseline(VERSIONS, '2.57.0.98348')).toBe('2.55.17.98025');
    expect(firstRunChain(VERSIONS, '2.57.0.98348')).toEqual(['2.55.17.98025', '2.57.0.98285', '2.57.0.98304', '2.57.0.98348']);
    expect(firstRunChain(['2.57.0.98348'], '2.57.0.98348')).toEqual([]);
  });
});

describe('windows', () => {
  it('extends the pro window to last year while this year is thin', () => {
    expect(proWindow('2026-10-08', 600)).toMatchObject({ label: '2026 tournaments', from: '2026-01-01', years: [2026] });
    expect(proWindow('2027-01-10', 12)).toMatchObject({ label: '2026–2027 tournaments', from: '2026-01-01', to: '2027-12-31', years: [2026, 2027] });
  });

  it('reads Liquipedia page titles back from last-good links', () => {
    const links = { heroes: { CCho: [{ site: 'liquipedia', kind: 'esports', label: 'x', url: "https://liquipedia.net/heroes/Cho'gall" }], Abat: [] } };
    expect([...pagesFromLinks(links as never)]).toEqual([['CCho', "Cho'gall"]]);
  });
});

describe('news fallbacks', () => {
  const patches = [
    { id: 'a', version: '2.57', build: '2.57.0.98285', date: '2026-09-28', title: 'Live', url: 'https://news.blizzard.com/x', kind: 'patch', contentHash: '0123456789abcdef', general: [], heroes: {} },
    { id: 'b', version: '2.57', build: '2.57.0.98304', date: '2026-09-30', title: 'Undocumented', url: 'https://github.com/HeroesToolChest/heroes-data2/releases/tag/v2.57.0.98304', kind: 'hotfix', contentHash: '0123456789abcdef', general: [], heroes: {} },
  ] as const;

  it('reuses article records but rebuilds undocumented ones', () => {
    expect(reusableRecords(patches as never).map((p) => p.title)).toEqual(['Live']);
    expect(reusableRecords(patches as never, 'https://news.blizzard.com/other')).toEqual([]);
  });

  it('recovers build dates from last-good diffs and patches', () => {
    const diffs = [{ id: 'x', from: '2.57.0.98285', to: '2.57.0.98304', date: '2026-09-29', heroes: {} }];
    expect(fallbackBuildDates(patches as never, diffs)).toEqual([
      { build: '2.57.0.98304', date: '2026-09-29' },
      { build: '2.57.0.98285', date: '2026-09-28' },
    ]);
  });
});

describe('video targets', () => {
  it('points member names at their composite', () => {
    const t = heroTargets([
      { id: 'CCho', slug: 'cho', name: 'Cho', aliases: [], memberOf: 'chogall' },
      { id: 'chogall', slug: 'chogall', name: "Cho'gall", aliases: ['cho gall'] },
    ] as never);
    expect(t).toEqual([{ id: 'chogall', names: ['Cho', 'cho', "Cho'gall", 'chogall', 'cho gall'] }]);
  });
});
