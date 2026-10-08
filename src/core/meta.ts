import type { CardIndex } from './cards.js';
import { isLand } from './cards.js';
import { type FuzzyLookup, parseAndResolve, type ResolvedDeck } from './deck.js';

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
