/**
 * Speed tiers at level 50 with Stat Points (Champions): IVs are fixed at 31, each SP adds 1,
 * so Speed = floor((base + SP + 20) × nature) with nature 1.1 / 1.0 / 0.9, computed in
 * integers exactly like Showdown's champions mod (scripts.ts statModify). Verified against
 * @smogon/calc's Champions stat code in speed.test.ts.
 *
 * Each entry reports the Speed that the most sets of that species actually run, from the
 * usage file's spreads (spreads giving the same Speed are pooled), plus the usual references:
 * max (32 SP, +Spe), neutral (0 SP, neutral) and min (0 SP, −Spe, for Trick Room). Choice
 * Scarf (× 1.5), Tailwind and Trick Room shares come from the same usage entry.
 */
import { compareStrings } from '../../../../pipeline/hash.ts';
import type { Nature, Species, SpeedTiers, Usage } from '../schema.ts';

export const SPEED_PLUS: ReadonlySet<Nature> = new Set<Nature>(['Timid', 'Hasty', 'Jolly', 'Naive']);
export const SPEED_MINUS: ReadonlySet<Nature> = new Set<Nature>(['Brave', 'Relaxed', 'Quiet', 'Sassy']);

/** Usage share below which a species is left out of the speed tiers. */
export const SPEED_MIN_USAGE = 0.005;

export function natureFactor(nature: Nature): 110 | 100 | 90 {
  return SPEED_PLUS.has(nature) ? 110 : SPEED_MINUS.has(nature) ? 90 : 100;
}

/** Level-50 Speed: floor((base + sp + 20) × nature), integer arithmetic. */
export function speedStat(base: number, sp: number, nature: Nature | 110 | 100 | 90): number {
  const f = typeof nature === 'number' ? nature : natureFactor(nature);
  return Math.floor(((base + sp + 20) * f) / 100);
}

/** Choice Scarf multiplies Speed by 1.5 (rounded down). */
export function scarfed(speed: number): number {
  return Math.floor((speed * 3) / 2);
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

export function speedTiers(usage: Usage, species: readonly Species[], minUsage = SPEED_MIN_USAGE): SpeedTiers {
  const byId = new Map(species.map((s) => [s.id, s]));
  const entries: SpeedTiers['entries'] = [];
  for (const p of usage.pokemon) {
    const s = byId.get(p.id);
    if (!s || p.usage < minUsage || p.spreads.length === 0) continue;
    const base = s.base.spe;
    // Pool spreads by the Speed they produce; remember the most common nature/SP behind each.
    const pools = new Map<number, { share: number; best: { nature: Nature; sp: number; share: number } }>();
    let covered = 0;
    for (const sp of p.spreads) {
      const speed = speedStat(base, sp.sp[5], sp.nature);
      covered += sp.share;
      const pool = pools.get(speed);
      if (!pool) pools.set(speed, { share: sp.share, best: { nature: sp.nature, sp: sp.sp[5], share: sp.share } });
      else {
        pool.share += sp.share;
        if (sp.share > pool.best.share) pool.best = { nature: sp.nature, sp: sp.sp[5], share: sp.share };
      }
    }
    const [speed, pool] = [...pools].sort((a, b) => b[1].share - a[1].share || b[0] - a[0])[0] as [number, { share: number; best: { nature: Nature; sp: number } }];
    const entry: SpeedTiers['entries'][number] = {
      id: p.id,
      base,
      speed,
      nature: pool.best.nature,
      sp: pool.best.sp,
      share: covered > 0 ? Math.min(1, round4(pool.share / covered)) : 0,
      max: speedStat(base, 32, 110),
      neutral: speedStat(base, 0, 100),
      min: speedStat(base, 0, 90),
    };
    const scarf = p.items.find((i) => i.id === 'choicescarf');
    if (scarf) entry.scarf = { share: scarf.share, speed: scarfed(speed) };
    const tailwind = p.moves.find((m) => m.id === 'tailwind');
    if (tailwind) entry.tailwind = tailwind.share;
    const trickRoom = p.moves.find((m) => m.id === 'trickroom');
    if (trickRoom) entry.trickRoom = trickRoom.share;
    entries.push(entry);
  }
  entries.sort((a, b) => b.speed - a.speed || compareStrings(a.id, b.id));
  return { regulation: usage.regulation, format: usage.format, cutoff: usage.cutoff, month: usage.month, entries };
}
