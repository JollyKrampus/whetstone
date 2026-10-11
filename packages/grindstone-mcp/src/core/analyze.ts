import { hasRole, INTERACTION_ROLES, type Role, ROLES, tagRoles } from './roles.js';
import {
  castingCost,
  castingMv,
  frontTypeLine,
  isBasicLand,
  isCreature,
  isLand,
  isMdfcLand,
  pipsOf,
  rulesText,
} from './cards.js';
import { countCards, playEntries, type ResolvedDeck, type ResolvedEntry } from './deck.js';
import type { FormatRules } from './formats.js';
import { type Archetype, brawlRubric, constructedRubric, karstenSources, type KarstenTable } from './rubric.js';
import { COLORS, type CardRecord, type Color } from './types.js';

export const CURVE_BUCKETS = ['0', '1', '2', '3', '4', '5', '6', '7+'] as const;

export interface ColorRequirement {
  color: Color;
  pips: number;
  mv: number;
  cards: string[];
  copies: number;
  sourcesNeeded: number;
  sources: number;
  ok: boolean;
}

export interface Analysis {
  format: string;
  deckSize: number;
  archetype: Archetype | 'brawl';
  curve: Record<(typeof CURVE_BUCKETS)[number], number>;
  averageManaValue: number;
  landCount: number;
  mdfcLandCount: number;
  nonlandCount: number;
  types: Record<string, number>;
  colors: {
    deckColors: Color[];
    pips: Record<Color, number>;
    sources: Record<Color, number>;
    requirements: ColorRequirement[];
    shortfalls: ColorRequirement[];
  };
  tappedLands: { unconditional: number; conditional: number; cards: { name: string; qty: number; kind: string }[] };
  roles: {
    counts: Record<Role, number>;
    cards: { name: string; qty: number; mv: number; roles: { role: Role; rule: string }[] }[];
  };
  interaction: { total: number; cheap: number; cheapMaxMv: number };
}

const TYPES = ['Creature', 'Instant', 'Sorcery', 'Artifact', 'Enchantment', 'Planeswalker', 'Battle', 'Land'];

function emptyColors(): Record<Color, number> {
  return { W: 0, U: 0, B: 0, R: 0, G: 0 };
}

export const BASIC_TYPES = ['plains', 'island', 'swamp', 'mountain', 'forest'] as const;
export type BasicType = (typeof BASIC_TYPES)[number];
const BASIC_TYPE_COLOR: Record<BasicType, Color> = { plains: 'W', island: 'U', swamp: 'B', mountain: 'R', forest: 'G' };

/**
 * What the deck's fetch effects can find: the colors of its basic lands, and for each basic land
 * type the colors of its lands with that type (so "an Island or Swamp card" finds a Blood Crypt
 * as well as a Swamp, and finds nothing blue in a deck without Islands).
 */
export interface FetchContext {
  basics: Set<Color>;
  types: Record<BasicType, Set<Color>>;
  basicTypes: Record<BasicType, Set<Color>>;
}

const ownColors = (c: CardRecord) => c.producedMana.filter((m): m is Color => (COLORS as string[]).includes(m));

/** The fetch context of a deck's lands (main deck and commander). */
export function fetchContext(entries: { card: CardRecord }[]): FetchContext {
  const empty = () => Object.fromEntries(BASIC_TYPES.map((t) => [t, new Set<Color>()])) as Record<BasicType, Set<Color>>;
  const ctx: FetchContext = { basics: new Set(), types: empty(), basicTypes: empty() };
  for (const e of entries) {
    if (!isLand(e.card)) continue;
    const basic = isBasicLand(e.card);
    const made = ownColors(e.card);
    if (basic) made.forEach((col) => ctx.basics.add(col));
    const subtypes = (frontTypeLine(e.card).split('—')[1] ?? '').toLowerCase();
    for (const t of BASIC_TYPES) {
      if (!new RegExp(`\\b${t}\\b`).test(subtypes)) continue;
      made.forEach((col) => ctx.types[t].add(col));
      if (basic) made.forEach((col) => ctx.basicTypes[t].add(col));
    }
  }
  return ctx;
}

/**
 * Colors a land can make for this deck. Fetch effects count for what they can actually find:
 * with a FetchContext, the deck's own lands of the named types (or its basics); with a plain set
 * of basic colors (older callers), the basics plus the color of each named basic type.
 */
export function landColors(c: CardRecord, deck: Set<Color> | FetchContext): Color[] {
  const made = new Set<Color>(ownColors(c));
  const text = rulesText(c);
  const fetch = /search your library for (?:an?|up to (?:one|two)) ([\w\s,]+?)cards?/.exec(text);
  if (fetch) {
    const what = fetch[1]!;
    const ctx = deck instanceof Set ? null : deck;
    if (/basic land/.test(what)) (ctx ? ctx.basics : (deck as Set<Color>)).forEach((col) => made.add(col));
    const basicOnly = /\bbasic\b/.test(what);
    for (const t of BASIC_TYPES) {
      if (!new RegExp(`\\b${t}\\b`).test(what)) continue;
      if (!ctx) made.add(BASIC_TYPE_COLOR[t]);
      else (basicOnly ? ctx.basicTypes[t] : ctx.types[t]).forEach((col) => made.add(col));
    }
  }
  return COLORS.filter((col) => made.has(col));
}

export function tappedKind(c: CardRecord): 'unconditional' | 'conditional' | null {
  if (!isLand(c)) return null;
  const text = rulesText(c);
  // Fetch lands whose land arrives tapped (Evolving Wilds) count as tapped lands;
  // Fabled Passage untaps it later in the game.
  if (/onto the battlefield tapped/.test(text) && /search your library/.test(text)) {
    return /untap that land/.test(text) ? 'conditional' : 'unconditional';
  }
  if (!/enters (?:the battlefield )?tapped/.test(text)) return null;
  if (/unless|if you don't|if you control|you may pay/.test(text)) return 'conditional';
  return 'unconditional';
}

/** Defaults for rubric files written before the ramp curve checks existed. */
const RAMP_MIN_AVG_MV = 2.8;
const RAMP_MIN_TOP_END = 6;

/**
 * Checked in order: ramp, control, aggro, else midrange. A ramp plan needs something to ramp
 * into: enough ramp cards and either an average mana value of about 2.8 or more, or enough
 * cards at 5+ mana (`topEnd`). Without that, ramp cards are just part of the curve.
 */
export function inferArchetype(a: {
  averageManaValue: number;
  creatures: number;
  interaction: number;
  ramp: number;
  deckSize: number;
  /** Nonland cards at mana value 5 or more. */
  topEnd?: number;
}): Archetype {
  const r = constructedRubric().inference;
  const scale = a.deckSize / 60;
  const heavy =
    a.averageManaValue >= (r.ramp.minAvgMv ?? RAMP_MIN_AVG_MV) || (a.topEnd ?? 0) >= (r.ramp.minTopEnd ?? RAMP_MIN_TOP_END) * scale;
  if (a.ramp >= r.ramp.minRamp * scale && heavy) return 'ramp';
  if (a.interaction >= r.control.minInteraction * scale && a.creatures <= r.control.maxCreatures * scale) return 'control';
  if (a.averageManaValue <= r.aggro.maxAvgMv && a.creatures >= r.aggro.minCreatures * scale) return 'aggro';
  return 'midrange';
}

export function analyzeDeck(deck: ResolvedDeck, fmt: FormatRules): Analysis {
  const play = playEntries(deck);
  const deckSize = countCards(play);
  const karsten: KarstenTable = fmt.commander ? brawlRubric().karsten : constructedRubric().karsten;
  const cheapMaxMv = fmt.commander ? brawlRubric().interaction.cheapMaxMv : constructedRubric().interaction.cheapMaxMv;

  const curve = Object.fromEntries(CURVE_BUCKETS.map((b) => [b, 0])) as Analysis['curve'];
  const types: Record<string, number> = Object.fromEntries(TYPES.map((t) => [t.toLowerCase(), 0]));
  let landCount = 0;
  let mdfcLandCount = 0;
  let mvSum = 0;
  let nonland = 0;
  const pips = emptyColors();

  for (const e of play) {
    const t = frontTypeLine(e.card);
    for (const ty of TYPES) if (new RegExp(`\\b${ty}\\b`).test(t)) types[ty.toLowerCase()]! += e.qty;
    if (isLand(e.card)) {
      landCount += e.qty;
      continue;
    }
    if (isMdfcLand(e.card)) mdfcLandCount += e.qty;
    const mv = castingMv(e.card);
    curve[mv >= 7 ? '7+' : (String(Math.floor(mv)) as (typeof CURVE_BUCKETS)[number])] += e.qty;
    mvSum += mv * e.qty;
    nonland += e.qty;
    const p = pipsOf(castingCost(e.card));
    for (const c of COLORS) pips[c] += p.hard[c] * e.qty;
    for (const h of p.hybrid) for (const c of h) pips[c] += e.qty / h.length;
  }

  // Colored sources: lands (fetches count for the lands of the deck they can find) plus MDFC land backs.
  const fetchable = fetchContext(play);
  const sources = emptyColors();
  for (const e of play) {
    if (!isLand(e.card) && !isMdfcLand(e.card)) continue;
    for (const c of landColors(e.card, fetchable)) sources[c] += e.qty;
  }

  // Karsten requirements: the strictest (pips, mana value) pattern per color, with its cards.
  const patterns = new Map<string, ColorRequirement>();
  for (const e of play) {
    if (isLand(e.card)) continue;
    const p = pipsOf(castingCost(e.card));
    const mv = castingMv(e.card);
    for (const color of COLORS) {
      const n = p.hard[color];
      if (!n) continue;
      const turn = Math.max(mv, n);
      const key = `${color}:${n}:${turn}`;
      const req = patterns.get(key) ?? {
        color,
        pips: n,
        mv: turn,
        cards: [],
        copies: 0,
        sourcesNeeded: karstenSources(karsten, n, turn, deckSize || karsten.deckSize),
        sources: sources[color],
        ok: true,
      };
      req.cards.push(e.name);
      req.copies += e.qty;
      req.ok = req.sources >= req.sourcesNeeded;
      patterns.set(key, req);
    }
  }
  const requirements = [...patterns.values()].sort(
    (a, b) => COLORS.indexOf(a.color) - COLORS.indexOf(b.color) || b.sourcesNeeded - a.sourcesNeeded || a.mv - b.mv,
  );
  const shortfalls = requirements
    .filter((r) => !r.ok)
    .sort((a, b) => b.sourcesNeeded - b.sources - (a.sourcesNeeded - a.sources) || b.copies - a.copies);

  // Tapped lands.
  const tapped: Analysis['tappedLands'] = { unconditional: 0, conditional: 0, cards: [] };
  for (const e of play) {
    const kind = tappedKind(e.card);
    if (!kind) continue;
    tapped[kind] += e.qty;
    tapped.cards.push({ name: e.name, qty: e.qty, kind });
  }

  // Roles.
  const counts = Object.fromEntries(ROLES.map((r) => [r, 0])) as Record<Role, number>;
  const roleCards: Analysis['roles']['cards'] = [];
  let interaction = 0;
  let cheap = 0;
  for (const e of play) {
    if (isLand(e.card)) continue;
    const tags = tagRoles(e.card);
    for (const t of tags) counts[t.role] += e.qty;
    roleCards.push({ name: e.name, qty: e.qty, mv: castingMv(e.card), roles: tags });
    if (tags.some((t) => INTERACTION_ROLES.includes(t.role))) {
      interaction += e.qty;
      if (castingMv(e.card) <= cheapMaxMv) cheap += e.qty;
    }
  }

  const averageManaValue = nonland ? round(mvSum / nonland, 2) : 0;
  const creatures = play.filter((e) => isCreature(e.card)).reduce((n, e) => n + e.qty, 0);
  const archetype = fmt.commander
    ? 'brawl'
    : inferArchetype({
        averageManaValue,
        creatures,
        interaction,
        ramp: counts.ramp,
        deckSize,
        topEnd: curve['5'] + curve['6'] + curve['7+'],
      });

  return {
    format: fmt.id,
    deckSize,
    archetype,
    curve,
    averageManaValue,
    landCount,
    mdfcLandCount,
    nonlandCount: nonland,
    types,
    colors: {
      deckColors: COLORS.filter((c) => pips[c] > 0),
      pips: Object.fromEntries(COLORS.map((c) => [c, round(pips[c], 1)])) as Record<Color, number>,
      sources,
      requirements,
      shortfalls,
    },
    tappedLands: tapped,
    roles: { counts, cards: roleCards },
    interaction: { total: interaction, cheap, cheapMaxMv },
  };
}

export function round(n: number, digits = 0): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export function entriesWithRole(entries: ResolvedEntry[], role: Role): ResolvedEntry[] {
  return entries.filter((e) => hasRole(e.card, role));
}
