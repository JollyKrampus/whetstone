/**
 * The analyzer behind the MTGA deck, search and meta pages: grindstone-mcp's browser-safe core
 * run against the staged card shards. Pure and environment-free (no DOM, no Worker globals,
 * no fetch of its own) so it is unit-tested in Node; analyzer.worker.ts wires it to messages,
 * fetch and IndexedDB.
 *
 * Card pools: the Standard shard is loaded first. The full Arena shard is loaded on demand,
 * when a deck has names the Standard pool does not know, when a non-Standard format needs the
 * whole pool (upgrades, search), or when a meta list needs it. Once loaded it replaces the
 * Standard index (it is a superset).
 */
import {
  CardIndex,
  analyzeDeck,
  asOfDate,
  buildMeta,
  compareToMeta,
  dealSampleHand,
  getFormat,
  parseArenaText,
  ratePower,
  resolveDeck,
  searchCards,
  simulateHands,
  suggestUpgrades,
  validateDeck,
  wildcardCost,
  wildcardRarity,
  type CardRecord,
  type FuzzyLookup,
  type IndexMeta,
  type MetaContext,
  type ResolvedDeck,
  type ResolvedEntry,
  type ValidationResult,
} from '#vendor/grindstone/core.js';
import { hydrateCardRecord, type CompactCardRecord } from '../schema.ts';
import {
  FORMAT_IDS,
  FORMAT_LABELS,
  type AnalyzeRequest,
  type AnalyzeResult,
  type CardView,
  type CheckListsRequest,
  type EntryView,
  type FormatId,
  type HandRequest,
  type HandResult,
  type InitResult,
  type LegalityView,
  type ListCheck,
  type MetaCompareView,
  type MetaSelection,
  type Pool,
  type PowerView,
  type SearchRequest,
  type SearchResult,
  type SimulateRequest,
  type SuggestRequest,
  type SuggestView,
} from './protocol.ts';

/** The JSON a shard file holds (CardShardSchema without zod). */
export interface ShardData {
  format: Pool;
  meta: IndexMeta;
  cards: CompactCardRecord[];
}

export type ShardLoader = (pool: Pool) => Promise<ShardData>;

/** Formats whose card pool fits in the Standard shard. */
const STANDARD_POOL_FORMATS: ReadonlySet<FormatId> = new Set(['standard', 'standardbrawl']);
/** Auto-detected format order: the narrowest 60-card format first. */
const AUTO_ORDER: readonly FormatId[] = ['standard', 'pioneer', 'historic', 'timeless'];
const AUTO_ORDER_COMMANDER: readonly FormatId[] = ['standardbrawl', 'brawl'];
/** Layouts whose Arena name is the front face only. */
const FRONT_NAME_LAYOUTS = new Set(['transform', 'modal_dfc', 'adventure', 'flip', 'meld', 'prototype', 'reversible_card']);

export class EngineError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'EngineError';
    this.code = code;
  }
}

/** Name to write in an Arena export: the front face for double-faced and adventure cards. */
export function arenaName(card: Pick<CardRecord, 'name' | 'layout' | 'faces'>): string {
  if (FRONT_NAME_LAYOUTS.has(card.layout) && card.faces[0]) return card.faces[0].name;
  return card.name;
}

/** Canonical Arena export of a resolved deck (no set codes, so Arena picks any printing you own). */
export function toArenaText(deck: ResolvedDeck): string {
  const line = (e: ResolvedEntry, qty = e.qty) => `${qty} ${arenaName(e.card)}`;
  const out: string[] = [];
  if (deck.name) out.push('About', `Name ${deck.name}`, '');
  if (deck.commander) out.push('Commander', line(deck.commander, 1), '');
  if (deck.companion) out.push('Companion', line(deck.companion, 1), '');
  out.push('Deck', ...deck.main.map((e) => line(e)));
  if (deck.side.length > 0) out.push('', 'Sideboard', ...deck.side.map((e) => line(e)));
  return out.join('\n');
}

export function cardView(c: CardRecord): CardView {
  const legal: CardView['legal'] = {};
  for (const f of FORMAT_IDS) {
    const v = c.legalities[f];
    if (v === 'legal' || v === 'banned' || v === 'restricted') legal[f] = v;
  }
  const extra = c as CardRecord & { scryfallId?: string; set?: string; cn?: string };
  return {
    oracleId: c.oracleId,
    name: c.name,
    manaCost: c.manaCost,
    cmc: c.cmc,
    typeLine: c.typeLine,
    oracleText: c.oracleText,
    layout: c.layout,
    colors: c.colors,
    rarity: wildcardRarity(c),
    ...(c.power !== undefined ? { power: c.power } : {}),
    ...(c.toughness !== undefined ? { toughness: c.toughness } : {}),
    faces: c.faces,
    ...(extra.scryfallId ? { scryfallId: extra.scryfallId } : {}),
    ...(extra.set ? { set: extra.set } : {}),
    ...(extra.cn ? { cn: extra.cn } : {}),
    legal,
  };
}

const entryView = (e: ResolvedEntry): EntryView => ({ qty: e.qty, name: e.name, oracleId: e.oracleId });

function count(entries: { qty: number }[]): number {
  return entries.reduce((n, e) => n + e.qty, 0);
}

/** Pick the format to analyze in when the user chose "auto": the narrowest one it is legal in. */
export function autoFormat(deck: ResolvedDeck, legality: readonly LegalityView[]): FormatId {
  const order = deck.commander ? AUTO_ORDER_COMMANDER : AUTO_ORDER;
  const byId = new Map(legality.map((l) => [l.format, l]));
  const legal = order.find((f) => byId.get(f)?.legal);
  if (legal) return legal;
  // Nothing is legal: the format with the fewest errors (ties go to the narrower one).
  let best: FormatId = order[0]!;
  let fewest = Number.POSITIVE_INFINITY;
  for (const f of order) {
    const errors = byId.get(f)?.issues.filter((i) => i.severity === 'error').length ?? Number.POSITIVE_INFINITY;
    if (errors < fewest) {
      best = f;
      fewest = errors;
    }
  }
  return best;
}

function legalityView(format: FormatId, r: ValidationResult): LegalityView {
  return { format, label: FORMAT_LABELS[format], legal: r.legal, mainCount: r.mainCount, sideCount: r.sideCount, issues: r.issues };
}

/** Small stable hash for memo keys (FNV-1a). */
function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export interface EngineOptions {
  /** Network fallback for misspelled names (Scryfall fuzzy search); only used when a request asks for it. */
  fuzzy?: FuzzyLookup;
  onPool?: (pool: Pool, cards: number) => void;
}

export class Engine {
  private readonly load: ShardLoader;
  private readonly opts: EngineOptions;
  private index: CardIndex | null = null;
  private pool: Pool | null = null;
  private loading: Promise<CardIndex> | null = null;
  private deckMemo = new Map<string, ResolvedDeck>();
  private metaMemo = new Map<string, MetaContext>();

  constructor(load: ShardLoader, opts: EngineOptions = {}) {
    this.load = load;
    this.opts = opts;
  }

  get currentPool(): Pool | null {
    return this.pool;
  }

  /** Load a pool (no-op when it, or the larger Arena pool, is already loaded). */
  async ensure(pool: Pool): Promise<CardIndex> {
    if (this.index && (this.pool === 'arena' || this.pool === pool)) return this.index;
    if (this.loading) {
      const idx = await this.loading;
      if (this.pool === 'arena' || this.pool === pool) return idx;
    }
    this.loading = (async () => {
      const shard = await this.load(pool);
      const idx = new CardIndex(shard.cards.map(hydrateCardRecord) as CardRecord[], shard.meta);
      this.index = idx;
      this.pool = pool;
      // Decks resolved against the smaller pool may now resolve differently.
      this.deckMemo.clear();
      this.metaMemo.clear();
      this.opts.onPool?.(pool, idx.records.length);
      return idx;
    })();
    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async init(pool: Pool = 'standard'): Promise<InitResult> {
    const idx = await this.ensure(pool);
    return { pool: this.pool ?? pool, cards: idx.records.length, snapshot: idx.meta.snapshot, asOf: asOfDate(idx), cached: false };
  }

  private async indexFor(format: FormatId | null): Promise<CardIndex> {
    return this.ensure(format && STANDARD_POOL_FORMATS.has(format) ? 'standard' : format ? 'arena' : (this.pool ?? 'standard'));
  }

  /**
   * Parse and resolve an Arena export. Unknown names against the Standard pool trigger the Arena
   * pool and a second pass; `fuzzy` then asks Scryfall about names still unknown.
   */
  async resolve(text: string, fuzzy = false): Promise<ResolvedDeck> {
    const key = `${this.pool}:${fuzzy ? 'f' : ''}:${hashText(text)}:${text.length}`;
    const hit = this.deckMemo.get(key);
    if (hit) return hit;
    let idx = await this.ensure(this.pool ?? 'standard');
    let deck = await resolveDeck(parseArenaText(text), idx);
    const unknown = () => deck.unresolved.some((i) => i.code === 'unknown_card');
    if (unknown() && this.pool !== 'arena') {
      idx = await this.ensure('arena');
      deck = await resolveDeck(parseArenaText(text), idx);
    }
    if (unknown() && fuzzy && this.opts.fuzzy) deck = await resolveDeck(parseArenaText(text), idx, this.opts.fuzzy);
    this.deckMemo.set(`${this.pool}:${fuzzy ? 'f' : ''}:${hashText(text)}:${text.length}`, deck);
    if (this.deckMemo.size > 24) this.deckMemo.delete(this.deckMemo.keys().next().value as string);
    return deck;
  }

  private async metaContext(sel: MetaSelection | null, idx: CardIndex): Promise<MetaContext | null> {
    if (!sel || sel.lists.length === 0) return null;
    const key = `${this.pool}:${hashText(JSON.stringify(sel.lists))}`;
    const hit = this.metaMemo.get(key);
    if (hit) return hit;
    const ctx = await buildMeta(sel.lists, idx);
    this.metaMemo.set(key, ctx);
    if (this.metaMemo.size > 8) this.metaMemo.delete(this.metaMemo.keys().next().value as string);
    return ctx;
  }

  private requireCards(deck: ResolvedDeck): void {
    if (count(deck.main) + (deck.commander ? 1 : 0) === 0) {
      throw new EngineError('empty_deck', deck.unresolved.length > 0 ? 'None of the lines matched a card on MTG Arena.' : 'Paste an Arena export with at least one card.');
    }
  }

  async analyze(req: Omit<AnalyzeRequest, 'type'>): Promise<AnalyzeResult> {
    // Non-Standard formats need the whole pool for meta lists and later upgrades.
    if (req.format && !STANDARD_POOL_FORMATS.has(req.format)) await this.ensure('arena');
    const deck = await this.resolve(req.text, req.fuzzy === true);
    this.requireCards(deck);
    const idx = this.index!;
    const legality = FORMAT_IDS.map((f) => legalityView(f, validateDeck(deck, getFormat(f))));
    const format = req.format ?? autoFormat(deck, legality);
    const fmt = getFormat(format);
    const meta = await this.metaContext(req.meta, idx);
    const asOf = asOfDate(idx);
    const analysis = analyzeDeck(deck, fmt);
    const rating = ratePower(deck, fmt, { asOf, ...(meta ? { meta } : {}) });
    const simulation = simulateHands(deck, { iterations: 10_000, seed: 1 });
    const cards: Record<string, CardView> = {};
    const all = [...(deck.commander ? [deck.commander] : []), ...(deck.companion ? [deck.companion] : []), ...deck.main, ...deck.side];
    for (const e of all) cards[e.oracleId] = cardView(e.card);

    let metaView: MetaCompareView | null = null;
    if (meta && req.meta) {
      const cmp = compareToMeta(deck, meta);
      const closest = cmp?.closest;
      const view: MetaCompareView = {
        label: req.meta.label,
        lists: meta.lists.length,
        closest: closest
          ? {
              name: closest.name,
              archetype: closest.archetype,
              overlapPercent: closest.overlapPercent,
              shareOfSuppliedListsPercent: closest.shareOfSuppliedListsPercent,
              ...(closest.winRate !== undefined ? { winRate: closest.winRate } : {}),
            }
          : null,
        ranking: cmp?.ranking ?? [],
        missingCore: cmp?.missingCore ?? [],
        unusual: cmp?.unusual ?? [],
        unresolved: meta.unresolved,
      };
      metaView = view;
      for (const m of view.missingCore) {
        const c = idx.lookup(m.name);
        if (c) cards[c.oracleId] = cardView(c);
      }
    }
    const power: PowerView = { ...rating, lowConfidence: rating.dimensions.some((d) => d.confidence === 'low') };
    return {
      name: deck.name ?? null,
      arenaText: toArenaText(deck),
      commander: deck.commander ? entryView(deck.commander) : null,
      companion: deck.companion ? entryView(deck.companion) : null,
      main: deck.main.map(entryView),
      side: deck.side.map(entryView),
      counts: { main: count(deck.main), side: count(deck.side) },
      issues: deck.unresolved,
      format,
      autoFormat: req.format === null,
      legality,
      analysis,
      power,
      wildcards: wildcardCost(deck),
      simulation,
      meta: metaView,
      cards,
      pool: this.pool ?? 'standard',
      asOf,
    };
  }

  async simulate(req: Omit<SimulateRequest, 'type'>) {
    const deck = await this.resolve(req.text);
    this.requireCards(deck);
    const o = req.options;
    const iterations = Math.max(100, Math.min(100_000, Math.round(o.iterations)));
    const checks = o.checks.filter((c) => (c.card ? !c.role : Boolean(c.role)) && c.byTurn >= 1 && c.byTurn <= 20);
    return simulateHands(deck, { iterations, seed: o.seed >>> 0, playDraw: o.playDraw, bo1Smoothing: o.bo1Smoothing, checks });
  }

  async hand(req: Omit<HandRequest, 'type'>): Promise<HandResult> {
    const deck = await this.resolve(req.text);
    this.requireCards(deck);
    if (count(deck.main) < 7) throw new EngineError('small_deck', 'A sample hand needs at least 7 cards in the main deck.');
    const h = dealSampleHand(deck, req.seed >>> 0);
    const ids: Record<string, string> = {};
    for (const e of deck.main) ids[e.name] = e.oracleId;
    return { ...h, ids };
  }

  async suggest(req: Omit<SuggestRequest, 'type'>): Promise<SuggestView> {
    const idx = await this.indexFor(req.format);
    const deck = await this.resolve(req.text);
    this.requireCards(deck);
    const fmt = getFormat(req.format);
    const meta = await this.metaContext(req.meta, this.index ?? idx);
    const result = suggestUpgrades(deck, fmt, this.index ?? idx, {
      mode: req.mode,
      intensity: req.intensity,
      maxSwaps: Math.max(1, Math.min(20, Math.round(req.maxSwaps))),
      keepCards: req.keepCards,
      asOf: asOfDate(this.index ?? idx),
      ...(req.wildcards ? { wildcards: req.wildcards } : {}),
      ...(meta ? { meta } : {}),
    });
    const cards: Record<string, CardView> = {};
    const pool = this.index ?? idx;
    for (const s of result.swaps) {
      for (const name of [s.cut, s.add]) {
        const c = pool.lookup(name);
        if (c) cards[c.oracleId] = cardView(c);
      }
    }
    return {
      swaps: result.swaps,
      totalCost: result.totalCost,
      budget: result.budget,
      remaining: result.remaining,
      changes: result.changes,
      notes: result.notes,
      appliedText: toArenaText(applySwaps(deck, result.swaps, pool)),
      cards,
    };
  }

  async search(req: Omit<SearchRequest, 'type'>): Promise<SearchResult> {
    // No format means every Arena card.
    await (req.format ? this.indexFor(req.format) : this.ensure('arena'));
    const idx = this.index!;
    const query = req.query.trim();
    if (!query) return { total: 0, cards: [], pool: this.pool ?? 'standard' };
    try {
      const r = searchCards(idx, query, { ...(req.format ? { format: req.format } : {}), order: req.order, limit: Math.max(1, Math.min(200, req.limit)) });
      return { total: r.total, cards: r.cards.map(cardView), pool: this.pool ?? 'standard' };
    } catch (err) {
      const details = (err as { details?: { reason?: string } }).details;
      return { total: 0, cards: [], pool: this.pool ?? 'standard', error: details?.reason ?? (err instanceof Error ? err.message : String(err)) };
    }
  }

  async checkLists(req: Omit<CheckListsRequest, 'type'>): Promise<ListCheck[]> {
    if (req.lists.some((l) => !STANDARD_POOL_FORMATS.has(l.format))) await this.ensure('arena');
    const out: ListCheck[] = [];
    for (const l of req.lists) {
      const deck = await this.resolve(l.list);
      const v = validateDeck(deck, getFormat(l.format));
      const colors = new Set<string>();
      for (const e of [...(deck.commander ? [deck.commander] : []), ...deck.main]) for (const c of e.card.colors) colors.add(c);
      const firstError = v.issues.find((i) => i.severity === 'error');
      out.push({
        main: count(deck.main) + (deck.commander ? 1 : 0),
        side: count(deck.side),
        legal: v.legal && deck.unresolved.length === 0,
        problem: deck.unresolved[0]?.reason ? `${deck.unresolved[0].text ?? ''} ${deck.unresolved[0].reason}`.trim() : (firstError?.message ?? null),
        issues: deck.unresolved,
        colors: (['W', 'U', 'B', 'R', 'G'] as const).filter((c) => colors.has(c)),
      });
    }
    return out;
  }
}

/** A copy of the deck with each swap applied to the main deck (cut qty copies, add qty copies). */
export function applySwaps(deck: ResolvedDeck, swaps: readonly { cut: string; add: string; qty: number }[], index: CardIndex): ResolvedDeck {
  const main = deck.main.map((e) => ({ ...e }));
  for (const s of swaps) {
    const cut = main.find((e) => e.name === s.cut);
    if (cut) cut.qty -= s.qty;
    const card = index.lookup(s.add);
    if (!card) continue;
    const existing = main.find((e) => e.oracleId === card.oracleId);
    if (existing) existing.qty += s.qty;
    else main.push({ qty: s.qty, name: card.name, oracleId: card.oracleId, card });
  }
  return { ...deck, main: main.filter((e) => e.qty > 0) };
}
