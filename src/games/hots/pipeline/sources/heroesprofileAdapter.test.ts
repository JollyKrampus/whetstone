/**
 * The adapter's wire format is unconfirmed (TODO(owner-verify) in heroesprofileAdapter.ts), so
 * these tests only pin its tolerance: list or wrapped bodies, alternative field names, and a
 * loud failure when nothing is recognisable. Bodies here are synthetic.
 */
import { describe, expect, it } from 'vitest';
import { createHpClient, type HpTransport } from './heroesprofile.ts';
import { fetchWindow, parseBuildRows, parseHeroRows, parseMapRows, parseMatchupRows, rowsOf, windowParams } from './heroesprofileAdapter.ts';

describe('rowsOf', () => {
  it('accepts lists, wrapped lists and objects keyed by name', () => {
    expect(rowsOf([{ a: 1 }, 2])).toEqual([{ a: 1 }]);
    expect(rowsOf({ data: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(rowsOf({ Abathur: { wins: 1 } })).toEqual([{ name: 'Abathur', wins: 1 }]);
  });
});

describe('row parsers', () => {
  it('parses hero rows with games or wins + losses', () => {
    expect(parseHeroRows({ data: [{ name: 'Abathur', wins: 40, losses: 60, bans: 5 }, { hero: 'Cho', games_played: '100', wins: '52' }] })).toEqual([
      { hero: 'Abathur', games: 100, wins: 40, bans: 5 },
      { hero: 'Cho', games: 100, wins: 52 },
    ]);
  });

  it('parses flat or nested per-map rows', () => {
    expect(parseMapRows([{ hero: 'Abathur', map: 'Sky Temple', games: 10, wins: 4 }])).toEqual([{ hero: 'Abathur', map: 'Sky Temple', games: 10, wins: 4 }]);
    expect(parseMapRows({ Abathur: { maps: { 'Sky Temple': { games: 10, wins: 4 } } } })).toEqual([{ hero: 'Abathur', map: 'Sky Temple', games: 10, wins: 4 }]);
  });

  it('parses ally and enemy matchups for one hero', () => {
    expect(parseMatchupRows('Abathur', { ally: [{ name: 'Zeratul', games: 20, wins: 11 }], enemy: { Zeratul: { wins: 3, losses: 7 } } })).toEqual({
      allies: [{ hero: 'Abathur', other: 'Zeratul', games: 20, wins: 11 }],
      enemies: [{ hero: 'Abathur', other: 'Zeratul', games: 10, wins: 3 }],
    });
  });

  it('parses talent builds from a list or level columns', () => {
    expect(parseBuildRows([{ hero: 'Abathur', talents: ['A', 'B'], games: 9, wins: 5 }, { hero: 'Gall', level_one: 'X', level_four: 'Y', wins: 1, losses: 1 }])).toEqual([
      { hero: 'Abathur', talents: ['A', 'B'], games: 9, wins: 5 },
      { hero: 'Gall', talents: ['X', 'Y'], games: 2, wins: 1 },
    ]);
  });

  it('fails loudly, naming the adapter, when rows are not recognisable', () => {
    expect(() => parseHeroRows([{ foo: 1 }])).toThrow(/heroesprofileAdapter\.ts/);
    expect(() => parseMatchupRows('Abathur', { weird: [] })).toThrow(/TODO\(owner-verify\)/);
    expect(parseHeroRows([])).toEqual([]);
  });
});

describe('fetchWindow', () => {
  it('makes three window calls plus one matchup call per hero, within the budget', async () => {
    const seen: string[] = [];
    const transport: HpTransport = async (url) => {
      const u = new URL(url);
      seen.push(`${u.pathname.split('/v1/')[1]}${u.searchParams.has('group_by_map') ? '+maps' : ''}${u.searchParams.get('hero') ? `:${u.searchParams.get('hero')}` : ''}`);
      const path = u.pathname;
      let body: unknown = [];
      if (path.endsWith('heroes/stats')) body = u.searchParams.has('group_by_map') ? [{ hero: 'Abathur', map: 'Sky Temple', games: 5, wins: 2 }] : [{ hero: 'Abathur', games: 5, wins: 2 }];
      if (path.endsWith('matchups')) body = { ally: [], enemy: [{ name: 'Cho', games: 2, wins: 1 }] };
      return { status: 200, headers: {}, body: JSON.stringify(body) };
    };
    const client = createHpClient({ key: 'k', transport, budget: 4 });
    const r = await fetchWindow(client, { mode: 'sl', builds: ['2.57.0.98348'] }, ['Abathur', 'Cho']);
    expect(seen).toEqual(['heroes/stats', 'heroes/stats+maps', 'heroes/talents/builds/all', 'heroes/matchups:Abathur']);
    expect(r.skippedMatchups).toEqual(['Cho']);
    expect(r.data.enemies).toEqual([{ hero: 'Abathur', other: 'Cho', games: 2, wins: 1 }]);
    expect(windowParams({ mode: 'sl', builds: ['a', 'b'] })).toEqual({ game_type: 'Storm League', game_version: 'a,b' });
  });
});
