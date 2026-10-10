import type { CardIndex } from './cards.js';
import { countCards, playEntries, type ResolvedDeck, type ResolvedEntry } from './deck.js';
import type { FormatRules } from './formats.js';
import type { MetaContext } from './meta.js';
import { type PowerRating, ratePower } from './power.js';
import type { RecommendationList } from './recs.js';
import { saltOf } from './salt.js';
import { applySwaps, type Profile, type SuggestOptions, type SuggestResult, type Swap, suggestUpgrades } from './suggest.js';
import { type ValidationResult, validateDeck } from './validate.js';
import type { CardRecord, Rarity } from './types.js';
import { zeroWildcards } from './wildcards.js';

export const VERSION_LABELS: Record<Profile, string> = {
  faithful: 'Same deck, best cards',
  competitive: 'Most competitive',
  casual: 'Friendly casual',
};

export interface DeckVersion {
  profile: Profile;
  label: string;
  suggestion: SuggestResult;
  rating: { before: Pick<PowerRating, 'tier' | 'label' | 'score'>; after: Pick<PowerRating, 'tier' | 'label' | 'score'> };
  validation: Pick<ValidationResult, 'legal' | 'issues'>;
  /** Feel-bad cards left in this version (casual: should be none). */
  feelBadCards: { name: string; why: string[] }[];
  /** The finished deck as an MTG Arena import. */
  arenaExport: string;
}

export interface VersionOptions {
  profiles?: Profile[];
  preferPremium?: boolean;
  keepCards?: string[];
  wildcards?: SuggestOptions['wildcards'];
  meta?: MetaContext;
  recommendations?: RecommendationList;
  asOf: string;
}

/** Builds each requested deck version, rates it, validates it and renders an Arena import. */
export function buildVersions(deck: ResolvedDeck, fmt: FormatRules, index: CardIndex, opts: VersionOptions): DeckVersion[] {
  const rate = (d: ResolvedDeck) => {
    const r = ratePower(d, fmt, { meta: opts.meta, asOf: opts.asOf, recommendations: opts.recommendations });
    return { tier: r.tier, label: r.label, score: r.score };
  };
  const before = rate(deck);
  return (opts.profiles ?? (['faithful', 'competitive', 'casual'] as Profile[])).map((profile) => {
    const suggestion = suggestUpgrades(deck, fmt, index, {
      profile,
      preferPremium: opts.preferPremium,
      keepCards: opts.keepCards,
      wildcards: opts.wildcards,
      meta: opts.meta,
      recommendations: opts.recommendations,
      asOf: opts.asOf,
    });
    if (profile !== 'casual') keepImprovements(deck, suggestion, index, (d) => rate(d).score);
    const result = applySwaps(deck, suggestion.swaps, index);
    const v = validateDeck(result, fmt);
    return {
      profile,
      label: VERSION_LABELS[profile],
      suggestion,
      rating: { before, after: rate(result) },
      validation: { legal: v.legal, issues: v.issues },
      feelBadCards: playEntries(result)
        .map((e) => ({ name: e.name, why: saltOf(e.card).avoid }))
        .filter((x) => x.why.length),
      arenaExport: arenaExport(result),
    };
  });
}

/**
 * Faithful and competitive versions should never come out weaker. Walk the swaps in order
 * and drop any optional one that lowers the deck's power score (required swaps, such as
 * replacing banned cards, always stay). Rewrites the suggestion's swaps and totals in place.
 */
function keepImprovements(deck: ResolvedDeck, s: SuggestResult, index: CardIndex, score: (d: ResolvedDeck) => number) {
  let current = deck;
  let best = score(deck);
  const kept: Swap[] = [];
  const dropped: string[] = [];
  for (const swap of s.swaps) {
    const next = applySwaps(current, [swap], index);
    const after = score(next);
    if (swap.required || after >= best) {
      kept.push(swap);
      current = next;
      best = Math.max(best, after);
    } else {
      dropped.push(`${swap.cut} → ${swap.add}`);
    }
  }
  if (!dropped.length) return;
  s.swaps = kept;
  s.totalCost = zeroWildcards();
  for (const k of kept) for (const [r, n] of Object.entries(k.wildcardCost) as [Rarity, number][]) s.totalCost[r] += n;
  if (s.budget) {
    s.remaining = Object.fromEntries(Object.entries(s.budget).map(([r, n]) => [r, (n ?? 0) - s.totalCost[r as Rarity]]));
  }
  s.changes = { ...s.changes, cards: kept.reduce((n, k) => n + k.qty, 0) };
  s.notes.push(`Dropped ${dropped.length} swap(s) that didn't raise the power rating: ${dropped.slice(0, 4).join(', ')}${dropped.length > 4 ? ', …' : ''}.`);
}

/** Arena import names: double-faced, adventure and flip cards by their front face. */
export function arenaName(card: CardRecord): string {
  return ['transform', 'modal_dfc', 'adventure', 'flip', 'meld', 'prepare'].includes(card.layout) && card.faces[0]
    ? card.faces[0].name
    : card.name;
}

/** Renders a deck in MTG Arena's import format. */
export function arenaExport(deck: ResolvedDeck): string {
  const lines = (es: ResolvedEntry[]) =>
    [...es]
      .sort((a, b) => b.qty - a.qty || (a.name < b.name ? -1 : 1))
      .map((e) => `${e.qty} ${arenaName(e.card)}`);
  const parts: string[] = [];
  if (deck.name) parts.push('About', `Name ${deck.name}`, '');
  if (deck.commander) parts.push('Commander', `1 ${arenaName(deck.commander.card)}`, '');
  if (deck.companion) parts.push('Companion', `1 ${arenaName(deck.companion.card)}`, '');
  parts.push('Deck', ...lines(deck.main));
  if (deck.side.length) parts.push('', 'Sideboard', ...lines(deck.side));
  return parts.join('\n');
}

export function deckCount(deck: ResolvedDeck): number {
  return countCards(playEntries(deck));
}
