import { describe, expect, it } from 'vitest';
import type { Edge } from '../../../../core/game.ts';
import { bringWeights, recommend, type DamageTable, type PreviewMon, type PreviewMove } from './preview.ts';
import { fixtureDex } from './testdex.ts';

const dex = fixtureDex();

function mon(key: string, species: string, moves: string[], opts: { speed: number; ability?: string; usage?: number; base?: string }): PreviewMon {
  const s = dex.speciesById(species)!;
  const m: PreviewMon = {
    key,
    species,
    base: opts.base ?? species,
    name: s.name,
    types: s.types,
    speed: opts.speed,
    moves: moves.map((id) => dex.move(id) as PreviewMove),
  };
  if (opts.ability) m.ability = opts.ability;
  if (opts.usage !== undefined) m.usage = opts.usage;
  return m;
}

const MINE: PreviewMon[] = [
  mon('m0', 'rillaboom', ['fakeout', 'grassyglide', 'woodhammer', 'protect'], { speed: 105, ability: 'grassysurge' }),
  mon('m1', 'incineroar', ['fakeout', 'flareblitz', 'knockoff', 'partingshot'], { speed: 80, ability: 'intimidate' }),
  mon('m2', 'pelipper', ['hurricane', 'weatherball', 'tailwind', 'protect'], { speed: 128, ability: 'drizzle' }),
  mon('m3', 'garchomp', ['earthquake', 'dragonclaw', 'rockslide', 'protect'], { speed: 169, ability: 'roughskin' }),
  mon('m4', 'gholdengo', ['makeitrain', 'shadowball', 'nastyplot', 'protect'], { speed: 149, ability: 'goodasgold' }),
  mon('m5', 'farigiraf', ['trickroom', 'expandingforce', 'bodypress', 'protect'], { speed: 80, ability: 'armortail' }),
];

const THEIRS: PreviewMon[] = [
  mon('t0', 'sneasler', ['closecombat', 'direclaw', 'fakeout', 'protect'], { speed: 172, usage: 0.37, ability: 'unburden' }),
  mon('t1', 'kingambit', ['kowtowcleave', 'ironhead', 'suckerpunch', 'protect'], { speed: 70, usage: 0.25, ability: 'defiant' }),
  mon('t2', 'salamencemega', ['dracometeor', 'hurricane', 'tailwind', 'protect'], { speed: 189, usage: 0.28, ability: 'aerilate', base: 'salamence' }),
  mon('t3', 'charizardmegay', ['heatwave', 'weatherball', 'protect'], { speed: 167, usage: 0.12, ability: 'drought' }),
  mon('t4', 'whimsicott', ['moonblast', 'tailwind', 'encore', 'protect'], { speed: 165, ability: 'prankster' }),
  mon('t5', 'archaludon', ['dracometeor', 'bodypress', 'thunderbolt', 'protect'], { speed: 105, usage: 0.05, ability: 'stamina' }),
];

const edge = (a: string, b: string, delta: number, n: number): Edge => ({
  a,
  b,
  score: Math.round(50 + 50 * Math.tanh(delta / 4)),
  delta,
  n,
  source: 'replays',
  reasons: [],
});

describe('bringWeights', () => {
  it('turns usage into bring chances that sum to about four', () => {
    const w = bringWeights(THEIRS);
    const total = [...w.values()].reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(3.5);
    expect(total).toBeLessThanOrEqual(4.0001);
    expect(w.get('t0')!).toBeGreaterThan(w.get('t5')!);
    // No usage data: the average of the known shares.
    expect(w.get('t4')!).toBeCloseTo(4 * (1.07 / 5) / (1.07 + 1.07 / 5), 5);
  });

  it('splits evenly without any usage', () => {
    const w = bringWeights(MINE);
    expect([...w.values()].every((v) => Math.abs(v - 4 / 6) < 1e-9)).toBe(true);
  });
});

describe('recommend', () => {
  const chart = dex.typechart;

  it('picks four and a lead pair deterministically', () => {
    const a = recommend({ mine: MINE, theirs: THEIRS, chart });
    const b = recommend({ mine: [...MINE].reverse(), theirs: THEIRS, chart });
    expect(a.bring).toHaveLength(4);
    expect(new Set(a.bring).size).toBe(4);
    expect([...a.bring].sort()).toEqual([...b.bring].sort());
    expect(a.lead!.leads).toHaveLength(2);
    expect(a.lead!.back).toHaveLength(2);
    expect([...a.lead!.leads, ...a.lead!.back].sort()).toEqual([...a.bring].sort());
    expect(a.ranked).toHaveLength(6);
    expect(a.bringNotes.filter((n) => n.startsWith('Leave'))).toHaveLength(2);
  });

  it('explains every pick with at most three reasons', () => {
    const r = recommend({ mine: MINE, theirs: THEIRS, chart });
    for (const x of r.ranked) {
      expect(x.reasons.length).toBeLessThanOrEqual(3);
      expect(x.score).toBeGreaterThanOrEqual(0);
      expect(x.score).toBeLessThanOrEqual(100);
    }
    const chomp = r.ranked.find((x) => x.id === 'm3')!;
    // Garchomp is weak to Mega Salamence's Dragon STAB and Whimsicott's Fairy STAB.
    expect(chomp.signals.some((s) => s.key === 'theory' && s.value < 0)).toBe(true);
  });

  it('uses replay head-to-head edges with their n', () => {
    const base = recommend({ mine: MINE, theirs: THEIRS, chart }, 'replays');
    const withEdges = recommend(
      { mine: MINE, theirs: THEIRS, chart, h2h: { counters: [edge('incineroar', 'sneasler', 6, 300)], synergies: [] } },
      'replays',
    );
    const inc = withEdges.ranked.find((x) => x.id === 'm1')!;
    expect(inc.raw).toBeGreaterThan(base.ranked.find((x) => x.id === 'm1')!.raw);
    expect(inc.reasons[0]).toMatchObject({ kind: 'stat', n: 300, delta: 6, source: 'showdown-replays' });
    expect(withEdges.ranked[0]!.id).toBe('m1');
  });

  it('ignores edges below the n = 15 gate', () => {
    const r = recommend({ mine: MINE, theirs: THEIRS, chart, h2h: { counters: [edge('incineroar', 'sneasler', 6, 10)], synergies: [] } }, 'replays');
    expect(r.ranked.find((x) => x.id === 'm1')!.raw).toBe(0);
  });

  it('values damage from the calc matrix', () => {
    const damage: DamageTable = { mine: {}, theirs: {} };
    damage.mine['m4'] = { t0: { move: 'makeitrain', moveName: 'Make It Rain', minPct: 105, maxPct: 124, koN: 1, koChance: 1 } };
    const r = recommend({ mine: MINE, theirs: THEIRS, chart, damage }, 'damage');
    expect(r.ranked[0]!.id).toBe('m4');
    expect(r.ranked[0]!.reasons[0]!.text).toContain('OHKO Sneasler with Make It Rain');
    expect(r.ranked[0]!.reasons[0]!.source).toBe('smogon-calc');
  });

  it('values Trick Room when your team is slower and Fake Out in the lead', () => {
    const slow = MINE.map((m) => ({ ...m, speed: m.key === 'm5' ? 40 : 60 }));
    const r = recommend({ mine: slow, theirs: THEIRS, chart }, 'speed');
    const tr = r.ranked.find((x) => x.id === 'm5')!;
    expect(tr.reasons.some((x) => /Trick Room/.test(x.text))).toBe(true);
    const balanced = recommend({ mine: MINE, theirs: THEIRS, chart });
    expect(balanced.lead!.reasons.length).toBeGreaterThan(0);
  });

  it('handles empty sides', () => {
    expect(recommend({ mine: [], theirs: THEIRS, chart })).toMatchObject({ bring: [], lead: null });
    const r = recommend({ mine: MINE.slice(0, 3), theirs: [], chart });
    expect(r.bring).toHaveLength(3);
  });
});
