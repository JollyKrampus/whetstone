import { type Role, tagRoles } from '../data/roles.js';
import { landColors, round } from './analyze.js';
import { castingCost, castingMv, isBasicLand, isLand, isMdfcLand, normalizeName, pipsOf } from './cards.js';
import { playEntries, type ResolvedDeck } from './deck.js';
import { type Color, COLORS } from './types.js';

/*
 * Stateless Monte Carlo opening-hand model. It answers "how often" questions with
 * probabilities; it does not play games. Simplifications, all deliberate:
 *  - A hand is keepable with 2-5 lands and at least one spell of mana value <= 3 whose
 *    colored pips the hand's lands can pay.
 *  - London mulligan: redraw 7 and bottom one card per mulligan (extra lands first when
 *    flooded, otherwise the most expensive spell); always keep at 5.
 *  - Modal double-faced spell//land cards count as lands.
 *  - The commander (Brawl) is in the command zone, not the library.
 */

export function rng(seed: number): () => number {
  // splitmix32 → sfc32
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x9e3779b9) >>> 0;
    let z = s;
    z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
    z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
    return (z ^ (z >>> 16)) >>> 0;
  };
  let a = next();
  let b = next();
  let c = next();
  let d = next();
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    const t = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    return t / 4294967296;
  };
}

function shuffle<T>(arr: T[], rand: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface SimCard {
  name: string;
  land: boolean;
  /** Lands: colors produced. */
  produces: Color[];
  mv: number;
  pips: Record<Color, number>;
  roles: Role[];
}

export function buildLibrary(deck: ResolvedDeck): SimCard[] {
  const lib: SimCard[] = [];
  const basicColors = new Set<Color>();
  for (const e of playEntries(deck)) {
    if (isBasicLand(e.card)) e.card.producedMana.forEach((m) => (COLORS as string[]).includes(m) && basicColors.add(m as Color));
  }
  for (const e of deck.main) {
    const land = isLand(e.card) || isMdfcLand(e.card);
    const card: SimCard = {
      name: e.name,
      land,
      produces: land ? landColors(e.card, basicColors) : [],
      mv: land ? 0 : castingMv(e.card),
      pips: pipsOf(castingCost(e.card)).hard,
      roles: tagRoles(e.card).map((t) => t.role),
    };
    for (let i = 0; i < e.qty; i++) lib.push(card);
  }
  return lib;
}

/** Can these lands pay the colored pips (each land pays one pip)? Bipartite matching. */
export function canPay(pips: Record<Color, number>, lands: SimCard[]): boolean {
  const need: Color[] = [];
  for (const c of COLORS) for (let i = 0; i < pips[c]; i++) need.push(c);
  if (need.length > lands.length) return false;
  const owner = new Array<number>(lands.length).fill(-1);
  const tryAssign = (p: number, seen: boolean[]): boolean => {
    for (let l = 0; l < lands.length; l++) {
      if (seen[l] || !lands[l]!.produces.includes(need[p]!)) continue;
      seen[l] = true;
      if (owner[l] === -1 || tryAssign(owner[l]!, seen)) {
        owner[l] = p;
        return true;
      }
    }
    return false;
  };
  return need.every((_, p) => tryAssign(p, new Array<boolean>(lands.length).fill(false)));
}

/** Castable by turn `turn`: enough lands for its mana value, and the colors line up. */
function castableBy(card: SimCard, lands: SimCard[], turn: number): boolean {
  return card.mv <= turn && lands.length >= card.mv && canPay(card.pips, lands);
}

export function isKeepable(hand: SimCard[]): boolean {
  const lands = hand.filter((c) => c.land);
  if (lands.length < 2 || lands.length > 5) return false;
  return hand.some((c) => !c.land && c.mv <= 3 && canPay(c.pips, lands));
}

/** London mulligan bottoming: shed lands when flooded, else the priciest spell. */
function bottom(hand: SimCard[], n: number): { kept: SimCard[]; bottomed: SimCard[] } {
  const kept = [...hand];
  const bottomed: SimCard[] = [];
  for (let i = 0; i < n; i++) {
    const lands = kept.filter((c) => c.land).length;
    const spells = kept.filter((c) => !c.land);
    let idx: number;
    if (lands > 3 || !spells.length) idx = kept.findIndex((c) => c.land);
    else {
      const worst = spells.reduce((a, b) => (b.mv > a.mv ? b : a));
      idx = kept.indexOf(worst);
    }
    bottomed.push(...kept.splice(idx, 1));
  }
  return { kept, bottomed };
}

export interface SimCheck {
  card?: string;
  role?: Role;
  byTurn: number;
}

export interface SimOptions {
  iterations?: number;
  seed?: number;
  playDraw?: 'play' | 'draw';
  bo1Smoothing?: boolean;
  checks?: SimCheck[];
}

/** Number of candidate opening hands the Bo1 smoother is modeled as choosing between. */
export const BO1_SMOOTHING_CANDIDATES = 2;

export interface SimReport {
  iterations: number;
  seed: number;
  playDraw: 'play' | 'draw';
  bo1Smoothing: boolean;
  librarySize: number;
  lands: number;
  keepable7: number;
  mulliganRate: number;
  keptAt: { '7': number; '6': number; '5': number };
  landDrops: { turn2: number; turn3: number; turn4: number; turn5: number };
  colors: { card: string; mv: number; turn: number; probability: number }[];
  colorAvailability: number;
  checks: { card?: string; role?: Role; byTurn: number; probability: number }[];
  /** Lands in the first 7 (after smoothing, before mulligans): simulated vs exact hypergeometric (unsmoothed). */
  openingLands: { lands: number; simulated: number; exact: number }[];
  notes: string[];
}

export function simulateHands(deck: ResolvedDeck, opts: SimOptions = {}): SimReport {
  const iterations = opts.iterations ?? 10_000;
  const seed = opts.seed ?? 1;
  const playDraw = opts.playDraw ?? 'play';
  const smoothing = opts.bo1Smoothing ?? false;
  const checks = opts.checks ?? [];
  const library = buildLibrary(deck);
  const N = library.length;
  const landTotal = library.filter((c) => c.land).length;
  const rand = rng(seed);

  // Distinct colored spells, each checked on the turn matching its mana value.
  const colored = [...new Map(library.filter((c) => !c.land && COLORS.some((col) => c.pips[col] > 0)).map((c) => [c.name, c])).values()];
  const colorHits = new Array<number>(colored.length).fill(0);
  const checkHits = new Array<number>(checks.length).fill(0);
  const checkNames = checks.map((c) => (c.card ? normalizeName(c.card) : null));
  let keepable7 = 0;
  const keptAt = { '7': 0, '6': 0, '5': 0 };
  const landHits = { turn2: 0, turn3: 0, turn4: 0, turn5: 0 };
  const targetLands = (landTotal / Math.max(1, N)) * 7;
  const openingLandCounts = new Array<number>(8).fill(0);
  const maxTurn = Math.max(7, ...checks.map((c) => c.byTurn), ...colored.map((c) => Math.ceil(c.mv)));

  for (let it = 0; it < iterations; it++) {
    // Opening hand (optionally Bo1-smoothed), then London mulligans.
    let order = shuffle(library, rand);
    if (smoothing && N >= 7) {
      let bestDiff = Math.abs(order.slice(0, 7).filter((c) => c.land).length - targetLands);
      for (let k = 1; k < BO1_SMOOTHING_CANDIDATES; k++) {
        const alt = shuffle(library, rand);
        const diff = Math.abs(alt.slice(0, 7).filter((c) => c.land).length - targetLands);
        if (diff < bestDiff) {
          order = alt;
          bestDiff = diff;
        }
      }
    }
    let hand = order.slice(0, 7);
    let rest = order.slice(7);
    openingLandCounts[hand.filter((c) => c.land).length]!++;
    if (isKeepable(hand)) {
      keepable7++;
      keptAt['7']++;
    } else {
      let kept = false;
      for (let mull = 1; mull <= 2 && !kept; mull++) {
        order = shuffle(library, rand);
        const { kept: k, bottomed } = bottom(order.slice(0, 7), mull);
        hand = k;
        rest = [...order.slice(7), ...bottomed];
        if (mull === 2 || isKeepable(hand)) {
          kept = true;
          keptAt[String(7 - mull) as '6' | '5']++;
        }
      }
    }

    // Cards seen by each turn.
    const seenBy = (turn: number) => [...hand, ...rest.slice(0, playDraw === 'play' ? turn - 1 : turn)];
    const seenCache = new Map<number, { cards: SimCard[]; lands: SimCard[] }>();
    const seen = (turn: number) => {
      let s = seenCache.get(turn);
      if (!s) {
        const cards = seenBy(Math.min(turn, maxTurn));
        s = { cards, lands: cards.filter((c) => c.land) };
        seenCache.set(turn, s);
      }
      return s;
    };
    for (const t of [2, 3, 4, 5] as const) if (seen(t).lands.length >= t) landHits[`turn${t}`]++;
    colored.forEach((c, i) => {
      const turn = Math.max(1, Math.ceil(c.mv));
      const lands = seen(turn).lands;
      if (lands.length >= turn && canPay(c.pips, lands)) colorHits[i]!++;
    });
    checks.forEach((chk, i) => {
      const s = seen(chk.byTurn);
      const name = checkNames[i];
      const hit = s.cards.some(
        (c) =>
          !c.land &&
          (name ? normalizeName(c.name) === name || normalizeName(c.name.split(' // ')[0]!) === name : c.roles.includes(chk.role!)) &&
          castableBy(c, s.lands, chk.byTurn),
      );
      if (hit) checkHits[i]!++;
    });
  }

  const p = (n: number) => round(n / iterations, 4);
  const colors = colored
    .map((c, i) => ({ card: c.name, mv: c.mv, turn: Math.max(1, Math.ceil(c.mv)), probability: p(colorHits[i]!) }))
    .sort((a, b) => a.probability - b.probability || (a.card < b.card ? -1 : 1));
  return {
    iterations,
    seed,
    playDraw,
    bo1Smoothing: smoothing,
    librarySize: N,
    lands: landTotal,
    keepable7: p(keepable7),
    mulliganRate: p(iterations - keepable7),
    keptAt: { '7': p(keptAt['7']), '6': p(keptAt['6']), '5': p(keptAt['5']) },
    landDrops: { turn2: p(landHits.turn2), turn3: p(landHits.turn3), turn4: p(landHits.turn4), turn5: p(landHits.turn5) },
    colors,
    colorAvailability: colors.length ? round(colors.reduce((s, c) => s + c.probability, 0) / colors.length, 4) : 1,
    checks: checks.map((c, i) => ({ ...(c.card ? { card: c.card } : { role: c.role }), byTurn: c.byTurn, probability: p(checkHits[i]!) })),
    openingLands: Array.from({ length: Math.min(7, N) + 1 }, (_, k) => ({
      lands: k,
      simulated: p(openingLandCounts[k]!),
      exact: round(hypergeometric(N, landTotal, Math.min(7, N), k), 4),
    })),
    notes: [
      'Keepable: 2-5 lands and a spell of mana value 3 or less that the lands in hand can pay for.',
      'Land drops: P(at least N lands seen by turn N). Colors: P(enough lands of the right colors by the turn matching mana value).',
      ...(smoothing
        ? [
            `Bo1 smoothing is an approximation: Arena's exact algorithm is unpublished. Modeled as choosing, from ${BO1_SMOOTHING_CANDIDATES} candidate opening hands, the one whose land count is closest to the deck's land ratio.`,
          ]
        : []),
    ],
  };
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  let s = 0;
  for (let i = 1; i <= k; i++) s += Math.log(n - k + i) - Math.log(i);
  return s;
}

/** P(exactly k successes in n draws from N cards containing K successes). */
export function hypergeometric(N: number, K: number, n: number, k: number): number {
  const v = logChoose(K, k) + logChoose(N - K, n - k) - logChoose(N, n);
  return Number.isFinite(v) ? Math.exp(v) : 0;
}

export interface SampleHand {
  seed: number;
  hand: string[];
  nextDraws: string[];
  landsInHand: number;
  keepable: boolean;
}

export function dealSampleHand(deck: ResolvedDeck, seed: number): SampleHand {
  const order = shuffle(buildLibrary(deck), rng(seed));
  const hand = order.slice(0, 7);
  return {
    seed,
    hand: hand.map((c) => c.name),
    nextDraws: order.slice(7, 10).map((c) => c.name),
    landsInHand: hand.filter((c) => c.land).length,
    keepable: isKeepable(hand),
  };
}
