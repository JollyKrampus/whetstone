import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { CardIndex } from './cards.js';
import { isLand } from './cards.js';
import { countCards, type FuzzyLookup, parseAndResolve, playEntries, type ResolvedDeck } from './deck.js';

/** One meta decklist as supplied by the client or a local snapshot. */
export interface MetaListInput {
  name?: string;
  archetype?: string;
  /** Arena export text. */
  list: string;
  winRate?: number;
  /** Share of the metagame, 0-1 (or 0-100, normalized). */
  metaShare?: number;
}

export interface MetaList {
  name: string;
  archetype: string;
  winRate?: number;
  /** Normalized weight; all lists sum to 1. */
  weight: number;
  deck: ResolvedDeck;
  /** Main-deck copies by oracle ID (commander included). */
  main: Map<string, number>;
}

export interface MetaContext {
  lists: MetaList[];
  /** Weighted play rate per oracle ID: summed weight of the lists that run it. */
  playRate: Map<string, number>;
  maxNonlandRate: number;
  unresolved: { list: string; issues: ResolvedDeck['unresolved'] }[];
}

export async function buildMeta(inputs: MetaListInput[], index: CardIndex, fuzzy?: FuzzyLookup): Promise<MetaContext> {
  const shares = inputs.map((m) => (m.metaShare === undefined ? undefined : m.metaShare > 1 ? m.metaShare / 100 : m.metaShare));
  const known = shares.filter((s): s is number => s !== undefined && s > 0);
  const fallback = known.length ? Math.min(...known) / 2 : 1;
  const raw = shares.map((s) => (s !== undefined && s > 0 ? s : fallback));
  const total = raw.reduce((a, b) => a + b, 0) || 1;

  const lists: MetaList[] = [];
  const unresolved: MetaContext['unresolved'] = [];
  for (const [i, input] of inputs.entries()) {
    const deck = await parseAndResolve(input.list, index, fuzzy);
    const name = input.name ?? input.archetype ?? deck.name ?? `List ${i + 1}`;
    if (deck.unresolved.length) unresolved.push({ list: name, issues: deck.unresolved });
    const main = new Map<string, number>();
    for (const e of [...(deck.commander ? [deck.commander] : []), ...deck.main]) {
      main.set(e.oracleId, (main.get(e.oracleId) ?? 0) + e.qty);
    }
    lists.push({
      name,
      archetype: input.archetype ?? input.name ?? deck.name ?? `List ${i + 1}`,
      ...(input.winRate !== undefined ? { winRate: input.winRate } : {}),
      weight: raw[i]! / total,
      deck,
      main,
    });
  }

  const playRate = new Map<string, number>();
  for (const l of lists) for (const id of l.main.keys()) playRate.set(id, (playRate.get(id) ?? 0) + l.weight);
  let maxNonlandRate = 0;
  for (const [id, rate] of playRate) {
    const card = index.byOracle.get(id);
    if (card && !isLand(card)) maxNonlandRate = Math.max(maxNonlandRate, rate);
  }
  return { lists, playRate, maxNonlandRate, unresolved };
}

// ---- local snapshots -------------------------------------------------------------------

export const snapshotSchema = z.object({
  format: z.string(),
  date: z.string().optional(),
  source: z.string().optional(),
  decks: z
    .array(
      z.object({
        name: z.string().optional(),
        archetype: z.string().optional(),
        metaShare: z.number().optional(),
        winRate: z.number().optional(),
        list: z.string(),
      }),
    )
    .min(1),
});

export type MetaSnapshot = z.infer<typeof snapshotSchema>;

/** Reads `<config dir>/meta/<format>.json`, or returns null when there is none. */
export function loadSnapshot(configDir: string, format: string): { snapshot: MetaSnapshot; path: string } | null {
  const file = path.join(configDir, 'meta', `${format}.json`);
  if (!existsSync(file)) return null;
  const parsed = snapshotSchema.safeParse(JSON.parse(readFileSync(file, 'utf8')));
  if (!parsed.success) throw new Error(`Invalid meta snapshot ${file}: ${parsed.error.message}`);
  return { snapshot: parsed.data, path: file };
}

// ---- comparison ------------------------------------------------------------------------

function nonlandCounts(deck: ResolvedDeck): Map<string, { name: string; qty: number }> {
  const m = new Map<string, { name: string; qty: number }>();
  for (const e of playEntries(deck)) {
    if (isLand(e.card)) continue;
    const cur = m.get(e.oracleId) ?? { name: e.name, qty: 0 };
    cur.qty += e.qty;
    m.set(e.oracleId, cur);
  }
  return m;
}

/** Shared nonland copies over the larger nonland count: 1 means the same spells. */
export function overlap(a: Map<string, { qty: number }>, b: Map<string, { qty: number }>): number {
  let shared = 0;
  for (const [id, x] of a) shared += Math.min(x.qty, b.get(id)?.qty ?? 0);
  const size = Math.max(countCards([...a.values()]), countCards([...b.values()]));
  return size ? shared / size : 0;
}

export function compareToMeta(deck: ResolvedDeck, meta: MetaContext) {
  const mine = nonlandCounts(deck);
  const ranked = meta.lists
    .map((l) => ({ list: l, cards: nonlandCounts(l.deck) }))
    .map((x) => ({ ...x, overlap: overlap(mine, x.cards) }))
    .sort((a, b) => b.overlap - a.overlap || b.list.weight - a.list.weight || (a.list.name < b.list.name ? -1 : 1));
  const best = ranked[0];
  if (!best) return null;

  // Core cards: the closest list's nonland cards, plus anything in at least half the lists of its archetype.
  const sameArchetype = ranked.filter((r) => r.list.archetype === best.list.archetype);
  const core = new Map<string, { name: string; qty: number }>(best.cards);
  for (const r of sameArchetype) {
    for (const [id, c] of r.cards) {
      const share = sameArchetype.filter((o) => o.cards.has(id)).length / sameArchetype.length;
      if (share >= 0.5 && !core.has(id)) core.set(id, c);
    }
  }
  const missingCore = [...core.entries()]
    .map(([id, c]) => ({ name: c.name, metaQty: c.qty, deckQty: mine.get(id)?.qty ?? 0 }))
    .filter((c) => c.deckQty < c.metaQty)
    .sort((a, b) => b.metaQty - b.deckQty - (a.metaQty - a.deckQty) || (a.name < b.name ? -1 : 1));
  const unusual = [...mine.entries()]
    .filter(([id]) => !meta.playRate.has(id))
    .map(([, c]) => ({ name: c.name, qty: c.qty }))
    .sort((a, b) => b.qty - a.qty || (a.name < b.name ? -1 : 1));

  const pct = (n: number) => Math.round(n * 1000) / 10;
  return {
    closest: {
      name: best.list.name,
      archetype: best.list.archetype,
      overlapPercent: pct(best.overlap),
      ...(best.list.winRate !== undefined ? { winRate: best.list.winRate } : {}),
      shareOfSuppliedListsPercent: pct(best.list.weight),
    },
    ranking: ranked.map((r) => ({ name: r.list.name, archetype: r.list.archetype, overlapPercent: pct(r.overlap) })),
    missingCore,
    unusual,
  };
}
