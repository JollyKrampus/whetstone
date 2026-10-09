import { describe, expect, it } from 'vitest';
import { ProSchema } from '../../schema.ts';
import { FIXTURE_NOW, fixtureRelease, rawJson, testCurated } from '../test-helpers.ts';
import { buildHeroes } from './heroes.ts';
import { aggregatePro, buildEntityIndex, findTemplates, inheritFromParents, normalizeRegion, parseMaps, parseTournament, type ParsedTournament } from './pro.ts';

interface Rev {
  query: { pages: { title: string; revisions: { slots: { main: { content: string } } }[] }[] };
}
const pages = rawJson<Rev>('liquipedia/revisions-2026-1.json').query.pages.map((p) => ({ title: p.title, wikitext: p.revisions[0]?.slots.main.content ?? '' }));
const heroes = buildHeroes(fixtureRelease('2.57.0.98348'), { aliases: testCurated().aliases, now: FIXTURE_NOW }).heroes;

describe('wikitext templates', () => {
  it('splits parameters at depth 0 and keeps nested templates and links whole', () => {
    const [t] = findTemplates('x {{Map|map=Sky Temple|winner=2|note={{abbr|a|b}} [[A|B]]|t1h1=hogger}} y', 'Map');
    expect(t?.params).toMatchObject({ map: 'Sky Temple', winner: '2', note: '{{abbr|a|b}} [[A|B]]', t1h1: 'hogger' });
  });

  it('does not match longer template names', () => {
    expect(findTemplates('{{MapList|a=1}}{{Map|b=2}}', 'Map')).toHaveLength(1);
  });

  it('parses picks, bans and the winner, skipping "default" placeholders and comments', () => {
    const maps = parseMaps('{{Map|winner=1|t1h1=Hogger |t1h2=default<!-- x -->|t2h1=tlv|t1b1=sgt|t2b1=default}}{{Map|winner=}}');
    expect(maps).toEqual([{ winner: 1, picks: [['hogger'], ['tlv']], bans: [['sgt'], []] }]);
  });
});

describe('tournaments', () => {
  const parsed = pages.map(parseTournament).filter((t) => t !== null);
  const all = inheritFromParents(parsed);

  it('reads the infobox (dates, tier, normalised region) and drafted maps', () => {
    const copium = all.find((t) => t.id === 'Copium_Cup') as ParsedTournament;
    expect(copium).toMatchObject({ name: 'Copium Cup', startDate: '2026-10-03', endDate: '2026-10-04', tier: 2, region: 'Europe', url: 'https://liquipedia.net/heroes/Copium_Cup' });
    expect(copium.maps).toHaveLength(8);
  });

  it('gives stage subpages without an infobox their parent tournament data', () => {
    const stage = all.find((t) => t.id === 'Nations_Cup_2026/League_Stage') as ParsedTournament;
    expect(stage).toMatchObject({ name: 'Nations Cup 2026 (League Stage)', startDate: '2026-01-31', tier: 1, region: 'Europe' });
    expect(stage.maps.length).toBeGreaterThan(0);
  });

  it('normalises region spellings', () => {
    expect(['eu', 'EU', 'Europe', 'usca', 'North America', 'brazil', 'Mars Base'].map(normalizeRegion)).toEqual(['Europe', 'Europe', 'Europe', 'North America', 'North America', 'Brazil', 'Mars Base']);
    expect(normalizeRegion('')).toBeUndefined();
  });

  it('skips cancelled tournaments', () => {
    expect(parseTournament({ title: 'X', wikitext: '{{Cancelled Tournament|confirmed=true}}{{Infobox league|sdate=2026-10-10}}' })).toBeNull();
  });

  it('aggregates picks, bans, wins and presence per draftable entity', () => {
    const { pro, issues } = aggregatePro(all, { entityIndex: buildEntityIndex(heroes), from: '2026-01-01', to: '2026-12-31', label: '2026 tournaments' });
    expect(ProSchema.safeParse(pro).success).toBe(true);
    expect(pro.totals).toEqual({ tournaments: 3, maps: all.reduce((s, t) => s + t.maps.length, 0) });
    expect(pro.attribution.license).toBe('CC BY-SA 3.0');
    // Only five heroes are in the trimmed roster: everyone else is reported once.
    expect(issues).toHaveLength(1);
    const x = pro.heroes.find((h) => h.hero === 'HXAL');
    expect(x?.picks).toBeGreaterThan(0);
    for (const h of pro.heroes) expect(h.presence).toBeCloseTo(Math.min(1, (h.picks + h.bans) / pro.totals.maps), 3);
    expect(pro.heroes.map((h) => h.presence)).toEqual([...pro.heroes.map((h) => h.presence)].sort((a, b) => b - a));
  });

  it('counts Cho and Gall once as chogall and never double-counts a pick as a ban', () => {
    const t: ParsedTournament = {
      id: 'T',
      name: 'T',
      url: 'https://liquipedia.net/heroes/T',
      startDate: '2026-05-01',
      maps: [{ winner: 2, picks: [['cho', 'gall', 'abathur'], ['xalatath']], bans: [['xalatath'], ['alexstrasza']] }],
    };
    const { pro } = aggregatePro([t], { entityIndex: buildEntityIndex(heroes), from: '2026-01-01', to: '2026-12-31', label: 'x' });
    const by = new Map(pro.heroes.map((h) => [h.hero, h]));
    expect(by.get('chogall')).toMatchObject({ picks: 1, bans: 0, wins: 0 });
    expect(by.get('HXAL')).toMatchObject({ picks: 1, bans: 0, wins: 1 });
    expect(by.get('Alex')).toMatchObject({ picks: 0, bans: 1 });
    expect(by.has('CCho')).toBe(false);
  });
});
