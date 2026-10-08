import type { CardIndex } from './cards.js';
import { type Issue, parseArenaText, type RawDeck, type RawEntry, type Section } from './parse.js';
import type { CardRecord } from './types.js';

export interface Entry {
  qty: number;
  name: string;
  oracleId: string;
  set?: string;
  collectorNumber?: string;
}

/** The public, JSON-serializable deck shape returned by parse_decklist. */
export interface Deck {
  name?: string;
  format?: string;
  commander?: Entry;
  companion?: Entry;
  main: Entry[];
  side: Entry[];
  unresolved: Issue[];
}

export interface ResolvedEntry extends Entry {
  card: CardRecord;
}

/** A deck with each entry's card record attached, for analysis. */
export interface ResolvedDeck {
  name?: string;
  format?: string;
  commander?: ResolvedEntry;
  companion?: ResolvedEntry;
  main: ResolvedEntry[];
  side: ResolvedEntry[];
  unresolved: Issue[];
}

/** Optional network fallback: returns an oracle ID for a misspelled name, or undefined. */
export type FuzzyLookup = (name: string) => Promise<string | undefined>;

export async function resolveDeck(
  raw: RawDeck,
  index: CardIndex,
  fuzzy?: FuzzyLookup,
  knownIds?: Map<RawEntry, string>,
): Promise<ResolvedDeck> {
  const deck: ResolvedDeck = { main: [], side: [], unresolved: [...raw.issues] };
  if (raw.name) deck.name = raw.name;
  const zones: Record<Section, ResolvedEntry[]> = { commander: [], companion: [], main: deck.main, side: deck.side };

  for (const e of raw.entries) {
    const known = knownIds?.get(e);
    const card = (known && index.byOracle.get(known)) || (await resolveName(e, index, fuzzy, deck.unresolved));
    if (!card) continue;
    const zone = zones[e.section];
    const existing = zone.find((x) => x.oracleId === card.oracleId);
    if (existing) {
      existing.qty += e.qty;
      continue;
    }
    zone.push({
      qty: e.qty,
      name: card.name,
      oracleId: card.oracleId,
      ...(e.set ? { set: e.set } : {}),
      ...(e.collectorNumber ? { collectorNumber: e.collectorNumber } : {}),
      card,
    });
  }

  const [commander, ...extraCommanders] = zones.commander;
  if (commander) deck.commander = { ...commander, qty: 1 };
  for (const c of extraCommanders) {
    deck.unresolved.push({ code: 'extra_commander', reason: 'Only one commander is supported.', text: c.name });
  }
  const [companion, ...extraCompanions] = zones.companion;
  if (companion) deck.companion = { ...companion, qty: 1 };
  for (const c of extraCompanions) {
    deck.unresolved.push({ code: 'extra_companion', reason: 'A deck can have only one companion.', text: c.name });
  }
  return deck;
}

async function resolveName(
  e: RawEntry,
  index: CardIndex,
  fuzzy: FuzzyLookup | undefined,
  issues: Issue[],
): Promise<CardRecord | undefined> {
  const where = { line: e.line, text: `${e.qty} ${e.name}` };
  if (/^A-\S/.test(e.name)) {
    issues.push({ code: 'alchemy_card', reason: 'Alchemy rebalanced (A-) cards are not supported.', ...where });
    return undefined;
  }
  const hit = index.lookup(e.name);
  if (hit) return hit;
  if (fuzzy) {
    const id = await fuzzy(e.name).catch(() => undefined);
    const card = id ? index.byOracle.get(id) : undefined;
    if (card) return card;
  }
  const suggestions = index.suggest(e.name);
  issues.push({
    code: 'unknown_card',
    reason: 'No card with this name.',
    ...where,
    ...(suggestions.length ? { suggestions } : {}),
  });
  return undefined;
}

export async function parseAndResolve(text: string, index: CardIndex, fuzzy?: FuzzyLookup) {
  return resolveDeck(parseArenaText(text), index, fuzzy);
}

/** Strips card records for JSON output. */
export function toPublicDeck(d: ResolvedDeck): Deck {
  const strip = ({ card: _card, ...e }: ResolvedEntry): Entry => e;
  return {
    ...(d.name ? { name: d.name } : {}),
    ...(d.format ? { format: d.format } : {}),
    ...(d.commander ? { commander: strip(d.commander) } : {}),
    ...(d.companion ? { companion: strip(d.companion) } : {}),
    main: d.main.map(strip),
    side: d.side.map(strip),
    unresolved: d.unresolved,
  };
}

/** Rebuilds a raw deck from a Deck object (e.g. one returned by parse_decklist). */
export function rawFromDeck(d: {
  name?: string;
  commander?: { qty?: number; name: string; oracleId?: string };
  companion?: { qty?: number; name: string; oracleId?: string };
  main: { qty: number; name: string; oracleId?: string }[];
  side?: { qty: number; name: string; oracleId?: string }[];
}): { raw: RawDeck; ids: Map<RawEntry, string> } {
  const raw: RawDeck = { entries: [], issues: [] };
  if (d.name) raw.name = d.name;
  const ids = new Map<RawEntry, string>();
  const add = (e: { qty?: number; name: string; oracleId?: string }, section: Section) => {
    const entry: RawEntry = { qty: e.qty ?? 1, name: e.name, section, line: 0 };
    raw.entries.push(entry);
    if (e.oracleId) ids.set(entry, e.oracleId);
  };
  if (d.commander) add(d.commander, 'commander');
  if (d.companion) add(d.companion, 'companion');
  d.main.forEach((e) => add(e, 'main'));
  (d.side ?? []).forEach((e) => add(e, 'side'));
  return { raw, ids };
}

/** Every entry with its zone, commander first. */
export function allEntries(d: ResolvedDeck): { zone: 'commander' | 'companion' | 'main' | 'side'; e: ResolvedEntry }[] {
  return [
    ...(d.commander ? [{ zone: 'commander' as const, e: d.commander }] : []),
    ...(d.companion ? [{ zone: 'companion' as const, e: d.companion }] : []),
    ...d.main.map((e) => ({ zone: 'main' as const, e })),
    ...d.side.map((e) => ({ zone: 'side' as const, e })),
  ];
}

/** Main deck plus commander: the cards you play with. */
export function playEntries(d: ResolvedDeck): ResolvedEntry[] {
  return [...(d.commander ? [d.commander] : []), ...d.main];
}

export function countCards(entries: { qty: number }[]): number {
  return entries.reduce((n, e) => n + e.qty, 0);
}
