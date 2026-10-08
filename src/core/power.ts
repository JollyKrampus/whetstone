import { type Analysis, analyzeDeck, type ColorRequirement, round } from './analyze.js';
import { frontTypeLine, isBasicLand, isLand, rulesText, wildcardRarity } from './cards.js';
import { countCards, playEntries, type ResolvedDeck, type ResolvedEntry } from './deck.js';
import type { FormatRules } from './formats.js';
import type { MetaContext } from './meta.js';
import {
  type BrawlRubric,
  brawlRubric,
  type ConstructedRubric,
  constructedRubric,
  tierFor,
} from './rubric.js';
import type { Color } from './types.js';

export interface Dimension {
  name: string;
  score: number;
  weight: number;
  confidence: 'normal' | 'low';
  reasons: string[];
}

export interface PowerRating {
  tier: number;
  label: string;
  score: number;
  rubric: string;
  archetype: string;
  dimensions: Dimension[];
}

/** Summary of simulate_hands used by the consistency dimension. */
export interface ConsistencySignals {
  keepable7: number;
  landDropsOnCurve: number;
  colorAvailability: number;
}

export interface RateOptions {
  meta?: MetaContext;
  /** Date the card data was taken (YYYY-MM-DD); recency is measured from here, not "now". */
  asOf: string;
  simulation?: ConsistencySignals;
}

const COLOR_NAMES: Record<Color, string> = { W: 'white', U: 'blue', B: 'black', R: 'red', G: 'green' };
const PIP_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five'];

const clamp = (n: number, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const pct = (n: number) => `${Math.round(n * 100)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function ratePower(deck: ResolvedDeck, fmt: FormatRules, opts: RateOptions): PowerRating {
  const a = analyzeDeck(deck, fmt);
  return fmt.commander ? rateBrawl(deck, a, brawlRubric(), opts) : rateConstructed(deck, a, constructedRubric(), opts);
}

function finish(rubric: { name: string; tiers: ConstructedRubric['tiers'] }, archetype: string, dims: Dimension[]): PowerRating {
  const totalWeight = dims.reduce((s, d) => s + d.weight, 0) || 1;
  const score = round(dims.reduce((s, d) => s + d.score * d.weight, 0) / totalWeight, 1);
  const t = tierFor(score, rubric.tiers);
  return { tier: t.tier, label: t.label, score, rubric: rubric.name, archetype, dimensions: dims };
}

// ---- shared dimensions ---------------------------------------------------------------

function requirementReason(r: ColorRequirement): string {
  const color = COLOR_NAMES[r.color];
  const pip = PIP_WORDS[r.pips] ?? String(r.pips);
  return (
    `Only ${r.sources} ${color} sources for ${plural(r.copies, `${pip}-pip ${color} card`)} at mana value ${r.mv}; ` +
    `Karsten recommends ${r.sourcesNeeded}.`
  );
}

function manaBase(a: Analysis, p: ConstructedRubric['manaBase'], landTarget: number, weight: number): Dimension {
  const reqs = a.colors.requirements;
  let coverage = 100;
  if (reqs.length) {
    const ratios = reqs.map((r) => ({ ratio: Math.min(1, r.sources / r.sourcesNeeded), copies: r.copies }));
    const copies = ratios.reduce((s, r) => s + r.copies, 0) || 1;
    const mean = ratios.reduce((s, r) => s + r.ratio * r.copies, 0) / copies;
    const worst = Math.min(...ratios.map((r) => r.ratio));
    coverage = clamp(100 * (1 - p.shortfallPenalty * (1 - (worst + mean) / 2)));
  }
  const lands = a.landCount + a.mdfcLandCount * 0.5;
  const off = Math.max(0, Math.abs(lands - landTarget) - p.landTolerance);
  const landScore = clamp(100 - off * p.pointsPerLandOff);
  const tapped = a.tappedLands.unconditional + a.tappedLands.conditional * 0.25;
  const tappedScore = clamp(100 - Math.max(0, tapped - p.freeTappedLands) * p.pointsPerTappedLand);
  const score = round(coverage * p.coverageWeight + landScore * p.landCountWeight + tappedScore * p.tappedWeight);

  const reasons: string[] = [];
  const worst = a.colors.shortfalls[0];
  if (worst) reasons.push(requirementReason(worst));
  else if (reqs.length) reasons.push('Colored sources meet the Karsten targets for every colored card.');
  if (off > 0) {
    reasons.push(
      `${a.landCount} lands${a.mdfcLandCount ? ` (+${a.mdfcLandCount} MDFC)` : ''}; about ${Math.round(landTarget)} is typical for this deck.`,
    );
  }
  if (a.tappedLands.unconditional > p.freeTappedLands) {
    reasons.push(`${plural(a.tappedLands.unconditional, 'land')} always enter tapped, which costs tempo.`);
  }
  if (!reasons.length) reasons.push(`Land count (${a.landCount}) and tapped lands are in a good range.`);
  return { name: 'Mana base', score, weight, confidence: 'normal', reasons: reasons.slice(0, 3) };
}

function interaction(a: Analysis, p: ConstructedRubric['interaction'], target: number, weight: number): Dimension {
  const total = a.interaction.total;
  const volume = target > 0 ? Math.min(1, total / target) : 1;
  const cheapShare = total ? a.interaction.cheap / total : 0;
  const score = round(100 * (p.volumeWeight * volume + p.cheapWeight * cheapShare));
  const reasons = [
    `${plural(total, 'interactive spell')} (removal, counters, sweepers); about ${Math.round(target)} suits this deck.`,
  ];
  if (total) reasons.push(`${a.interaction.cheap} of them cost ${a.interaction.cheapMaxMv} or less.`);
  const sweepers = a.roles.counts.sweeper;
  if (sweepers) reasons.push(`Includes ${plural(sweepers, 'sweeper')}.`);
  return { name: 'Interaction', score, weight, confidence: 'normal', reasons: reasons.slice(0, 3) };
}

function cardQuality(
  deck: ResolvedDeck,
  p: ConstructedRubric['cardQuality'],
  opts: RateOptions,
  weight: number,
): Dimension {
  const spells = playEntries(deck).filter((e) => !isLand(e.card));
  const copies = countCards(spells) || 1;
  const meta = opts.meta;
  if (meta && meta.lists.length) {
    let sum = 0;
    const missing: ResolvedEntry[] = [];
    for (const e of spells) {
      const rate = meta.playRate.get(e.oracleId) ?? 0;
      if (rate > 0) sum += e.qty * (p.meta.inMetaBase + p.meta.inMetaRateBonus * (rate / (meta.maxNonlandRate || 1)));
      else missing.push(e);
    }
    const inMeta = spells.filter((e) => (meta.playRate.get(e.oracleId) ?? 0) > 0);
    const reasons = [
      `${countCards(inMeta)} of ${copies} nonland cards appear in the ${plural(meta.lists.length, 'supplied meta list')}.`,
    ];
    if (missing.length) {
      const names = [...missing].sort((x, y) => y.qty - x.qty || cmp(x.name, y.name)).slice(0, 4).map((e) => e.name);
      reasons.push(`Not seen in meta lists: ${names.join(', ')}.`);
    }
    return { name: 'Card quality', score: round((100 * sum) / copies), weight, confidence: 'normal', reasons };
  }

  const h = p.heuristic;
  const asOf = Date.parse(opts.asOf);
  const logBest = Math.log(h.popularityBest);
  const logWorst = Math.log(h.popularityWorst);
  const scored = spells.map((e) => {
    const rank = e.card.edhrecRank;
    const popularity = rank === null ? 0.2 : clamp((logWorst - Math.log(rank)) / (logWorst - logBest), 0, 1);
    const years = (asOf - Date.parse(e.card.releasedAt)) / (365.25 * 24 * 3600 * 1000);
    const recency =
      years <= h.recencyFullYears ? 1 : years >= h.recencyZeroYears ? 0 : 1 - (years - h.recencyFullYears) / (h.recencyZeroYears - h.recencyFullYears);
    const rarity = h.rarityValue[wildcardRarity(e.card)];
    const q = h.popularityWeight * popularity + h.rarityWeight * rarity + h.recencyWeight * recency;
    return { e, q };
  });
  const score = round((100 * scored.reduce((s, x) => s + x.q * x.e.qty, 0)) / copies);
  const weakest = [...scored].sort((x, y) => x.q - y.q || cmp(x.e.name, y.e.name)).slice(0, 3).map((x) => x.e.name);
  const reasons = ['No meta lists supplied, so this is estimated from card popularity, rarity and age (low confidence).'];
  if (weakest.length) reasons.push(`Weakest by that estimate: ${weakest.join(', ')}.`);
  return { name: 'Card quality', score, weight, confidence: 'low', reasons };
}

// ---- 60-card formats -------------------------------------------------------------------

function rateConstructed(deck: ResolvedDeck, a: Analysis, r: ConstructedRubric, opts: RateOptions): PowerRating {
  const arch = r.archetypes[a.archetype as keyof ConstructedRubric['archetypes']] ?? r.archetypes.midrange;
  const scale = (a.deckSize || 60) / 60;
  const dims: Dimension[] = [
    manaBase(a, r.manaBase, arch.lands * scale, r.weights.manaBase),
    speed(a, r, arch),
    interaction(a, r.interaction, arch.interaction * scale, r.weights.interaction),
    cardQuality(deck, r.cardQuality, opts, r.weights.cardQuality),
    consistency(deck, a, r, opts.simulation),
  ];
  return finish(r, a.archetype, dims);
}

function speed(a: Analysis, r: ConstructedRubric, arch: ConstructedRubric['archetypes']['aggro']): Dimension {
  const p = r.speed;
  const over = Math.max(0, a.averageManaValue - arch.avgMv);
  const mvScore = clamp(100 - over * p.pointsPerMvOver);
  const low = a.curve['0'] + a.curve['1'] + a.curve['2'];
  const lowShare = a.nonlandCount ? low / a.nonlandCount : 0;
  const lowScore = clamp((100 * lowShare) / arch.lowDropShare);
  const top = a.curve['5'] + a.curve['6'] + a.curve['7+'];
  const extraTop = Math.max(0, top - arch.maxTopEnd * ((a.deckSize || 60) / 60));
  const topScore = clamp(100 - extraTop * p.pointsPerExtraTopEnd);
  const score = round(mvScore * p.avgMvWeight + lowScore * p.lowDropWeight + topScore * p.topEndWeight);
  const reasons = [
    `Average mana value ${a.averageManaValue} for ${/^[aeiou]/.test(a.archetype) ? 'an' : 'a'} ${a.archetype} deck (target about ${arch.avgMv}).`,
    `${pct(lowShare)} of nonland cards cost 2 or less (target ${pct(arch.lowDropShare)}).`,
  ];
  if (extraTop > 0) reasons.push(`${plural(top, 'card')} at 5+ mana is a heavy top end for this archetype.`);
  return { name: 'Speed / curve', score, weight: r.weights.speed, confidence: 'normal', reasons };
}

function consistency(deck: ResolvedDeck, a: Analysis, r: ConstructedRubric, sim?: ConsistencySignals): Dimension {
  const p = r.consistency;
  const spells = playEntries(deck).filter((e) => !isLand(e.card) && !isBasicLand(e.card));
  const copies = countCards(spells) || 1;
  const fourOfs = spells.filter((e) => e.qty >= 4);
  const fourShare = countCards(fourOfs) / copies;
  const singletons = spells.filter((e) => e.qty === 1).length;
  const selection = a.roles.counts.card_draw + a.roles.counts.tutor;
  const selectionScore = Math.min(1, selection / (6 * ((a.deckSize || 60) / 60)));
  const structure = clamp(
    100 * (0.7 * Math.min(1, fourShare / p.fourOfTarget) + 0.3 * selectionScore) -
      Math.max(0, singletons - p.freeSingletons) * p.pointsPerSingleton,
  );
  const reasons: string[] = [];
  let score = structure;
  if (sim) {
    const simScore =
      (100 *
        (Math.min(1, sim.keepable7 / p.keepableTarget) +
          Math.min(1, sim.landDropsOnCurve / p.landDropTarget) +
          Math.min(1, sim.colorAvailability / p.colorTarget))) /
      3;
    score = simScore * p.simulationWeight + structure * p.structureWeight;
    reasons.push(
      `Simulated: ${pct(sim.keepable7)} keepable 7-card hands, ${pct(sim.landDropsOnCurve)} hit land drops on curve through turn 4, ` +
        `${pct(sim.colorAvailability)} average color availability on curve.`,
    );
  }
  reasons.push(`${pct(fourShare)} of nonland cards are 4-ofs${singletons > p.freeSingletons ? `; ${singletons} singletons dilute draws` : ''}.`);
  if (selection) reasons.push(`${plural(selection, 'card')} draw or tutor for more consistency.`);
  return { name: 'Consistency', score: round(score), weight: r.weights.consistency, confidence: 'normal', reasons: reasons.slice(0, 3) };
}

// ---- Brawl ---------------------------------------------------------------------------

function rateBrawl(deck: ResolvedDeck, a: Analysis, r: BrawlRubric, opts: RateOptions): PowerRating {
  const scale = (a.deckSize || 100) / 100;
  const t = r.targetsPer100;
  const dims: Dimension[] = [
    manaBase(a, r.manaBase, t.lands * scale, r.weights.manaBase),
    commanderSynergy(deck, r),
    countDimension('Ramp', a.roles.counts.ramp, t.ramp * scale, r.weights.ramp, 'ramp spells'),
    countDimension('Card draw', a.roles.counts.card_draw, t.cardDraw * scale, r.weights.cardDraw, 'card draw sources'),
    interaction(a, r.interaction, t.interaction * scale, r.weights.interaction),
    cardQuality(deck, r.cardQuality, opts, r.weights.cardQuality),
  ];
  return finish(r, 'brawl', dims);
}

function countDimension(name: string, have: number, target: number, weight: number, noun: string): Dimension {
  const score = round(100 * Math.min(1, have / (target || 1)));
  return {
    name,
    score,
    weight,
    confidence: 'normal',
    reasons: [`${have} ${noun}; about ${Math.round(target)} is typical for this deck size.`],
  };
}

function commanderSynergy(deck: ResolvedDeck, r: BrawlRubric): Dimension {
  const p = r.commanderSynergy;
  const cmd = deck.commander;
  const weight = r.weights.commanderSynergy;
  if (!cmd) {
    return { name: 'Commander synergy', score: 0, weight, confidence: 'normal', reasons: ['No commander to build around.'] };
  }
  const cmdText = rulesText(cmd.card);
  const themes = Object.entries(p.themes).filter(([, re]) => new RegExp(re).test(cmdText));
  const spells = deck.main.filter((e) => !isLand(e.card));
  const subtypes = new Set(spells.flatMap((e) => (frontTypeLine(e.card).split('—')[1] ?? '').trim().split(/\s+/)).filter(Boolean));
  const tribes = [...subtypes].filter((t) => new RegExp(`\\b${t.toLowerCase()}s?\\b`).test(cmdText));
  if (!themes.length && !tribes.length) {
    return {
      name: 'Commander synergy',
      score: 50,
      weight,
      confidence: 'low',
      reasons: [`No clear theme found in ${cmd.name}'s text; synergy can't be measured.`],
    };
  }
  const regexes = themes.map(([, re]) => new RegExp(re));
  const hits = spells.filter(
    (e) =>
      regexes.some((re) => re.test(rulesText(e.card))) ||
      tribes.some((t) => (frontTypeLine(e.card).split('—')[1] ?? '').includes(t)),
  );
  const share = countCards(hits) / (countCards(spells) || 1);
  const score = round(100 * Math.min(1, share / p.targetShare));
  const named = [...themes.map(([k]) => k), ...tribes];
  return {
    name: 'Commander synergy',
    score,
    weight,
    confidence: 'normal',
    reasons: [
      `${cmd.name} cares about: ${named.join(', ')}.`,
      `${pct(share)} of nonland cards support that (target ${pct(p.targetShare)}).`,
    ],
  };
}

function cmp(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
