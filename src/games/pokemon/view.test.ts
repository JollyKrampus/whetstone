import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Edge } from '../../core/game.ts';
import { assignTiers, POKEMON_TIERS } from '../../core/tiers.ts';
import { H2HSchema, SpeciesFileSchema, TournamentsSchema, UsageSchema } from './schema.ts';
import { metaSets } from './components/lib/metasets.ts';
import {
  checkRows,
  checkScore,
  compactEdges,
  displayName,
  edgeLists,
  ladderTierRows,
  monHref,
  outboundLinks,
  speedPosition,
  teammateRows,
  teammateScore,
  toTierInputs,
  tournamentTierRows,
  usageTrend,
} from './view.ts';

const read = (file: string): unknown => JSON.parse(readFileSync(path.resolve('fixtures/pokemon', file), 'utf8'));
const usage = UsageSchema.parse(read('usage/gen9championsvgc2026regmc-1760.json'));
const species = SpeciesFileSchema.parse(read('dex/species.json'));
const h2h = H2HSchema.parse(read('h2h.json'));
const tournaments = TournamentsSchema.parse(read('tournaments.json'));
const byId = new Map(species.map((s) => [s.id, s]));
const lookup = (id: string) => byId.get(id);

describe('URLs and names', () => {
  it('sends Megas to their base page with a forme anchor', () => {
    expect(monHref(byId.get('garchomp')!)).toBe('/whetstone/pokemon/mon/garchomp/');
    expect(monHref(byId.get('salamencemega')!)).toBe('/whetstone/pokemon/mon/salamence/#salamencemega');
    expect(displayName(byId.get('charizardmegay'))).toBe('Mega Charizard Y');
    expect(displayName(byId.get('garchompmegaz'))).toBe('Mega Garchomp Z');
    expect(displayName(byId.get('golisopodmega'))).toBe('Mega Golisopod');
    expect(displayName(undefined, 'x')).toBe('x');
  });

  it('builds outbound links without fetching anything', () => {
    const links = outboundLinks(byId.get('indeedeef')!, 'gen9championsvgc2026regmc');
    expect(links.map((l) => l.href)).toEqual([
      'https://www.smogon.com/dex/champions/pokemon/indeedee-f/',
      'https://www.pikalytics.com/pokedex/gen9championsvgc2026regmc/Indeedee-F',
      'https://bulbapedia.bulbagarden.net/wiki/Indeedee_(Pok%C3%A9mon)',
      'https://victoryroad.pro/?s=Indeedee',
    ]);
  });
});

describe('scores', () => {
  it('checkScore is a cautious 100 × (p − 2 sd)', () => {
    expect(checkScore(0.45, 0.08)).toBe(29);
    expect(checkScore(0.1, 0.2)).toBe(1);
    expect(checkScore(1, 0)).toBe(100);
  });

  it('teammateScore maps lift on a log scale around 50', () => {
    expect(teammateScore(0.32, 0.32)).toBe(50);
    expect(teammateScore(0.4, 0.32)).toBe(61);
    expect(teammateScore(0.64, 0.32)).toBe(80);
    expect(teammateScore(0.16, 0.32)).toBe(20);
    expect(teammateScore(0.3, 0)).toBe(50);
  });
});

describe('matchup rows', () => {
  const rilla = usage.pokemon.find((p) => p.id === 'rillaboom')!;
  const ctx = { lookup, label: 'Smogon ≥1760, 2026-09' };

  it('turns Smogon checks into greyed rows with n', () => {
    const rows = checkRows(rilla, ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 'sneasler', score: 29, n: 34, source: 'usage', lowSample: false });
    expect(rows[0]!.reasons![0]!.text).toContain('KOs or forces out Rillaboom in 45% of encounters');
  });

  it('scores teammates by lift over their own usage', () => {
    const rows = teammateRows(rilla, usage, ctx);
    const inc = rows.find((r) => r.id === 'incineroar')!;
    expect(inc.score).toBe(teammateScore(0.4, 0.32));
    expect(inc.delta).toBeCloseTo(8, 5);
    expect(inc.href).toBe('/whetstone/pokemon/mon/incineroar/');
    const mega = rows.find((r) => r.id === 'salamencemega')!;
    expect(mega.href).toBe('/whetstone/pokemon/mon/salamence/#salamencemega');
  });

  it('splits replay edges into countered-by, strong-against and good-with', () => {
    const lists = edgeLists(['sneasler'], h2h, lookup);
    expect(lists.counteredBy.map((r) => r.id)).toEqual(['incineroar']);
    expect(lists.strongAgainst.map((r) => r.id)).toEqual(['rillaboom']);
    expect(lists.counteredBy[0]).toMatchObject({ score: 58, n: 140, delta: 3.2, sourceLabel: 'Replays' });
    expect(edgeLists(['rillaboom'], h2h, lookup).goodWith.map((r) => r.id)).toEqual(['incineroar']);
    expect(edgeLists(['salamence', 'salamencemega'], h2h, lookup).goodWith.map((r) => r.id)).toEqual(['kingambit']);
    expect(edgeLists(['x'], null, lookup)).toEqual({ counteredBy: [], strongAgainst: [], goodWith: [] });
  });
});

describe('usage trend', () => {
  it('compares with an older snapshot', () => {
    const older = { pokemon: [{ ...usage.pokemon[0]!, usage: 0.4 }] };
    expect(usageTrend('rillaboom', usage, older, 'M-B')).toMatchObject({ direction: 'up', label: '+7.0 pp vs M-B' });
    expect(usageTrend('sneasler', usage, older, 'M-B')).toMatchObject({ direction: 'new' });
    expect(usageTrend('rillaboom', usage, null, 'M-B')).toBeNull();
  });
});

describe('tiers', () => {
  it('bands ladder usage with the Wilson win-rate rule', () => {
    const rows = ladderTierRows(usage, tournaments);
    const tiers = assignTiers(toTierInputs(rows), POKEMON_TIERS);
    expect(tiers[0]).toMatchObject({ id: 'rillaboom', tier: 'S' });
    // Kingambit's 81–100 record (ties count half) still has an interval reaching 50 %: no change.
    const king = tiers.find((t) => t.id === 'kingambit')!;
    expect(king.metric).toBe(25);
    expect(rows.find((r) => r.id === 'kingambit')!.wrNote).toMatch(/^WR 44\.5% \(95% 37%–52%, 182 games\)$/);
  });

  it('adds half the credible win-rate edge when the interval clears 50 %', () => {
    const strong = { ...tournaments, species: [{ ...tournaments.species[0]!, wins: 650, losses: 350, ties: 0 }] };
    const tiers = assignTiers(toTierInputs(ladderTierRows(usage, strong)), POKEMON_TIERS);
    expect(tiers.find((t) => t.id === 'rillaboom')!.metric).toBeCloseTo(53, 0);
  });

  it('uses team counts as n for tournament tiers', () => {
    const tiers = assignTiers(toTierInputs(tournamentTierRows(tournaments)), POKEMON_TIERS);
    expect(tiers.find((t) => t.id === 'rillaboom')).toMatchObject({ tier: 'S', n: 70 });
    expect(tiers.every((t) => !t.early)).toBe(true);
  });
});

describe('meta sets and speed position', () => {
  const sets = metaSets(usage.pokemon, { species: lookup, move: () => ({ category: 'Physical' }) }, 5);

  it('builds the common set for each top Pokémon', () => {
    expect(sets.map((s) => s.id)).toEqual(['rillaboom', 'sneasler', 'incineroar', 'salamencemega', 'kingambit']);
    expect(sets[0]).toMatchObject({ item: 'miracleseed', ability: 'grassysurge', nature: 'Adamant', sp: [32, 32, 0, 0, 2, 0], speed: 105 });
    expect(sets[3]).toMatchObject({ base: 'salamence', item: 'salamencite' });
  });

  it('places a speed among others', () => {
    const pos = speedPosition(105, sets.map((s) => ({ id: s.id, speed: s.speed })), 'rillaboom');
    expect(pos.total).toBe(4);
    expect(pos.faster + pos.slower + pos.ties).toBe(4);
  });
});

describe('compactEdges', () => {
  it('keeps edges with n ≥ 15, rounds Δ and sorts', () => {
    const e = (a: string, b: string, delta: number | undefined, n: number | undefined): Edge => ({
      a,
      b,
      score: 50,
      source: 'replays',
      reasons: [],
      ...(delta !== undefined ? { delta } : {}),
      ...(n !== undefined ? { n } : {}),
    });
    const out = compactEdges({ counters: [e('b', 'a', 1.234, 40), e('a', 'c', -2, 14), e('a', 'b', 3.456, 15), e('a', 'd', undefined, 99)], synergies: [e('a', 'b', 2, 200)] });
    expect(out).toEqual({ counters: [['a', 'b', 3.46, 15], ['b', 'a', 1.23, 40]], synergies: [['a', 'b', 2, 200]] });
    expect(compactEdges(null)).toBeNull();
  });
});
