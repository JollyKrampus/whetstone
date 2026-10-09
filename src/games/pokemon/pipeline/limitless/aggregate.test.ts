import { describe, expect, it } from 'vitest';
import { wilsonLower } from '../../../../core/stats.ts';
import { TournamentsSchema, type Item, type Species } from '../../schema.ts';
import { dexIndex } from '../ids.ts';
import { aggregate, anonymise, MAX_TOP_TEAMS, TOP_CUT, type KnownIds, type TournamentTeams } from './aggregate.ts';

const stub = { base: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 }, abilities: ['x'], weightkg: 1, legal: ['M-C'] };
const species: Species[] = [
  { ...stub, id: 'garchomp', name: 'Garchomp', num: 445, types: ['Dragon', 'Ground'] },
  { ...stub, id: 'garchompmegaz', name: 'Garchomp-Mega-Z', num: 445, types: ['Dragon'], megaOf: 'garchomp', requiredItem: 'garchompitez' },
  { ...stub, id: 'incineroar', name: 'Incineroar', num: 727, types: ['Fire', 'Dark'] },
  { ...stub, id: 'rillaboom', name: 'Rillaboom', num: 812, types: ['Grass'] },
  { ...stub, id: 'sneasler', name: 'Sneasler', num: 903, types: ['Fighting', 'Poison'] },
];
const items: Item[] = [
  { id: 'garchompitez', name: 'Garchompite Z', legal: ['M-C'], mega: { base: 'garchomp', forme: 'garchompmegaz' } },
  { id: 'sitrusberry', name: 'Sitrus Berry', legal: ['M-C'] },
  { id: 'miracleseed', name: 'Miracle Seed', legal: ['M-C'] },
  { id: 'focussash', name: 'Focus Sash', legal: ['M-C'] },
];
const known: KnownIds = {
  dex: dexIndex(species, items),
  moves: new Set(['protect', 'fakeout', 'dracometeor', 'earthpower', 'grassyglide', 'closecombat']),
  items: new Set(items.map((i) => i.id)),
  abilities: new Set(['roughskin', 'intimidate', 'grassysurge', 'unburden']),
};

/** Standings rows shaped like the Limitless API, with identifying fields that must not survive. */
const standings = [
  {
    name: 'Secret Player One',
    player: 'secret_handle_1',
    country: 'ZZ',
    placing: 1,
    record: { wins: 6, losses: 1, ties: 0 },
    drop: null,
    deck: { id: 'deck-1' },
    decklist: [
      { id: 'garchomp', name: 'Garchomp', item: 'Garchompite Z', ability: 'Rough Skin', attacks: ['Draco Meteor', 'Earth Power', 'Protect', 'Unknown Move'], nature: 'Modest', tera: null },
      { id: 'incineroar', name: 'Incineroar', item: 'Sitrus Berry', ability: 'Intimidate', attacks: ['Fake Out', 'Protect'], nature: 'careful' },
      { id: 'missingno', name: 'MissingNo.', item: 'Leftovers' },
      { id: 'incineroar', name: 'Incineroar' },
    ],
  },
  {
    name: 'Secret Player Two',
    player: 'secret_handle_2',
    country: 'YY',
    placing: 9,
    record: { wins: 4, losses: 3, ties: 1 },
    decklist: [
      { id: 'rillaboom', name: 'Rillaboom', item: 'Miracle Seed', ability: 'Grassy Surge', attacks: ['Grassy Glide', 'Fake Out'], nature: 'Adamant' },
      { name: 'Incineroar', item: 'Focus Sash', ability: 'Intimidate', attacks: ['Fake Out'], nature: 'Adamant' },
    ],
  },
  { name: 'No List', player: 'secret_handle_3', country: 'XX', placing: 12, record: { wins: 1, losses: 6, ties: 0 }, decklist: null },
  { name: 'No Record', player: 'secret_handle_4', placing: null, record: null, decklist: [{ id: 'sneasler', name: 'Sneasler' }] },
];

describe('anonymise (ingest boundary)', () => {
  const { teams, unknownSpecies } = anonymise(standings, known);

  it('keeps placing, record and sets, and nothing that identifies a player', () => {
    const text = JSON.stringify(teams);
    for (const secret of ['Secret Player', 'secret_handle', '"ZZ"', '"YY"', 'deck-1', 'country', 'name', 'player']) expect(text).not.toContain(secret);
    expect(teams).toHaveLength(2);
    expect(teams[0]).toEqual({
      placing: 1,
      record: { wins: 6, losses: 1, ties: 0 },
      members: [
        { species: 'garchomp', item: 'garchompitez', ability: 'roughskin', moves: ['dracometeor', 'earthpower', 'protect'], nature: 'Modest' },
        { species: 'incineroar', item: 'sitrusberry', ability: 'intimidate', moves: ['fakeout', 'protect'], nature: 'Careful' },
      ],
    });
    expect(unknownSpecies).toEqual(['missingno']);
  });

  it('resolves species by name when the id is missing', () => {
    expect(teams[1]?.members.map((m) => m.species)).toEqual(['rillaboom', 'incineroar']);
  });

  it('rejects rows that are not standings', () => {
    expect(() => anonymise({ not: 'an array' }, known)).toThrow();
  });
});

describe('aggregate', () => {
  const { teams } = anonymise(standings, known);
  const events: TournamentTeams[] = [
    { ref: { id: 't-old', name: 'Old Cup', date: '2026-10-01', players: 32, url: 'https://play.limitlesstcg.com/tournament/t-old/standings' }, teams },
    { ref: { id: 't-new', name: 'New Cup', date: '2026-10-05', players: 64, url: 'https://play.limitlesstcg.com/tournament/t-new/standings' }, teams: teams.slice(0, 1) },
  ];
  const t = aggregate(events, {
    regulation: 'M-C',
    format: 'M-C',
    window: { label: 'Last 30 days', from: '2026-09-09', to: '2026-10-08' },
    dex: known.dex,
  });

  it('is a valid tournaments.json without player data', () => {
    expect(TournamentsSchema.safeParse(t).success).toBe(true);
    expect(JSON.stringify(t)).not.toMatch(/secret|Secret/);
    expect(t.totals).toEqual({ tournaments: 2, players: 96, teams: 3 });
    expect(t.tournaments.map((x) => x.id)).toEqual(['t-new', 't-old']);
  });

  it('counts a Pokémon holding its Mega Stone as the Mega, with match-weighted win rates', () => {
    const chomp = t.species.find((s) => s.id === 'garchompmegaz');
    expect(chomp).toMatchObject({ teams: 2, share: 0.6667, wins: 12, losses: 2, ties: 0, topCut: 2 });
    expect(chomp?.wr).toBeCloseTo(12 / 14, 4);
    expect(chomp?.wrLower).toBeCloseTo(wilsonLower(12, 14), 4);
    expect(t.species.find((s) => s.id === 'garchomp')).toBeUndefined();
    const inc = t.species.find((s) => s.id === 'incineroar');
    expect(inc).toMatchObject({ teams: 3, share: 1, wins: 16, losses: 5, ties: 1, topCut: 2 });
    expect(t.species[0]?.id).toBe('incineroar');
  });

  it('aggregates sets per species from the open team lists', () => {
    const inc = t.species.find((s) => s.id === 'incineroar');
    expect(inc?.items).toEqual([
      { id: 'sitrusberry', share: 0.6667 },
      { id: 'focussash', share: 0.3333 },
    ]);
    expect(inc?.moves).toEqual([
      { id: 'fakeout', share: 1 },
      { id: 'protect', share: 0.6667 },
    ]);
    expect(inc?.natures).toEqual([
      { nature: 'Careful', share: 0.6667 },
      { nature: 'Adamant', share: 0.3333 },
    ]);
    expect(t.species.find((s) => s.id === 'garchompmegaz')?.items).toEqual([{ id: 'garchompitez', share: 1 }]);
  });

  it('lists top-cut teams newest event first, by placing', () => {
    expect(t.teams.map((x) => [x.tournamentId, x.placing])).toEqual([
      ['t-new', 1],
      ['t-old', 1],
    ]);
    expect(t.teams.every((x) => x.placing <= TOP_CUT)).toBe(true);
    expect(MAX_TOP_TEAMS).toBeGreaterThanOrEqual(32);
  });

  it('only calls frequent pairs archetypes', () => {
    // 3 teams: the 5-team floor keeps every pair out.
    expect(t.archetypes).toEqual([]);
    const many = aggregate(
      [{ ref: events[0]!.ref, teams: Array.from({ length: 6 }, () => teams[0]!) }],
      { regulation: 'M-C', format: 'M-C', window: { label: 'w', from: '2026-09-09', to: '2026-10-08' }, dex: known.dex },
    );
    expect(many.archetypes).toEqual([
      { id: 'garchompmegaz-incineroar', label: 'Garchomp-Mega-Z + Incineroar', core: ['garchompmegaz', 'incineroar'], teams: 6, share: 1, wins: 36, losses: 6, ties: 0, wr: 0.8571 },
    ]);
  });

  it('is independent of event order', () => {
    const swapped = aggregate([...events].reverse(), {
      regulation: 'M-C',
      format: 'M-C',
      window: { label: 'Last 30 days', from: '2026-09-09', to: '2026-10-08' },
      dex: known.dex,
    });
    expect(swapped).toEqual(t);
  });
});
