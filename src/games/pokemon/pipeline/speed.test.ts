import { Generations, Pokemon } from '@smogon/calc';
import { describe, expect, it } from 'vitest';
import { NATURES, SpeedTiersSchema, type Nature, type Species, type Usage, type UsageEntry } from '../schema.ts';
import { natureFactor, scarfed, speedStat, speedTiers } from './speed.ts';

const gen = Generations.get(0);

describe('Champions Speed formula', () => {
  it('is floor((base + SP + 20) × nature) at level 50', () => {
    expect(speedStat(120, 32, 'Jolly')).toBe(189); // Sneasler, max Speed
    expect(speedStat(120, 32, 'Adamant')).toBe(172);
    expect(speedStat(60, 0, 'Careful')).toBe(80); // Incineroar
    expect(speedStat(60, 0, 'Brave')).toBe(72);
    expect(speedStat(85, 0, 100)).toBe(105);
    expect(natureFactor('Timid')).toBe(110);
    expect(natureFactor('Quiet')).toBe(90);
    expect(natureFactor('Bold')).toBe(100);
  });

  it('agrees with @smogon/calc generation 0 for every nature and a range of SP', () => {
    const cases: [string, number][] = [
      ['Garchomp', 102],
      ['Incineroar', 60],
      ['Kingambit', 50],
      ['Pelipper', 65],
      ['Raichu-Mega-Y', 130],
      ['Garchomp-Mega-Z', 151],
    ];
    for (const [name, base] of cases) {
      for (const nature of NATURES) {
        for (const sp of [0, 1, 2, 15, 31, 32]) {
          const mon = new Pokemon(gen, name, { nature, evs: { spe: sp }, level: 50 });
          expect(mon.species.baseStats.spe, name).toBe(base);
          expect(speedStat(base, sp, nature as Nature), `${name} ${nature} ${sp}`).toBe(mon.stats.spe);
        }
      }
    }
  });

  it('rounds Choice Scarf down', () => {
    expect(scarfed(105)).toBe(157);
    expect(scarfed(128)).toBe(192);
  });
});

const sp = (spe: number): [number, number, number, number, number, number] => [2, 32, 0, 0, 0, spe];
function entry(id: string, rank: number, usage: number, extra: Partial<UsageEntry> = {}): UsageEntry {
  return { id, rank, usage, raw: 1000, abilities: [], items: [], moves: [], teammates: [], spreads: [], checks: [], ...extra };
}
const mon = (id: string, spe: number): Species => ({
  id,
  name: id,
  num: 1,
  types: ['Normal'],
  base: { hp: 50, atk: 50, def: 50, spa: 50, spd: 50, spe },
  abilities: ['x'],
  weightkg: 1,
  legal: ['M-C'],
});

describe('speedTiers', () => {
  const usage: Usage = {
    source: 'smogon',
    attribution: { source: 'smogon', text: 'Usage', url: 'https://www.smogon.com/stats/' },
    regulation: 'M-C',
    format: 'gen9championsvgc2026regmc',
    cutoff: 1760,
    month: '2026-09',
    battles: 1000,
    pokemon: [
      entry('fast', 1, 0.4, {
        spreads: [
          { nature: 'Jolly', sp: sp(32), share: 0.3 },
          { nature: 'Adamant', sp: sp(32), share: 0.2 },
          // Same Speed as Adamant (neutral nature, 32 SP): pooled with it, 0.35 beats Jolly 0.3.
          { nature: 'Hardy', sp: sp(32), share: 0.15 },
        ],
        items: [{ id: 'choicescarf', share: 0.1 }],
        moves: [{ id: 'tailwind', share: 0.6 }],
      }),
      entry('slow', 2, 0.3, {
        spreads: [
          { nature: 'Brave', sp: sp(0), share: 0.5 },
          { nature: 'Adamant', sp: sp(0), share: 0.1 },
        ],
        moves: [{ id: 'trickroom', share: 0.9 }],
      }),
      entry('tie', 3, 0.2, { spreads: [{ nature: 'Brave', sp: sp(0), share: 0.4 }] }),
      entry('rare', 4, 0.001, { spreads: [{ nature: 'Timid', sp: sp(32), share: 1 }] }),
      entry('nospreads', 5, 0.1),
      entry('notindex', 6, 0.1, { spreads: [{ nature: 'Timid', sp: sp(32), share: 1 }] }),
    ],
  };
  const species = [mon('fast', 100), mon('slow', 30), mon('tie', 30), mon('rare', 100), mon('nospreads', 80)];
  const tiers = speedTiers(usage, species);

  it('reports the most common Speed with its references, sorted fastest first', () => {
    expect(SpeedTiersSchema.safeParse(tiers).success).toBe(true);
    expect(tiers.entries.map((e) => e.id)).toEqual(['fast', 'slow', 'tie']);
    const fast = tiers.entries[0]!;
    // Adamant and Hardy with 32 SP both give 152 (pooled, 0.35 of 0.65); Jolly gives 167 (0.3).
    expect(fast).toMatchObject({ base: 100, speed: 152, nature: 'Adamant', sp: 32, max: 167, neutral: 120, min: 108 });
    expect(fast.share).toBeCloseTo(0.35 / 0.65, 4);
    expect(fast.scarf).toEqual({ share: 0.1, speed: 228 });
    expect(fast.tailwind).toBe(0.6);
    expect(tiers.entries.find((e) => e.id === 'slow')).toMatchObject({ speed: 45, nature: 'Brave', trickRoom: 0.9 });
    expect(tiers).toMatchObject({ regulation: 'M-C', format: 'gen9championsvgc2026regmc', cutoff: 1760, month: '2026-09' });
  });

  it('breaks Speed ties by id and skips rare, spread-less and unknown species', () => {
    const ids = tiers.entries.map((e) => e.id);
    expect(ids.indexOf('slow')).toBeLessThan(ids.indexOf('tie'));
    expect(ids).not.toContain('rare');
    expect(ids).not.toContain('nospreads');
    expect(ids).not.toContain('notindex');
  });
});
