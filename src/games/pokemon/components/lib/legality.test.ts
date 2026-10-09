import { describe, expect, it } from 'vitest';
import { checkTeam, issuesForSlot } from './legality.ts';
import type { PokemonSet, Team } from './team.ts';
import { fixtureDex } from './testdex.ts';

const dex = fixtureDex();

const set = (species: string, extra: Partial<PokemonSet> = {}): PokemonSet => ({
  species,
  nature: 'Serious',
  sp: [0, 0, 0, 0, 0, 0],
  moves: ['protect'],
  ability: dex.speciesById(species)?.abilities[0] ?? '',
  ...extra,
});

const LEGAL: Team = [
  set('rillaboom', { item: 'miracleseed', ability: 'grassysurge', moves: ['fakeout', 'grassyglide', 'woodhammer', 'protect'], sp: [32, 32, 0, 0, 2, 0] }),
  set('incineroar', { item: 'sitrusberry', ability: 'intimidate', moves: ['fakeout', 'flareblitz', 'knockoff', 'partingshot'] }),
  set('sneasler', { item: 'focussash', ability: 'unburden', moves: ['closecombat', 'direclaw', 'fakeout', 'protect'] }),
  set('salamence', { item: 'salamencite', ability: 'intimidate', moves: ['dracometeor', 'hurricane', 'protect', 'tailwind'] }),
  set('kingambit', { item: 'lifeorb', ability: 'defiant', moves: ['ironhead', 'kowtowcleave', 'protect', 'suckerpunch'] }),
  set('gholdengo', { item: 'choicescarf', ability: 'goodasgold', moves: ['makeitrain', 'shadowball', 'thunderbolt'] }),
];

describe('checkTeam', () => {
  it('accepts a legal six', () => {
    const r = checkTeam(LEGAL, dex, 'M-C');
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.megas).toEqual(['salamencemega']);
  });

  it('flags species outside the regulation roster', () => {
    // Rillaboom and Mega Salamence arrived in M-C.
    const r = checkTeam(LEGAL, dex, 'M-B');
    expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['roster', 'item-roster', 'mega-roster']));
    expect(issuesForSlot(r, 0).some((i) => i.code === 'roster')).toBe(true);
  });

  it('enforces Species Clause by dex number and Item Clause', () => {
    const team = [...LEGAL.slice(0, 5), set('rillaboom', { item: 'lifeorb', ability: 'grassysurge', moves: ['protect'] })];
    const r = checkTeam(team, dex, 'M-C');
    const species = r.issues.find((i) => i.code === 'species-clause');
    const item = r.issues.find((i) => i.code === 'item-clause');
    expect(species?.slots).toEqual([0, 5]);
    expect(item?.slots).toEqual([4, 5]);
    expect(r.ok).toBe(false);
  });

  it('checks abilities, learnsets, duplicate moves and Stat Points', () => {
    const team = [...LEGAL];
    team[0] = set('rillaboom', { ability: 'intimidate', moves: ['fakeout', 'fakeout', 'makeitrain'], sp: [32, 32, 3, 0, 0, 0] });
    const r = checkTeam(team, dex, 'M-C');
    const codes = issuesForSlot(r, 0).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['ability', 'moves', 'learnset', 'stat-points']));
  });

  it('lets Megas use their base species learnset', () => {
    const r = checkTeam(LEGAL, dex, 'M-C');
    expect(issuesForSlot(r, 3)).toEqual([]);
  });

  it('warns about a second Mega Stone and a stone on the wrong species', () => {
    const team = [...LEGAL];
    team[1] = set('incineroar', { item: 'garchompitez', ability: 'intimidate', moves: ['fakeout'] });
    team[2] = set('charizard', { item: 'charizarditey', ability: 'blaze', moves: ['heatwave'] });
    const r = checkTeam(team, dex, 'M-C');
    expect(r.issues.find((i) => i.code === 'stone')?.slots).toEqual([1]);
    const mega = r.issues.find((i) => i.code === 'one-mega');
    expect(mega?.level).toBe('warning');
    expect(r.megas).toEqual(['charizardmegay', 'salamencemega']);
  });

  it('needs at least four Pokémon and suggests six', () => {
    expect(checkTeam(LEGAL.slice(0, 3), dex, 'M-C').issues[0]).toMatchObject({ level: 'error', code: 'size' });
    const five = checkTeam(LEGAL.slice(0, 5), dex, 'M-C');
    expect(five.ok).toBe(true);
    expect(five.issues[0]).toMatchObject({ level: 'warning', code: 'size' });
  });

  it('rejects a Mega forme registered directly and unknown ids', () => {
    const team = [...LEGAL.slice(0, 4), set('salamencemega'), set('missingno')];
    const r = checkTeam(team, dex, 'M-C');
    expect(issuesForSlot(r, 4).some((i) => /Mega forme/.test(i.message))).toBe(true);
    expect(issuesForSlot(r, 5).some((i) => i.code === 'unknown')).toBe(true);
  });
});
