import { type Role, tagRoles } from '../data/roles.js';
import { analyzeDeck } from './analyze.js';
import {
  type CardIndex,
  castingMv,
  isBasicLand,
  isCreature,
  isLand,
  normalizeName,
  rulesText,
  wildcardRarity,
} from './cards.js';
import { playEntries, type ResolvedDeck, type ResolvedEntry } from './deck.js';
import type { FormatRules } from './formats.js';
import type { MetaContext } from './meta.js';
import { heuristicQuality } from './power.js';
import { brawlRubric, constructedRubric } from './rubric.js';
import { type CardRecord, type Color, COLORS, type Rarity } from './types.js';
import { ARENA_MAX_COPIES, type WildcardCounts, zeroWildcards } from './wildcards.js';

export type Mode = 'casual' | 'competitive';

export interface SuggestOptions {
  mode: Mode;
  /** Per-rarity budget; a rarity left out is unlimited. Omit entirely for no budget. */
  wildcards?: Partial<WildcardCounts>;
  maxSwaps?: number;
  keepCards?: string[];
  meta?: MetaContext;
  asOf: string;
}

export interface Swap {
  cut: string;
  add: string;
  qty: number;
  reason: string;
  wildcardCost: Partial<WildcardCounts>;
}

export interface SuggestResult {
  mode: Mode;
  swaps: Swap[];
  totalCost: WildcardCounts;
  budget: Partial<WildcardCounts> | null;
  remaining: Partial<WildcardCounts> | null;
  notes: string[];
}

/** Relative wildcard scarcity, for "value per wildcard" and the casual cost penalty. */
const SCARCITY: Record<Rarity, number> = { common: 0.25, uncommon: 0.5, rare: 1, mythic: 2 };
const CASUAL_COST_PENALTY: Record<Rarity, number> = { common: 0, uncommon: 0.04, rare: 0.12, mythic: 0.2 };

const CANDIDATES_PER_CUT = 3;

interface Scored {
  card: CardRecord;
  value: number;
  quality: number;
  metaRate: number;
}

export function suggestUpgrades(deck: ResolvedDeck, fmt: FormatRules, index: CardIndex, opts: SuggestOptions): SuggestResult {
  const maxSwaps = opts.maxSwaps ?? 5;
  const keep = new Set((opts.keepCards ?? []).map(normalizeName));
  const analysis = analyzeDeck(deck, fmt);
  const heuristics = fmt.commander ? brawlRubric().cardQuality.heuristic : constructedRubric().cardQuality.heuristic;
  const meta = opts.meta?.lists.length ? opts.meta : undefined;
  const notes: string[] = [];
  if (!meta) notes.push('No meta lists supplied: card strength is estimated from popularity, rarity and age.');

  const metaRate = (c: CardRecord) => (meta ? (meta.playRate.get(c.oracleId) ?? 0) / (meta.maxNonlandRate || 1) : 0);
  const score = (c: CardRecord): Scored => {
    const quality = heuristicQuality(c, heuristics, opts.asOf);
    const rate = metaRate(c);
    let value: number;
    if (opts.mode === 'competitive') value = meta ? 0.6 * rate + 0.4 * quality : quality;
    else value = (meta ? 0.15 * rate + 0.85 * quality : quality) - CASUAL_COST_PENALTY[wildcardRarity(c)];
    return { card: c, value, quality, metaRate: rate };
  };

  const identity = deckIdentity(deck, analysis.colors.sources);
  const inDeck = new Set(playEntries(deck).map((e) => e.oracleId));
  const curveTarget =
    analysis.archetype === 'brawl' ? 3.5 : constructedRubric().archetypes[analysis.archetype].avgMv;

  // 1. Cut candidates.
  const roleCounts = analysis.roles.counts;
  const cuts = deck.main
    .filter((e) => !isLand(e.card) && !isBasicLand(e.card) && !keep.has(normalizeName(e.name)) && !keep.has(normalizeName(e.card.faces[0]?.name ?? '')))
    .map((e) => {
      const s = score(e.card);
      const roles = tagRoles(e.card).map((t) => t.role);
      const redundancy = roles.length ? Math.min(...roles.map((r) => roleCounts[r])) / 12 : 0.5;
      const mvOver = Math.max(0, castingMv(e.card) - (curveTarget + 1.5)) * 0.15;
      const absent = meta && s.metaRate === 0 ? 0.3 : 0;
      return { e, s, roles, cutScore: (1 - s.value) + 0.2 * Math.min(1, redundancy) + mvOver + absent };
    })
    .sort((a, b) => b.cutScore - a.cutScore || cmp(a.e.name, b.e.name))
    .slice(0, Math.max(maxSwaps * 2, 6));

  // 2. Add candidates for each cut, scored by gain over the card they replace.
  const pool = index.records.filter(
    (c) =>
      c.onArena &&
      !inDeck.has(c.oracleId) &&
      !isLand(c) &&
      (c.legalities[fmt.legalityKey] === 'legal' || c.legalities[fmt.legalityKey] === 'restricted') &&
      c.colorIdentity.every((col) => identity.has(col)),
  );
  interface Option {
    cut: (typeof cuts)[number];
    add: Scored;
    shared: Role[];
    gain: number;
    qty: number;
    rarity: Rarity;
  }
  const options: Option[] = [];
  for (const cut of cuts) {
    const mv = castingMv(cut.e.card);
    const creature = isCreature(cut.e.card);
    // Aggro burn doubles as reach; don't trade it for removal that can't hit players.
    const needsReach = analysis.archetype === 'aggro' && hasReach(cut.e.card);
    const found: Option[] = [];
    for (const c of pool) {
      if (Math.abs(castingMv(c) - mv) > 1 || isCreature(c) !== creature) continue;
      if (needsReach && !hasReach(c)) continue;
      const roles = tagRoles(c).map((t) => t.role);
      const shared = cut.roles.filter((r) => roles.includes(r));
      if (cut.roles.length && shared.length === 0) continue;
      const add = score(c);
      const roleFit = cut.roles.length ? shared.length / cut.roles.length : 0.5;
      const gain = add.value - cut.s.value + (opts.mode === 'casual' ? 0.1 * roleFit : 0.05 * roleFit);
      if (gain <= 0.02) continue;
      const qty = fmt.maxCopies === 1 ? 1 : Math.min(cut.e.qty, ARENA_MAX_COPIES);
      found.push({ cut, add, shared, gain, qty, rarity: wildcardRarity(c) });
    }
    found.sort((a, b) => b.gain - a.gain || cmp(a.add.card.name, b.add.card.name));
    options.push(...found.slice(0, CANDIDATES_PER_CUT));
  }

  // 3. Greedy best value per wildcard, never exceeding the budget.
  const budget = opts.wildcards ?? null;
  const remaining: Partial<WildcardCounts> | null = budget ? { ...budget } : null;
  const perWildcard = (o: Option) => o.gain / (SCARCITY[o.rarity] * o.qty);
  options.sort(
    (a, b) => perWildcard(b) - perWildcard(a) || b.gain - a.gain || cmp(a.cut.e.name, b.cut.e.name) || cmp(a.add.card.name, b.add.card.name),
  );
  const usedCuts = new Set<string>();
  const usedAdds = new Set<string>();
  const totalCost = zeroWildcards();
  const swaps: Swap[] = [];
  let skippedForBudget = 0;
  for (const o of options) {
    if (swaps.length >= maxSwaps) break;
    if (usedCuts.has(o.cut.e.oracleId) || usedAdds.has(o.add.card.oracleId)) continue;
    const left = remaining?.[o.rarity];
    if (left !== undefined && left < o.qty) {
      skippedForBudget++;
      continue;
    }
    if (remaining && left !== undefined) remaining[o.rarity] = left - o.qty;
    usedCuts.add(o.cut.e.oracleId);
    usedAdds.add(o.add.card.oracleId);
    totalCost[o.rarity] += o.qty;
    swaps.push({
      cut: o.cut.e.name,
      add: o.add.card.name,
      qty: o.qty,
      reason: reasonFor(o.cut.e, o.add, o.shared, meta),
      wildcardCost: { [o.rarity]: o.qty },
    });
  }
  if (skippedForBudget) notes.push(`${skippedForBudget} otherwise-good swap(s) didn't fit the wildcard budget.`);
  if (!swaps.length) notes.push('No swap clearly improves the deck under these constraints.');
  return { mode: opts.mode, swaps, totalCost, budget, remaining, notes };
}

/** Can it damage a player directly? */
export function hasReach(c: CardRecord): boolean {
  return /damage to (?:any target|each opponent|target player|target opponent|any other target)/.test(rulesText(c));
}

/**
 * Colors an add may use: the commander's identity in Brawl; otherwise colors that are a
 * real part of the deck (at least 15% of colored spell copies, or 8+ land sources), so a
 * two-card splash doesn't open up a whole new color.
 */
export function deckIdentity(deck: ResolvedDeck, sources: Record<Color, number>): Set<Color> {
  if (deck.commander) return new Set(deck.commander.card.colorIdentity);
  const copies: Record<Color, number> = { W: 0, U: 0, B: 0, R: 0, G: 0 };
  let total = 0;
  for (const e of playEntries(deck)) {
    if (isLand(e.card) || !e.card.colorIdentity.length) continue;
    total += e.qty;
    for (const c of e.card.colorIdentity) copies[c] += e.qty;
  }
  return new Set(COLORS.filter((c) => (total && copies[c] / total >= 0.15) || sources[c] >= 8));
}

const ROLE_WORDS: Record<Role, string> = {
  removal: 'removal',
  counterspell: 'counterspell',
  sweeper: 'sweeper',
  card_draw: 'card draw',
  ramp: 'ramp',
  tutor: 'tutor',
  threat: 'threat',
  protection: 'protection',
  lifegain: 'lifegain',
};

function reasonFor(cut: ResolvedEntry, add: Scored, shared: Role[], meta: MetaContext | undefined): string {
  const role = shared.length ? `fills the same ${shared.map((r) => ROLE_WORDS[r]).join('/')} role` : 'fills a similar slot';
  const cutMv = castingMv(cut.card);
  const addMv = castingMv(add.card);
  const mv = addMv < cutMv ? ` for ${cutMv - addMv} less mana` : addMv > cutMv ? ` at ${addMv - cutMv} more mana` : ' at the same mana value';
  let why: string;
  if (meta && add.metaRate > 0) {
    const n = meta.lists.filter((l) => l.main.has(add.card.oracleId)).length;
    why = `and appears in ${n} of ${meta.lists.length} meta lists`;
  } else {
    why = add.card.edhrecRank !== null ? 'and is a more widely played card' : 'and is a stronger card by rarity and age';
  }
  return `${add.card.name} ${role}${mv}, ${why}.`;
}

function cmp(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
