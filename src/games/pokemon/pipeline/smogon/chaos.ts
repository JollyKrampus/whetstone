/**
 * Smogon "chaos" JSON (monthly usage of one format at one rating cutoff) → UsageSchema, keeping
 * the top K of each field. Pure.
 *
 * Chaos values are weighted counts. Each species' weights are normalised by its own total (the
 * sum of its Abilities weights), so a share reads "fraction of this Pokémon's sets", e.g. Fake
 * Out on 0.99 of Rillaboom sets. Spreads are already Stat Points for Champions
 * ("Adamant:32/32/0/0/2/0", HP/Atk/Def/SpA/SpD/Spe); anything EV-shaped is converted with the
 * HOME rule and anything still invalid is dropped. Checks and counters keep rows with n ≥ 20,
 * ranked like Smogon's moveset files by p − 4d.
 */
import { z } from 'zod';
import { compareStrings } from '../../../../../pipeline/hash.ts';
import { NATURES, type Cutoff, type Nature, type Usage, type UsageEntry } from '../../schema.ts';
import type { DexIndex } from '../ids.ts';
import { toId } from '../ids.ts';

export const TOP = { abilities: 3, items: 6, moves: 10, teammates: 12, spreads: 8, checks: 15 } as const;
export const CHECK_MIN_N = 20;
const SP_MAX = 32;
const SP_TOTAL = 66;

const Weights = z.record(z.string(), z.number());
const ChaosSpeciesSchema = z.looseObject({
  usage: z.number(),
  'Raw count': z.number(),
  Abilities: Weights,
  Items: Weights,
  Moves: Weights,
  Spreads: Weights,
  Teammates: Weights,
  'Checks and Counters': z.record(z.string(), z.union([z.strictObject({ n: z.number(), p: z.number(), d: z.number() }), z.tuple([z.number(), z.number(), z.number()])])),
});
export const ChaosSchema = z.looseObject({
  info: z.looseObject({ metagame: z.string(), cutoff: z.number(), 'number of battles': z.number() }),
  data: z.record(z.string(), ChaosSpeciesSchema),
});
export type Chaos = z.infer<typeof ChaosSchema>;

const round = (x: number, digits: number): number => {
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
};
const share = (w: number, total: number): number => (total > 0 ? Math.min(1, Math.max(0, round(w / total, 4))) : 0);

/** HOME's EV → Stat Point conversion: 4 EVs buy the first point, every further 8 EVs one more. */
export function evToSp(ev: number): number {
  return ev < 4 ? 0 : Math.min(SP_MAX, 1 + Math.floor((ev - 4) / 8));
}

/** `Nature:hp/atk/def/spa/spd/spe` → nature and a legal SP spread, or null. */
export function parseSpread(key: string): { nature: Nature; sp: [number, number, number, number, number, number] } | null {
  const m = /^([A-Za-z]+):(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)\/(\d+)$/.exec(key);
  if (!m) return null;
  const nature = (NATURES as readonly string[]).find((n) => n.toLowerCase() === (m[1] as string).toLowerCase()) as Nature | undefined;
  if (!nature) return null;
  let sp = m.slice(2, 8).map(Number) as [number, number, number, number, number, number];
  if (sp.some((v) => v > SP_MAX) || sp.reduce((a, b) => a + b, 0) > SP_TOTAL) sp = sp.map(evToSp) as typeof sp;
  if (sp.some((v) => v > SP_MAX) || sp.reduce((a, b) => a + b, 0) > SP_TOTAL) return null;
  return { nature, sp };
}

function top<T extends { share: number }>(rows: T[], k: number, key: (r: T) => string): T[] {
  return rows.sort((a, b) => b.share - a.share || compareStrings(key(a), key(b))).slice(0, k);
}

export interface ChaosContext {
  regulation: string;
  format: string;
  cutoff: Cutoff;
  month: string;
  dex: DexIndex;
  moves: ReadonlySet<string>;
  items: ReadonlySet<string>;
  abilities: ReadonlySet<string>;
}

export interface ChaosResult {
  usage: Usage;
  /** Species keys that do not resolve in the dex (dropped). */
  unknown: string[];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${MONTHS[m - 1] ?? month} ${y}`;
}

export function chaosToUsage(chaos: Chaos, c: ChaosContext): ChaosResult {
  const unknown: string[] = [];
  const entries: Omit<UsageEntry, 'rank'>[] = [];
  for (const [name, d] of Object.entries(chaos.data)) {
    const id = c.dex.species(name);
    if (!id) {
      unknown.push(name);
      continue;
    }
    const total = Object.values(d.Abilities).reduce((a, b) => a + b, 0) || Object.values(d.Items).reduce((a, b) => a + b, 0);
    const pick = (weights: Record<string, number>, known: ReadonlySet<string>) => {
      const merged = new Map<string, number>();
      for (const [k, w] of Object.entries(weights)) {
        const kid = toId(k);
        if (known.has(kid)) merged.set(kid, (merged.get(kid) ?? 0) + w);
      }
      return [...merged].map(([kid, w]) => ({ id: kid, share: share(w, total) })).filter((r) => r.share > 0);
    };
    const mates = new Map<string, number>();
    for (const [k, w] of Object.entries(d.Teammates)) {
      const mid = c.dex.species(k);
      if (mid && mid !== id) mates.set(mid, (mates.get(mid) ?? 0) + w);
    }
    const spreads = new Map<string, { nature: Nature; sp: [number, number, number, number, number, number]; w: number }>();
    for (const [k, w] of Object.entries(d.Spreads)) {
      const s = parseSpread(k);
      if (!s) continue;
      const key = `${s.nature}:${s.sp.join('/')}`;
      const prev = spreads.get(key);
      spreads.set(key, { ...s, w: (prev?.w ?? 0) + w });
    }
    const checks = Object.entries(d['Checks and Counters'])
      .map(([k, v]) => {
        const [n, p, dev] = Array.isArray(v) ? v : [v.n, v.p, v.d];
        return { id: c.dex.species(k), n, p, d: dev };
      })
      .filter((r): r is { id: string; n: number; p: number; d: number } => r.id !== null && r.id !== id && r.n >= CHECK_MIN_N && r.p >= 0 && r.p <= 1)
      .sort((a, b) => b.p - 4 * b.d - (a.p - 4 * a.d) || compareStrings(a.id, b.id))
      .slice(0, TOP.checks)
      .map((r) => ({ id: r.id, n: round(r.n, 1), p: round(r.p, 4), d: round(Math.max(0, r.d), 4) }));
    entries.push({
      id,
      usage: Math.min(1, Math.max(0, round(d.usage, 6))),
      raw: Math.max(0, Math.round(d['Raw count'])),
      abilities: top(pick(d.Abilities, c.abilities), TOP.abilities, (r) => r.id),
      items: top(pick(d.Items, c.items), TOP.items, (r) => r.id),
      moves: top(pick(d.Moves, c.moves), TOP.moves, (r) => r.id),
      teammates: top([...mates].map(([mid, w]) => ({ id: mid, share: share(w, total) })).filter((r) => r.share > 0), TOP.teammates, (r) => r.id),
      spreads: top([...spreads.values()].map((s) => ({ nature: s.nature, sp: s.sp, share: share(s.w, total) })).filter((r) => r.share > 0), TOP.spreads, (r) => `${r.nature}:${r.sp.join('/')}`),
      checks,
    });
  }
  // Two keys can fold into one id (cosmetic formes); keep the larger.
  const byId = new Map<string, Omit<UsageEntry, 'rank'>>();
  for (const e of entries) {
    const prev = byId.get(e.id);
    if (!prev || e.usage > prev.usage) byId.set(e.id, e);
  }
  const pokemon = [...byId.values()]
    .sort((a, b) => b.usage - a.usage || compareStrings(a.id, b.id))
    .map((e, i) => ({ ...e, rank: i + 1 }));
  const usage: Usage = {
    source: 'smogon',
    attribution: {
      source: 'smogon',
      text: `Usage: Smogon usage statistics, Pokémon Showdown ladder, ${monthLabel(c.month)}, ${c.cutoff > 0 ? `${c.cutoff} rating cutoff` : 'all games (cutoff 0)'}`,
      url: `https://www.smogon.com/stats/${c.month}/`,
    },
    regulation: c.regulation,
    format: c.format,
    cutoff: c.cutoff,
    month: c.month,
    battles: Math.max(0, Math.round(chaos.info['number of battles'])),
    pokemon,
  };
  return { usage, unknown };
}
