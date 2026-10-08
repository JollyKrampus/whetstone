import { frontTypeLine, isBasicLand, printedCopyLimit } from './cards.js';
import { allEntries, countCards, playEntries, type ResolvedDeck } from './deck.js';
import type { FormatRules } from './formats.js';
import type { CardRecord } from './types.js';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  card?: string;
}

export interface ValidationResult {
  legal: boolean;
  format: string;
  mainCount: number;
  sideCount: number;
  issues: ValidationIssue[];
}

export function canBeCommander(c: CardRecord): boolean {
  const t = frontTypeLine(c);
  return (/\bLegendary\b/.test(t) && /\b(Creature|Planeswalker)\b/.test(t)) || /can be your commander/i.test(c.oracleText);
}

export function validateDeck(deck: ResolvedDeck, fmt: FormatRules): ValidationResult {
  const issues: ValidationIssue[] = [];
  const err = (code: string, message: string, card?: string) =>
    issues.push({ severity: 'error', code, message, ...(card ? { card } : {}) });
  const warn = (code: string, message: string, card?: string) =>
    issues.push({ severity: 'warning', code, message, ...(card ? { card } : {}) });

  for (const u of deck.unresolved) {
    err('unresolved', `Could not resolve "${u.text ?? ''}": ${u.reason}`);
  }

  const mainCount = countCards(playEntries(deck));
  const sideCount = countCards(deck.side);

  // Deck and sideboard size.
  if (fmt.exactDeck !== undefined && mainCount !== fmt.exactDeck) {
    err('deck_size', `${fmt.label} decks must have exactly ${fmt.exactDeck} cards including the commander; this one has ${mainCount}.`);
  } else if (mainCount < fmt.minDeck) {
    err('deck_size', `${fmt.label} decks need at least ${fmt.minDeck} cards; this one has ${mainCount}.`);
  }
  if (fmt.maxSideboard === 0 && sideCount > 0) {
    warn('sideboard_ignored', `${fmt.label} has no sideboard; ${sideCount} sideboard card(s) are ignored.`);
  } else if (sideCount > fmt.maxSideboard) {
    err('sideboard_size', `Sideboards are limited to ${fmt.maxSideboard} cards; this one has ${sideCount}.`);
  }

  // Commander.
  if (fmt.commander) {
    const cmd = deck.commander;
    if (!cmd) {
      err('no_commander', `${fmt.label} decks need a commander (a "Commander" section in the export).`);
    } else {
      if (!canBeCommander(cmd.card)) err('bad_commander', `${cmd.name} can't be a commander.`, cmd.name);
      const identity = new Set(cmd.card.colorIdentity);
      for (const e of deck.main) {
        const outside = e.card.colorIdentity.filter((c) => !identity.has(c));
        if (outside.length) {
          err('color_identity', `${e.name} has ${outside.join('')} in its color identity, outside ${cmd.name}'s.`, e.name);
        }
      }
    }
  } else if (deck.commander) {
    warn('commander_ignored', `${fmt.label} doesn't use a commander; ${deck.commander.name} is counted in the main deck.`);
  }

  if (deck.companion && !fmt.commander && !deck.side.some((e) => e.oracleId === deck.companion!.oracleId)) {
    warn('companion_not_in_sideboard', `On Arena the companion also sits in the sideboard; add ${deck.companion.name} there.`);
  }

  // Legality, Arena availability, copy limits (counted across main, side and commander).
  const totals = new Map<string, { qty: number; card: CardRecord }>();
  const seen = new Set<string>();
  for (const { zone, e } of allEntries(deck)) {
    if (zone === 'companion') {
      // The companion is counted from its sideboard copy, not twice.
      if (!seen.has(e.oracleId)) checkCard(e.card);
      seen.add(e.oracleId);
      continue;
    }
    if (zone === 'side' && fmt.maxSideboard === 0) continue;
    const t = totals.get(e.oracleId) ?? { qty: 0, card: e.card };
    t.qty += e.qty;
    totals.set(e.oracleId, t);
    if (!seen.has(e.oracleId)) checkCard(e.card);
    seen.add(e.oracleId);
  }

  function checkCard(card: CardRecord) {
    const status = card.legalities[fmt.legalityKey] ?? 'not_legal';
    if (status === 'banned') err('banned', `${card.name} is banned in ${fmt.label}.`, card.name);
    else if (status === 'not_legal') err('not_legal', `${card.name} is not legal in ${fmt.label}.`, card.name);
    if (!card.onArena) err('not_on_arena', `${card.name} is not available on MTG Arena.`, card.name);
  }

  for (const { qty, card } of totals.values()) {
    const printed = printedCopyLimit(card);
    const restricted = card.legalities[fmt.legalityKey] === 'restricted';
    const limit = restricted ? 1 : isBasicLand(card) ? Infinity : (printed ?? fmt.maxCopies);
    if (qty > limit) {
      const why = restricted ? 'restricted' : fmt.maxCopies === 1 && printed === null ? 'singleton' : `limit ${limit}`;
      err('too_many_copies', `${qty} copies of ${card.name} (${why}; max ${limit}).`, card.name);
    }
  }

  return { legal: !issues.some((i) => i.severity === 'error'), format: fmt.id, mainCount, sideCount, issues };
}
