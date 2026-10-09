import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { UsageSchema } from '../../schema.ts';
import type { MoveResult, PairSummary } from '../../worker/protocol.ts';
import { checkTeam } from './legality.ts';
import { metaSets } from './metasets.ts';
import type { PokemonSet } from './team.ts';
import {
  battleAbility,
  battleForme,
  damageTable,
  effectiveHits,
  ladderPosition,
  metaByBase,
  metaToCalcMon,
  metaToSet,
  previewFromSet,
  previewTheirs,
  sampleTeam,
  setDisplayName,
  setStats,
  setToCalcMon,
  speedLadder,
  summarizeThreats,
  theirCalcMon,
} from './teamview.ts';
import { fixtureDex } from './testdex.ts';

const dex = fixtureDex();
const usage = UsageSchema.parse(JSON.parse(readFileSync(path.resolve('fixtures/pokemon/usage/gen9championsvgc2026regmc-1760.json'), 'utf8')));
const SETS = metaSets(usage.pokemon, { species: dex.speciesById, move: dex.move });
const byBase = metaByBase(SETS);

const SALAMENCE: PokemonSet = { species: 'salamence', item: 'salamencite', ability: 'intimidate', nature: 'Timid', sp: [2, 0, 0, 32, 0, 32], moves: ['dracometeor', 'hurricane'] };

function result(koN: number, koChance: number, maxPct: number, move = 'x'): MoveResult {
  return { move, moveName: move.toUpperCase(), min: 1, max: 2, minPct: maxPct - 10, maxPct, defenderHp: 100, koN, koChance, koText: '', desc: '', spread: false };
}

describe('battle formes', () => {
  it('turns a set holding its stone into the Mega forme with the Mega ability', () => {
    expect(battleForme(dex, SALAMENCE)?.id).toBe('salamencemega');
    expect(battleAbility(dex, SALAMENCE)).toBe('aerilate');
    expect(setDisplayName(dex, SALAMENCE)).toBe('Mega Salamence');
    expect(setStats(dex, SALAMENCE)).toMatchObject({ hp: 95 + 2 + 75, spe: Math.floor(((120 + 32 + 20) * 110) / 100) });
    const plain = { ...SALAMENCE, item: 'lifeorb' };
    expect(battleForme(dex, plain)?.id).toBe('salamence');
    expect(battleAbility(dex, plain)).toBe('intimidate');
  });

  it('builds calc inputs from sets and common sets', () => {
    expect(setToCalcMon(dex, SALAMENCE)).toEqual({ species: 'salamencemega', item: 'salamencite', ability: 'aerilate', nature: 'Timid', sp: [2, 0, 0, 32, 0, 32] });
    const mega = SETS.find((m) => m.id === 'salamencemega')!;
    expect(mega.name).toBe('Mega Salamence');
    expect(metaToCalcMon(mega)).toMatchObject({ species: 'salamencemega', item: 'salamencite', ability: 'aerilate' });
  });

  it('registers a Mega common set under its base species with a base ability', () => {
    const set = metaToSet(SETS.find((m) => m.id === 'salamencemega')!, dex);
    expect(set).toMatchObject({ species: 'salamence', item: 'salamencite', ability: 'intimidate', moves: ['dracometeor', 'hurricane', 'tailwind', 'protect'] });
    expect(metaToSet(SETS.find((m) => m.id === 'rillaboom')!).ability).toBe('grassysurge');
  });
});

describe('team preview inputs', () => {
  it('reads your sets with speed, moves and Mega forme', () => {
    const mon = previewFromSet(dex, SALAMENCE, 'm0')!;
    expect(mon).toMatchObject({ key: 'm0', species: 'salamencemega', base: 'salamence', name: 'Mega Salamence', ability: 'aerilate', speed: 189 });
    expect(mon.moves.map((m) => m.id)).toEqual(['dracometeor', 'hurricane']);
    expect(previewFromSet(dex, { ...SALAMENCE, species: 'missingno' }, 'm1')).toBeNull();
  });

  it('assumes the most used common set for a species-only entry and sums forme usage', () => {
    const mon = previewTheirs(dex, { species: 'salamence', nature: 'Serious', sp: [0, 0, 0, 0, 0, 0], moves: [] }, 't0', byBase)!;
    expect(mon).toMatchObject({ species: 'salamencemega', base: 'salamence', assumed: true, usage: 0.28 });
    expect(mon.moves.map((m) => m.id)).toContain('dracometeor');
  });

  it('uses a known team sheet as is', () => {
    const mon = previewTheirs(dex, { species: 'rillaboom', item: 'miracleseed', ability: 'grassysurge', nature: 'Jolly', sp: [0, 0, 0, 0, 0, 32], moves: ['fakeout'] }, 't1', byBase)!;
    expect(mon.assumed).toBeUndefined();
    expect(mon.moves.map((m) => m.id)).toEqual(['fakeout']);
    expect(mon.usage).toBe(0.47);
  });

  it('falls back to types and uninvested speed without a common set', () => {
    const mon = previewTheirs(dex, { species: 'whimsicott', nature: 'Serious', sp: [0, 0, 0, 0, 0, 0], moves: [] }, 't2', byBase)!;
    expect(mon).toMatchObject({ species: 'whimsicott', assumed: true, speed: 116 + 20, moves: [] });
    expect(mon.usage).toBeUndefined();
    expect(theirCalcMon(dex, { species: 'whimsicott', nature: 'Serious', sp: [0, 0, 0, 0, 0, 0], moves: [] }, byBase)).toBeNull();
    expect(theirCalcMon(dex, { species: 'sneasler', nature: 'Serious', sp: [0, 0, 0, 0, 0, 0], moves: [] }, byBase)?.moves).toEqual(['closecombat', 'direclaw', 'fakeout', 'uturn']);
  });
});

describe('calc results', () => {
  it('counts a KO under 50% likely one hit later', () => {
    expect(effectiveHits(result(1, 1, 120))).toBe(1);
    expect(effectiveHits(result(1, 0.6, 105))).toBe(1);
    expect(effectiveHits(result(1, 0.3, 102))).toBe(2);
    expect(effectiveHits(result(4, 0.2, 30))).toBe(0);
    expect(effectiveHits(result(0, 0, 10))).toBe(0);
    expect(effectiveHits(null)).toBe(0);
  });

  it('maps matrix pairs into the preview damage table', () => {
    const t = damageTable([{ attacker: 'm0', defender: 't0', best: result(1, 1, 110, 'eq') }], [{ attacker: 't0', defender: 'm0', best: null }]);
    expect(t.mine['m0']!['t0']).toMatchObject({ move: 'eq', koN: 1, maxPct: 110 });
    expect(t.theirs['t0']!['m0']).toBeNull();
  });

  it('summarizes threats: pressure, answers, unanswered and ordering', () => {
    const sets = SETS.filter((m) => ['rillaboom', 'sneasler', 'kingambit'].includes(m.id));
    const members = [
      { key: 's0', speed: 100 },
      { key: 's1', speed: 200 },
    ];
    const into: PairSummary[] = [
      { attacker: 'sneasler', defender: 's0', best: result(1, 1, 130, 'closecombat') },
      { attacker: 'sneasler', defender: 's1', best: result(2, 1, 70, 'closecombat') },
      { attacker: 'kingambit', defender: 's0', best: result(2, 1, 60) },
      { attacker: 'kingambit', defender: 's1', best: result(2, 0.9, 55) },
      { attacker: 'rillaboom', defender: 's0', best: null, error: 'unknown' },
      { attacker: 'rillaboom', defender: 's1', best: null, error: 'unknown' },
    ];
    const back: PairSummary[] = [
      { attacker: 's1', defender: 'sneasler', best: result(1, 1, 140, 'psychic') },
      { attacker: 's0', defender: 'kingambit', best: result(3, 1, 40) },
    ];
    const s = summarizeThreats(sets, members, into, back);
    expect(s.skipped).toEqual(['rillaboom']);
    expect(s.rows.map((r) => r.id)).toEqual(['sneasler', 'kingambit']);
    const sneasler = s.rows[0]!;
    expect(sneasler).toMatchObject({ ohko: 1, twoHko: 1, unanswered: false, outspeeds: 1 });
    expect(sneasler.pressure).toBeCloseTo(1.4, 9);
    expect(sneasler.worst?.member).toBe('s0');
    expect(sneasler.answers.map((a) => a.member)).toEqual(['s1']);
    expect(s.rows[1]).toMatchObject({ ohko: 0, twoHko: 2, unanswered: true, answers: [] });
  });
});

describe('speed ladder', () => {
  const members = [
    { key: 's0', name: 'Mine A', speed: 120 },
    { key: 's1', name: 'Mine B', speed: 60 },
  ];
  const sets = [
    { id: 'x', name: 'X', speed: 150 },
    { id: 'y', name: 'Y', speed: 120 },
    { id: 'z', name: 'Z', speed: 80 },
  ];

  it('merges your Pokémon into the ladder, yours first on ties', () => {
    const ladder = speedLadder(members, sets);
    expect(ladder.map((r) => r.key)).toEqual(['meta-x', 's0', 'meta-y', 'meta-z', 's1']);
    expect(ladderPosition(ladder, 's0')).toEqual({ before: 1, ties: 1, total: 3 });
  });

  it('doubles your side under Tailwind and reverses under Trick Room', () => {
    expect(ladderPosition(speedLadder(members, sets, { tailwind: true }), 's0')).toEqual({ before: 3, ties: 0, total: 3 });
    const tr = speedLadder(members, sets, { trickRoom: true });
    expect(tr[0]!.key).toBe('s1');
    expect(ladderPosition(tr, 's1', true)).toEqual({ before: 3, ties: 0, total: 3 });
  });
});

describe('sampleTeam', () => {
  it('takes the most used sets without repeating a species, an item or a Mega', () => {
    const team = sampleTeam(SETS, dex);
    expect(team).toHaveLength(6);
    expect(new Set(team.map((s) => s.species)).size).toBe(6);
    const items = team.map((s) => s.item).filter(Boolean);
    expect(new Set(items).size).toBe(items.length);
    const report = checkTeam(team, dex);
    expect(report.issues.filter((x) => x.code === 'item-clause' || x.code === 'species-clause' || x.code === 'one-mega')).toEqual([]);
    expect(team.filter((s) => dex.megaFor(s.species, s.item)).length).toBeLessThanOrEqual(1);
  });
});
