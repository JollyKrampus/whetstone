import { type Role, tagRoles } from './roles.js';
import { analyzeDeck, landColors, tappedKind } from './analyze.js';
import {
  type CardIndex,
  castingMv,
  frontTypeLine,
  isBasicLand,
  isCreature,
  isLand,
  normalizeName,
  pipsOf,
  castingCost,
  printedCopyLimit,
  rulesText,
  wildcardRarity,
} from './cards.js';
import { countCards, playEntries, type ResolvedDeck, type ResolvedEntry } from './deck.js';
import type { FormatRules } from './formats.js';
import type { MetaContext } from './meta.js';
import { heuristicQuality } from './power.js';
import { brawlRubric, constructedRubric } from './rubric.js';
import { describeRecommendation, recommendationScore, type RecommendationList } from './recs.js';
import { saltOf } from './salt.js';
import { companionRule, companionViolations } from './companions.js';
import { commanderThemes } from './themes.js';
import { type CardRecord, type Color, COLORS, type Rarity } from './types.js';
import { validateDeck } from './validate.js';
import { ARENA_MAX_COPIES, type WildcardCounts, zeroWildcards } from './wildcards.js';

export type Mode = 'casual' | 'competitive';
export type Intensity = 'light' | 'normal' | 'heavy';
export type Profile = 'faithful' | 'competitive' | 'casual';

/**
 * Keeps the deck recognizable: at most `percent` of its cards change, and cuts come only
 * from the weakest `cutPool` share of its nonland cards.
 */
export const INTENSITY: Record<Intensity, { percent: number; cutPool: number }> = {
  light: { percent: 7, cutPool: 0.25 },
  normal: { percent: 15, cutPool: 0.5 },
  heavy: { percent: 30, cutPool: 1 },
};

/**
 * The three deck versions:
 *  - faithful: the same deck, playing the best available version of each card. Same roles,
 *    same card types, same or lower mana value, same tribes; tapped or off-color lands get
 *    untapped replacements.
 *  - competitive: as strong as possible, changing as much as needed (meta-weighted, no cap,
 *    land base upgrades included).
 *  - casual: friendly to a casual table. Cards in rubric/salt.json's "avoid" list (Game
 *    Changers, extra turns, land destruction, lock pieces, mass discard) are swapped out and
 *    never suggested; "penalize" cards are scored down.
 */
export const PROFILES: Record<
  Profile,
  { mode: Mode; percent: number; cutPool: number; maxSwaps: number; strict: boolean; lands: 'fix' | 'all'; salt: boolean; minGain: number }
> = {
  faithful: { mode: 'competitive', percent: 25, cutPool: 1, maxSwaps: 15, strict: true, lands: 'fix', salt: false, minGain: 0.05 },
  competitive: { mode: 'competitive', percent: 100, cutPool: 1, maxSwaps: 40, strict: false, lands: 'all', salt: false, minGain: 0.02 },
  casual: { mode: 'casual', percent: 15, cutPool: 0.5, maxSwaps: 10, strict: false, lands: 'fix', salt: true, minGain: 0.02 },
};

export interface SuggestOptions {
  /** Scoring mode; defaults to the profile's, else competitive. */
  mode?: Mode;
  /** One of the three deck versions; sets mode, change cap, matching rules and land upgrades. */
  profile?: Profile;
  /** Lean toward mythics and rares (and pricier cards among equals) whenever there's a choice. */
  preferPremium?: boolean;
  /** Per-rarity budget; a rarity left out is unlimited. Omit entirely for no budget. */
  wildcards?: Partial<WildcardCounts>;
  maxSwaps?: number;
  /** How much of the deck may change: light (~7%), normal (~15%, default), heavy (~30%). */
  intensity?: Intensity;
  /** Overrides the cap on changed cards, as a percent of the deck. */
  maxChangePercent?: number;
  keepCards?: string[];
  /** Pasted commander recommendations (e.g. from EDHREC); adds lean toward them. */
  recommendations?: RecommendationList;
  meta?: MetaContext;
  asOf: string;
}

export interface Swap {
  cut: string;
  add: string;
  qty: number;
  kind: 'spell' | 'land';
  /** True when the cut card has to go (banned, off-Arena, breaks the companion, or feel-bad in casual). */
  required: boolean;
  reason: string;
  wildcardCost: Partial<WildcardCounts>;
  cutOracleId: string;
  addOracleId: string;
}

export interface SuggestResult {
  mode: Mode;
  profile: Profile | null;
  preferPremium: boolean;
  swaps: Swap[];
  totalCost: WildcardCounts;
  budget: Partial<WildcardCounts> | null;
  remaining: Partial<WildcardCounts> | null;
  /** Cards changed versus the cap that keeps the deck recognizable. */
  changes: { cards: number; limit: number; deckSize: number; intensity: Intensity | Profile };
  /** In Brawl, what every added card had to support. */
  commanderThemes: { commander: string; themes: string[]; tribes: string[] } | null;
  /** Swaps dropped because the resulting deck would break a rule validate_deck checks. */
  rejectedByRules: { count: number; examples: string[] };
  notes: string[];
}

/** Relative wildcard scarcity, for "value per wildcard" and the casual cost penalty. */
const SCARCITY: Record<Rarity, number> = { common: 0.25, uncommon: 0.5, rare: 1, mythic: 2 };
const CASUAL_COST_PENALTY: Record<Rarity, number> = { common: 0, uncommon: 0.04, rare: 0.12, mythic: 0.2 };
const PREMIUM_BONUS: Record<Rarity, number> = { common: 0, uncommon: 0.03, rare: 0.08, mythic: 0.12 };

const CANDIDATES_PER_CUT = 3;
const MAIN_TYPES = ['Creature', 'Planeswalker', 'Battle', 'Artifact', 'Enchantment', 'Instant', 'Sorcery'];

interface Scored {
  card: CardRecord;
  value: number;
  quality: number;
  metaRate: number;
  /** recommendationScore, 0 when off the pasted list (or there is none). */
  rec: number;
}

interface Cut {
  e: ResolvedEntry;
  s: Scored;
  roles: Role[];
  cutScore: number;
  /** Casual profile: feel-bad reasons the card has to go regardless of gain. */
  salt: string[];
  /** Why the card can't stay in this format at all (banned, not legal, not on Arena). */
  illegal: string[];
}

const isForced = (c: Cut) => c.salt.length > 0 || c.illegal.length > 0;

/** Primary roles define a card's job; secondary ones (draw, lifegain, protection) are bonuses. */
const PRIMARY_ROLES: Role[] = ['removal', 'counterspell', 'sweeper', 'ramp', 'tutor', 'threat'];

interface Option {
  cut: Cut;
  add: Scored;
  kind: 'spell' | 'land';
  shared: Role[];
  themeHits: string[];
  gain: number;
  qty: number;
  rarity: Rarity;
  forced: boolean;
  landNote?: string;
}

export function suggestUpgrades(deck: ResolvedDeck, fmt: FormatRules, index: CardIndex, opts: SuggestOptions): SuggestResult {
  const profile = opts.profile ? PROFILES[opts.profile] : null;
  const mode: Mode = opts.mode ?? profile?.mode ?? 'competitive';
  const premium = Boolean(opts.preferPremium);
  const maxSwaps = opts.maxSwaps ?? profile?.maxSwaps ?? 5;
  const keep = new Set((opts.keepCards ?? []).map(normalizeName));
  const kept = (e: ResolvedEntry) => keep.has(normalizeName(e.name)) || keep.has(normalizeName(e.card.faces[0]?.name ?? ''));
  const analysis = analyzeDeck(deck, fmt);
  const heuristics = fmt.commander ? brawlRubric().cardQuality.heuristic : constructedRubric().cardQuality.heuristic;
  const meta = opts.meta?.lists.length ? opts.meta : undefined;
  const notes: string[] = [];
  if (!meta) notes.push('No meta lists supplied: card strength is estimated from popularity, rarity and age.');

  const recs = opts.recommendations?.cards.size ? opts.recommendations : undefined;
  const metaRate = (c: CardRecord) => (meta ? (meta.playRate.get(c.oracleId) ?? 0) / (meta.maxNonlandRate || 1) : 0);
  const score = (c: CardRecord): Scored => {
    const quality = heuristicQuality(c, heuristics, opts.asOf);
    const rate = metaRate(c);
    const rarity = wildcardRarity(c);
    let value: number;
    if (mode === 'competitive') value = meta ? 0.6 * rate + 0.4 * quality : quality;
    else value = (meta ? 0.15 * rate + 0.85 * quality : quality) - (premium ? 0 : CASUAL_COST_PENALTY[rarity]);
    const rec = recs ? recommendationScore(recs, c) : 0;
    // A pasted recommendation list is the user's own signal for this deck: weigh it as much as everything else.
    if (recs) value = 0.5 * value + 0.5 * rec;
    if (premium) value += PREMIUM_BONUS[rarity];
    if (profile?.salt) value -= saltOf(c).penalty;
    return { card: c, value, quality, metaRate: rate, rec };
  };

  const identity = deckIdentity(deck, analysis.colors.sources);
  const inDeck = new Set(playEntries(deck).map((e) => e.oracleId));
  const intensity = opts.intensity ?? 'normal';
  const deckSize = countCards(playEntries(deck));
  const capPercent = opts.maxChangePercent ?? profile?.percent ?? INTENSITY[intensity].percent;
  const cutPool = profile?.cutPool ?? INTENSITY[intensity].cutPool;
  const changeLimit = Math.max(1, Math.floor((capPercent / 100) * deckSize));
  // Brawl: every add must support what the commander builds around.
  const themes = fmt.commander ? commanderThemes(deck, brawlRubric().commanderSynergy.themes) : null;
  if (fmt.commander && deck.commander && !themes) {
    notes.push(`No clear theme found in ${deck.commander.name}'s text, so adds aren't limited to a theme.`);
  }
  const curveTarget =
    analysis.archetype === 'brawl' ? 3.5 : constructedRubric().archetypes[analysis.archetype].avgMv;
  const tribes = deckTribes(deck, themes?.tribes ?? []);

  // 1. Cut candidates. Cards that make the deck illegal (banned, off-Arena, breaking the
  // companion's condition) must go in every version.
  const companionBreakers = new Set(companionViolations(deck, fmt)?.cards ?? []);
  // Card-level companion conditions (Lurrus, Obosh, Keruga, …) checked on the card alone,
  // so candidates that could never fit don't crowd out ones that can.
  const companionRuleFor = deck.companion ? companionRule(deck.companion.card) : undefined;
  const companionAllows = (c: CardRecord) =>
    !companionRuleFor ||
    companionRuleFor.name.startsWith('Yorion') ||
    !companionRuleFor.violations({ main: [{ qty: 1, name: c.name, oracleId: c.oracleId, card: c }], side: [], unresolved: [] }, fmt).includes(c.name);
  const roleCounts = analysis.roles.counts;
  const rankedCuts: Cut[] = deck.main
    .filter((e) => !isLand(e.card) && !isBasicLand(e.card) && !kept(e))
    .map((e) => {
      const s = score(e.card);
      const roles = tagRoles(e.card).map((t) => t.role);
      const redundancy = roles.length ? Math.min(...roles.map((r) => roleCounts[r])) / 12 : 0.5;
      const mvOver = Math.max(0, castingMv(e.card) - (curveTarget + 1.5)) * 0.15;
      const absent = meta && s.metaRate === 0 ? 0.3 : 0;
      const onList = s.rec > 0;
      const offTheme = themes && !themes.matches(e.card).length && !onList ? 0.3 : 0;
      const recShift = recs ? (onList ? -0.3 : 0.2) : 0;
      const salt = profile?.salt ? saltOf(e.card).avoid : [];
      const illegal = illegalReasons(e.card, fmt);
      if (companionBreakers.has(e.name)) illegal.push(`against ${deck.companion!.name}'s deckbuilding condition`);
      return {
        e,
        s,
        roles,
        salt,
        illegal,
        cutScore:
          (1 - s.value) + 0.2 * Math.min(1, redundancy) + mvOver + absent + offTheme + recShift + (salt.length || illegal.length ? 5 : 0),
      };
    })
    .sort((a, b) => b.cutScore - a.cutScore || cmp(a.e.name, b.e.name));
  const nonlandEntries = deck.main.filter((e) => !isLand(e.card)).length;
  const mustGo = rankedCuts.filter(isForced);
  const cuts = [
    ...mustGo,
    ...rankedCuts
      .filter((c) => !isForced(c))
      .slice(0, Math.min(Math.max(maxSwaps * 2, 6), Math.ceil(cutPool * nonlandEntries))),
  ];

  // 2. Add candidates for each cut, scored by gain over the card they replace.
  const pool = index.records.filter(
    (c) =>
      c.onArena &&
      !inDeck.has(c.oracleId) &&
      !isLand(c) &&
      (c.legalities[fmt.legalityKey] === 'legal' || c.legalities[fmt.legalityKey] === 'restricted') &&
      c.colorIdentity.every((col) => identity.has(col)) &&
      !(profile?.salt && saltOf(c).avoid.length) &&
      companionAllows(c),
  );
  const options: Option[] = [];
  for (const cut of cuts) {
    const mv = castingMv(cut.e.card);
    const creature = isCreature(cut.e.card);
    // Aggro burn doubles as reach; don't trade it for removal that can't hit players.
    const needsReach = analysis.archetype === 'aggro' && hasReach(cut.e.card);
    const forced = isForced(cut);
    const strict = Boolean(profile?.strict) && !forced;
    // "Same deck" leaves cards alone when it can't tell what job they do.
    if (strict && !cut.roles.length) continue;
    const found: Option[] = [];
    for (const c of pool) {
      const addMv = castingMv(c);
      if (isCreature(c) !== creature) continue;
      if (strict ? addMv > mv || addMv < mv - 1 : Math.abs(addMv - mv) > (forced ? 2 : 1)) continue;
      if (needsReach && !hasReach(c)) continue;
      const themeHits = themes ? themes.matches(c) : [];
      // Recommended cards count as on-plan even when the theme regexes miss them.
      if (themes && !themeHits.length && !(recs && recs.cards.has(c.oracleId))) continue;
      const roles = tagRoles(c).map((t) => t.role);
      const shared = cut.roles.filter((r) => roles.includes(r));
      if (cut.roles.length && shared.length === 0) continue;
      // A card with no recognizable role is replaced only by a card of the same type.
      if (!cut.roles.length && !mainTypes(c).some((t) => mainTypes(cut.e.card).includes(t))) continue;
      if (strict && !sameJob(cut, c, roles, tribes)) continue;
      const add = score(c);
      const roleFit = cut.roles.length ? shared.length / cut.roles.length : 0.5;
      // "Same deck, best cards": doing the same job for less mana is the point of the upgrade.
      const cheaper = strict ? 0.08 * (mv - addMv) : 0;
      const gain = add.value - cut.s.value + (mode === 'casual' ? 0.1 * roleFit : 0.05 * roleFit) + cheaper;
      // Feel-bad cards go even when the replacement isn't stronger.
      if (!forced && gain <= (profile?.minGain ?? 0.02)) continue;
      const qty = copiesToAdd(cut.e, c, fmt, deck);
      if (qty < 1) continue;
      found.push({ cut, add, kind: 'spell', shared, themeHits, gain: forced ? Math.max(gain, 0) + 1 : gain, qty, rarity: wildcardRarity(c), forced });
    }
    found.sort((a, b) => b.gain - a.gain || tiebreak(a.add.card, b.add.card, premium));
    options.push(...found.slice(0, forced ? CANDIDATES_PER_CUT * 3 : CANDIDATES_PER_CUT));
    if (forced && !found.length) {
      const why = [...cut.illegal, ...cut.salt].join(', ');
      notes.push(`${cut.e.name} (${why}) has no replacement in the same role; consider cutting it by hand.`);
    }
  }
  if (profile) options.push(...landOptions(deck, fmt, index, identity, profile.lands, kept, score));

  // 3. Greedy selection: forced (feel-bad) cuts first, then best value per wildcard (or plain
  // best value when preferring premium cards), never exceeding the budget or breaking a rule.
  const budget = opts.wildcards ?? null;
  const remaining: Partial<WildcardCounts> | null = budget ? { ...budget } : null;
  const perWildcard = (o: Option) => (premium ? o.gain : o.gain / (SCARCITY[o.rarity] * o.qty));
  options.sort(
    (a, b) =>
      Number(b.forced) - Number(a.forced) ||
      perWildcard(b) - perWildcard(a) ||
      b.gain - a.gain ||
      cmp(a.cut.e.name, b.cut.e.name) ||
      tiebreak(a.add.card, b.add.card, premium),
  );
  const usedCuts = new Set<string>();
  const usedAdds = new Set<string>();
  const totalCost = zeroWildcards();
  const swaps: Swap[] = [];
  const baseline = errorKeys(deck, fmt);
  let working = deck;
  const rejected: string[] = [];
  let skippedForBudget = 0;
  let skippedForCap = 0;
  let changed = 0;
  for (const o of options) {
    if (swaps.length >= maxSwaps && !o.forced) break;
    if (usedCuts.has(o.cut.e.oracleId) || usedAdds.has(o.add.card.oracleId)) continue;
    if (!o.forced && changed + o.qty > changeLimit) {
      skippedForCap++;
      continue;
    }
    const left = remaining?.[o.rarity];
    if (left !== undefined && left < o.qty) {
      skippedForBudget++;
      continue;
    }
    const next = applySwap(working, o.cut.e.oracleId, o.add.card, o.qty);
    const broken = [...errorKeys(next, fmt)].filter(([k]) => !baseline.has(k));
    if (broken.length) {
      const [key, message] = broken[0]!;
      const card = key.split(':')[1];
      rejected.push(`${o.cut.e.name} → ${o.add.card.name}: ${card ? `${card} ` : ''}${message}`);
      continue;
    }
    working = next;
    if (remaining && left !== undefined) remaining[o.rarity] = left - o.qty;
    usedCuts.add(o.cut.e.oracleId);
    usedAdds.add(o.add.card.oracleId);
    totalCost[o.rarity] += o.qty;
    changed += o.qty;
    swaps.push({
      cut: o.cut.e.name,
      add: o.add.card.name,
      qty: o.qty,
      kind: o.kind,
      required: o.forced,
      reason:
        o.kind === 'land'
          ? `${o.add.card.name} ${o.landNote}.`
          : reasonFor(
              o.cut,
              o.add,
              o.shared,
              meta,
              themes ? { commander: themes.commander, hits: o.themeHits } : null,
              recs ? describeRecommendation(recs, o.add.card) : null,
            ),
      wildcardCost: { [o.rarity]: o.qty },
      cutOracleId: o.cut.e.oracleId,
      addOracleId: o.add.card.oracleId,
    });
  }
  if (skippedForBudget) notes.push(`${skippedForBudget} otherwise-good swap(s) didn't fit the wildcard budget.`);
  if (skippedForCap) {
    notes.push(
      `Stopped at ${changed} of ${deckSize} cards changed to keep the deck recognizable (limit ${changeLimit}); raise intensity or maxChangePercent for more.`,
    );
  }
  if (!swaps.length) notes.push('No swap clearly improves the deck under these constraints.');
  return {
    mode,
    profile: opts.profile ?? null,
    preferPremium: premium,
    swaps,
    totalCost,
    budget,
    remaining,
    changes: { cards: changed, limit: changeLimit, deckSize, intensity: opts.profile ?? intensity },
    commanderThemes: themes ? { commander: themes.commander, themes: themes.themes, tribes: themes.tribes } : null,
    rejectedByRules: { count: rejected.length, examples: rejected.slice(0, 5) },
    notes,
  };
}

// ---- matching helpers -------------------------------------------------------------------

function mainTypes(c: CardRecord): string[] {
  const t = frontTypeLine(c);
  return MAIN_TYPES.filter((x) => new RegExp(`\\b${x}\\b`).test(t));
}

function subtypes(c: CardRecord): string[] {
  return (frontTypeLine(c).split('—')[1] ?? '').trim().split(/\s+/).filter(Boolean);
}

/** Creature types the deck is built around: the commander's, or any with 8+ copies. */
function deckTribes(deck: ResolvedDeck, commanderTribes: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const e of playEntries(deck)) {
    if (!isCreature(e.card)) continue;
    for (const t of subtypes(e.card)) counts.set(t, (counts.get(t) ?? 0) + e.qty);
  }
  const threshold = Math.max(8, Math.round(countCards(playEntries(deck)) * 0.13));
  return new Set([...commanderTribes, ...[...counts].filter(([, n]) => n >= threshold).map(([t]) => t)]);
}

/**
 * Faithful profile: the add must do the same job. It keeps every role the cut has and adds
 * no new primary role, keeps the same card types (an instant may replace a sorcery), stays
 * in the cut's colors, keeps any tribe the deck is built around, and has no heavier colored
 * mana cost.
 */
function sameJob(cut: Cut, add: CardRecord, addRoles: Role[], tribes: Set<string>): boolean {
  if (!cut.roles.every((r) => addRoles.includes(r))) return false;
  if (addRoles.some((r) => PRIMARY_ROLES.includes(r) && !cut.roles.includes(r))) return false;
  if (cut.e.card.colors.length && !add.colors.every((c) => cut.e.card.colors.includes(c))) return false;
  const want = mainTypes(cut.e.card).map((t) => (t === 'Sorcery' ? 'Instant|Sorcery' : t));
  const have = mainTypes(add);
  if (!want.every((t) => t.split('|').some((x) => have.includes(x)))) return false;
  if (have.some((t) => !want.some((w) => w.split('|').includes(t)))) return false;
  const cutTribes = subtypes(cut.e.card).filter((t) => tribes.has(t));
  if (cutTribes.length && !cutTribes.some((t) => subtypes(add).includes(t))) return false;
  const pips = (c: CardRecord) => Object.values(pipsOf(castingCost(c)).hard).reduce((a, b) => a + b, 0);
  return pips(add) <= pips(cut.e.card) + 1;
}

/** Copies to add: as many as were cut, within the format's limit counting the sideboard. */
function copiesToAdd(cut: ResolvedEntry, add: CardRecord, fmt: FormatRules, deck: ResolvedDeck): number {
  const restricted = add.legalities[fmt.legalityKey] === 'restricted';
  const printed = printedCopyLimit(add);
  const limit = restricted ? 1 : Math.min(printed ?? fmt.maxCopies, fmt.maxCopies === 1 ? 1 : ARENA_MAX_COPIES);
  const elsewhere = deck.side.filter((e) => e.oracleId === add.oracleId).reduce((n, e) => n + e.qty, 0);
  return Math.min(cut.qty, limit - elsewhere);
}

function tiebreak(a: CardRecord, b: CardRecord, premium: boolean): number {
  if (premium) {
    const r = ['common', 'uncommon', 'rare', 'mythic'];
    const byRarity = r.indexOf(wildcardRarity(b)) - r.indexOf(wildcardRarity(a));
    if (byRarity) return byRarity;
    const byPrice = (b.priceUsd ?? 0) - (a.priceUsd ?? 0);
    if (byPrice) return byPrice;
  }
  return cmp(a.name, b.name);
}

// ---- lands ------------------------------------------------------------------------------

/**
 * Land upgrades. 'fix' replaces lands that always enter tapped or make none of the deck's
 * colors; 'all' also turns basics into untapped duals in multicolor decks.
 */
function landOptions(
  deck: ResolvedDeck,
  fmt: FormatRules,
  index: CardIndex,
  identity: Set<Color>,
  level: 'fix' | 'all',
  kept: (e: ResolvedEntry) => boolean,
  score: (c: CardRecord) => Scored,
): Option[] {
  const colors = COLORS.filter((c) => identity.has(c));
  if (!colors.length) return [];
  const basicColors = new Set<Color>(colors);
  const inDeck = new Set(playEntries(deck).map((e) => e.oracleId));
  const makes = (c: CardRecord) => landColors(c, basicColors).filter((col) => identity.has(col));
  const landValue = (c: CardRecord) => {
    const kind = tappedKind(c);
    const tempo = kind === 'unconditional' ? 0 : kind === 'conditional' ? 0.75 : 1;
    const quality = isBasicLand(c) ? 0.5 : score(c).quality;
    return 0.4 * (makes(c).length / colors.length) + 0.35 * tempo + 0.25 * quality;
  };

  const cuts = deck.main.filter((e) => {
    if (!isLand(e.card) || kept(e)) return false;
    const offColor = e.card.producedMana.some((m) => m !== 'C') && makes(e.card).length === 0 && !/search your library/i.test(e.card.oracleText);
    if (offColor || tappedKind(e.card) === 'unconditional') return true;
    return level === 'all' && colors.length >= 2 && isBasicLand(e.card);
  });
  if (!cuts.length) return [];

  const adds: CardRecord[] = index.records.filter(
    (c) =>
      isLand(c) &&
      c.onArena &&
      (!inDeck.has(c.oracleId) || isBasicLand(c)) &&
      (c.legalities[fmt.legalityKey] === 'legal' || c.legalities[fmt.legalityKey] === 'restricted') &&
      c.colorIdentity.every((col) => identity.has(col)) &&
      tappedKind(c) !== 'unconditional' &&
      (isBasicLand(c) ? colors.length === 1 && makes(c).length === 1 && /^(Plains|Island|Swamp|Mountain|Forest)$/.test(c.name) : makes(c).length >= Math.min(2, colors.length)),
  );

  const out: Option[] = [];
  for (const e of cuts) {
    const before = landValue(e.card);
    const cut: Cut = { e, s: score(e.card), roles: [], cutScore: 0, salt: [], illegal: [] };
    const scored = adds
      .map((c) => ({ c, gain: landValue(c) - before }))
      .filter((x) => x.gain >= 0.05)
      .sort((a, b) => b.gain - a.gain || cmp(a.c.name, b.c.name))
      .slice(0, CANDIDATES_PER_CUT);
    for (const { c, gain } of scored) {
      const qty = isBasicLand(c) ? e.qty : copiesToAdd(e, c, fmt, deck);
      if (qty < 1) continue;
      const kind = tappedKind(e.card);
      const why =
        makes(e.card).length === 0
          ? 'makes none of this deck’s colors'
          : kind === 'unconditional'
            ? 'always enters tapped'
            : 'only makes one color';
      const madeBy = makes(c).map((m) => `{${m}}`).join('');
      out.push({
        cut,
        add: score(c),
        kind: 'land',
        shared: [],
        themeHits: [],
        gain,
        qty,
        rarity: isBasicLand(c) ? 'common' : wildcardRarity(c),
        forced: false,
        landNote: `makes ${madeBy}${tappedKind(c) ? ' and usually enters untapped' : ' and enters untapped'}, replacing ${e.name}, which ${why}`,
      });
    }
  }
  return out;
}

// ---- applying swaps ---------------------------------------------------------------------

/** The deck with `qty` copies of one main-deck card replaced by `add`. */
export function applySwap(deck: ResolvedDeck, cutOracleId: string, add: CardRecord, qty: number): ResolvedDeck {
  const main = deck.main
    .map((e) => (e.oracleId === cutOracleId ? { ...e, qty: e.qty - qty } : e))
    .filter((e) => e.qty > 0);
  const existing = main.find((e) => e.oracleId === add.oracleId);
  const next = existing
    ? main.map((e) => (e === existing ? { ...e, qty: e.qty + qty } : e))
    : [...main, { qty, name: add.name, oracleId: add.oracleId, card: add }];
  return { ...deck, main: next };
}

/** Applies a suggestion's swaps in order. */
export function applySwaps(deck: ResolvedDeck, swaps: Swap[], index: CardIndex): ResolvedDeck {
  let d = deck;
  for (const s of swaps) {
    const add = index.byOracle.get(s.addOracleId);
    if (add) d = applySwap(d, s.cutOracleId, add, s.qty);
  }
  return d;
}

function illegalReasons(c: CardRecord, fmt: FormatRules): string[] {
  const out: string[] = [];
  const status = c.legalities[fmt.legalityKey] ?? 'not_legal';
  if (status === 'banned') out.push(`banned in ${fmt.label}`);
  else if (status === 'not_legal') out.push(`not legal in ${fmt.label}`);
  if (!c.onArena) out.push('not on MTG Arena');
  return out;
}

/**
 * Rule breaks as stable keys (code + card), so fixing one card of a multi-card problem
 * doesn't look like a new problem. Companion breaks are keyed per offending card.
 */
function errorKeys(deck: ResolvedDeck, fmt: FormatRules): Map<string, string> {
  const keys = new Map<string, string>();
  for (const i of validateDeck(deck, fmt).issues) {
    if (i.severity !== 'error' || i.code === 'companion_condition') continue;
    keys.set(`${i.code}:${i.card ?? ''}`, i.message);
  }
  const companion = companionViolations(deck, fmt);
  for (const card of companion?.cards ?? []) {
    keys.set(`companion_condition:${card}`, `breaks ${companion!.rule.name}'s condition (${companion!.rule.condition})`);
  }
  return keys;
}

// ---- misc -------------------------------------------------------------------------------

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

function reasonFor(
  cut: Cut,
  add: Scored,
  shared: Role[],
  meta: MetaContext | undefined,
  theme: { commander: string; hits: string[] } | null,
  recNote: string | null,
): string {
  const role = shared.length ? `fills the same ${shared.map((r) => ROLE_WORDS[r]).join('/')} role` : 'fills a similar slot';
  const cutMv = castingMv(cut.e.card);
  const addMv = castingMv(add.card);
  const mv = addMv < cutMv ? ` for ${cutMv - addMv} less mana` : addMv > cutMv ? ` at ${addMv - cutMv} more mana` : ' at the same mana value';
  let why: string;
  if (cut.illegal.length) {
    why = `and replaces ${cut.e.name}, which is ${cut.illegal.join(' and ')}`;
  } else if (cut.salt.length) {
    why = `and keeps the table friendly (${cut.e.name}: ${cut.salt.join(', ')})`;
  } else if (recNote) {
    why = `and ${recNote}`;
  } else if (meta && add.metaRate > 0) {
    const n = meta.lists.filter((l) => l.main.has(add.card.oracleId)).length;
    why = `and appears in ${n} of ${meta.lists.length} meta lists`;
  } else {
    why = add.card.edhrecRank !== null ? 'and is a more widely played card' : 'and is a stronger card by rarity and age';
  }
  const fits = theme?.hits.length ? `; it supports ${theme.commander}'s ${theme.hits.join('/')} theme` : '';
  return `${add.card.name} ${role}${mv}, ${why}${fits}.`;
}

function cmp(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
