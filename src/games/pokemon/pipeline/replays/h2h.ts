/**
 * Ledger games → h2h.json edges with the shared statistics of src/core/stats.ts (SPEC §6):
 *
 *  - base rate per species: wins / games among games it was brought to, shrunk with the
 *    empirical-Bayes Beta prior (shrinkAll);
 *  - counters: for every game, each species the winner brought "beat" each species the loser
 *    brought (and vice versa for losses), relation 'counter': shrunk toward the logit-additive
 *    expectation, antisymmetrised, scored 1–100, with n and z;
 *  - synergies: pairs brought together by one side, relation 'synergy', stored once with a < b.
 *
 * Pairs below the display floor (n < 15) are left out. To keep a file that changes daily small,
 * each species keeps its MAX_PER_SPECIES strongest and weakest edges (a kept counter keeps both
 * directions, so the file stays antisymmetric). Edges carry source 'replays'.
 */
import type { Edge } from '../../../../core/game.ts';
import { edgesFromPairs, GATES, shrinkAll, type PairRow } from '../../../../core/stats.ts';
import { compareStrings } from '../../../../../pipeline/hash.ts';
import type { H2H } from '../../schema.ts';
import type { LedgerGame } from './ledger.ts';

/** Strongest and weakest edges kept per species and relation (pages list far fewer). */
export const MAX_PER_SPECIES = 12;

/**
 * Keep, per species, its `max` highest- and `max` lowest-delta edges (ties by n, then ids).
 * An edge survives when either endpoint keeps it; a counter also keeps its mirror.
 */
export function capPerSpecies(edges: readonly Edge[], max: number, directed: boolean): Edge[] {
  const bySpecies = new Map<string, Edge[]>();
  for (const e of edges) {
    for (const id of directed ? [e.a] : [e.a, e.b]) bySpecies.set(id, [...(bySpecies.get(id) ?? []), e]);
  }
  const key = (e: Edge): string => `${e.a}|${e.b}`;
  const keep = new Set<string>();
  const order = (x: Edge, y: Edge): number => (y.delta ?? 0) - (x.delta ?? 0) || (y.n ?? 0) - (x.n ?? 0) || compareStrings(key(x), key(y));
  for (const list of bySpecies.values()) {
    const sorted = [...list].sort(order);
    for (const e of [...sorted.slice(0, max), ...sorted.slice(-max)]) keep.add(key(e));
  }
  if (directed) for (const k of [...keep]) keep.add(k.split('|').reverse().join('|'));
  return edges.filter((e) => keep.has(key(e)));
}

export interface H2HOptions {
  regulation: string;
  format: string;
  window: { label: string; from: string; to: string };
  names: Readonly<Record<string, string>>;
  minN?: number;
  /** Per-species cap (default MAX_PER_SPECIES). */
  maxPerSpecies?: number;
}

function tallyRows(map: Map<string, PairRow>, a: string, b: string, won: boolean): void {
  const key = `${a}\u0000${b}`;
  const row = map.get(key) ?? { a, b, wins: 0, games: 0 };
  row.games++;
  if (won) row.wins++;
  map.set(key, row);
}

const asReplayEdge = (e: Edge): Edge => ({ ...e, source: 'replays', reasons: e.reasons.map((r) => ({ ...r, source: 'showdown-replays' })) });

export function h2hFromGames(games: readonly LedgerGame[], o: H2HOptions): H2H {
  const units = new Map<string, { id: string; wins: number; n: number }>();
  const counters = new Map<string, PairRow>();
  const synergies = new Map<string, PairRow>();
  for (const g of games) {
    for (const [i, side] of g.sides.entries()) {
      const won = g.winner === i + 1;
      const other = g.sides[1 - i] as LedgerGame['sides'][number];
      for (const a of side.brought) {
        const u = units.get(a) ?? { id: a, wins: 0, n: 0 };
        u.n++;
        if (won) u.wins++;
        units.set(a, u);
        for (const b of other.brought) if (a !== b) tallyRows(counters, a, b, won);
      }
      const brought = [...side.brought].sort(compareStrings);
      for (let x = 0; x < brought.length; x++) {
        for (let y = x + 1; y < brought.length; y++) tallyRows(synergies, brought[x] as string, brought[y] as string, won);
      }
    }
  }
  const { rates } = shrinkAll([...units.values()].sort((a, b) => compareStrings(a.id, b.id)));
  const common = { baseRates: rates, names: o.names, source: 'showdown-replays', minN: o.minN ?? GATES.hideBelow };
  const sorted = (m: Map<string, PairRow>): PairRow[] => [...m.values()].sort((a, b) => compareStrings(a.a, b.a) || compareStrings(a.b, b.b));
  return {
    source: 'showdown-replays',
    attribution: { source: 'showdown-replays', text: 'Matchups: public Pokémon Showdown Bo3 replays; player names removed', url: 'https://replay.pokemonshowdown.com/' },
    regulation: o.regulation,
    format: o.format,
    window: o.window,
    replays: games.length,
    counters: capPerSpecies(edgesFromPairs(sorted(counters), { relation: 'counter', ...common }), o.maxPerSpecies ?? MAX_PER_SPECIES, true).map(asReplayEdge),
    synergies: capPerSpecies(edgesFromPairs(sorted(synergies), { relation: 'synergy', ...common }), o.maxPerSpecies ?? MAX_PER_SPECIES, false).map(asReplayEdge),
  };
}
