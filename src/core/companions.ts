import { castingCost, frontTypeLine, isLand, normalizeName } from './cards.js';
import { countCards, type ResolvedDeck, type ResolvedEntry } from './deck.js';
import type { FormatRules } from './formats.js';
import type { CardRecord } from './types.js';

/*
 * Companion deckbuilding conditions (the Ikoria companions). They apply to the starting
 * deck: the main deck plus, in Brawl, the commander. Mana value uses the card's full mana
 * value as it would be in the library (split cards combine both halves; MDFCs use the
 * front face), which is Scryfall's `cmc`.
 */

export interface CompanionRule {
  name: string;
  condition: string;
  /** Cards that break the condition (deck-wide rules return an empty list and use `deckOk`). */
  violations(deck: ResolvedDeck, fmt: FormatRules): string[];
}

const PERMANENT = /\b(Creature|Artifact|Enchantment|Planeswalker|Land|Battle)\b/;
const isPermanent = (c: CardRecord) => PERMANENT.test(frontTypeLine(c));
const nonland = (es: ResolvedEntry[]) => es.filter((e) => !isLand(e.card));

/** Keyword abilities that are activated abilities even though the text has no colon. */
const ACTIVATED_KEYWORDS = /\b(equip|crew|cycling|reconfigure|fortify|outlast|level up|unearth|embalm|eternalize|ninjutsu|scavenge|transmute|channel|boast|exhaust|station)\b/i;

export function hasActivatedAbility(c: CardRecord): boolean {
  const text = c.oracleText.replace(/\([^)]*\)/g, '');
  // "Cost: effect", excluding quoted abilities granted to other objects.
  const lines = text.split('\n').map((l) => l.replace(/"[^"]*"/g, ''));
  return lines.some((l) => /^[^:]{1,80}:\s/.test(l) && !/^(?:choose|as an additional cost)/i.test(l)) || ACTIVATED_KEYWORDS.test(text);
}

function startingDeck(deck: ResolvedDeck): ResolvedEntry[] {
  return [...(deck.commander ? [deck.commander] : []), ...deck.main];
}

export const COMPANIONS: CompanionRule[] = [
  {
    name: 'Gyruda, Doom of Depths',
    condition: 'Each nonland card in your starting deck has an even mana value.',
    violations: (d) => nonland(startingDeck(d)).filter((e) => e.card.cmc % 2 !== 0).map((e) => e.name),
  },
  {
    name: 'Jegantha, the Wellspring',
    condition: 'No card in your starting deck has more than one of the same mana symbol in its mana cost.',
    violations: (d) =>
      startingDeck(d)
        .filter((e) =>
          castingCost(e.card)
            .split(' // ')
            .concat(e.card.faces.slice(1).map((f) => f.manaCost))
            .some((cost) => {
              const symbols = [...cost.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
              return new Set(symbols).size !== symbols.length;
            }),
        )
        .map((e) => e.name),
  },
  {
    name: 'Kaheera, the Orphanguard',
    condition: 'Each creature card in your starting deck is a Cat, Elemental, Nightmare, Dinosaur, or Beast card.',
    violations: (d) =>
      startingDeck(d)
        .filter((e) => /\bCreature\b/.test(frontTypeLine(e.card)))
        .filter((e) => !/\b(Cat|Elemental|Nightmare|Dinosaur|Beast)\b/.test(frontTypeLine(e.card)) && !e.card.keywords.includes('Changeling'))
        .map((e) => e.name),
  },
  {
    name: 'Keruga, the Macrosage',
    condition: 'Your starting deck contains only cards with mana value 3 or greater and land cards.',
    violations: (d) => nonland(startingDeck(d)).filter((e) => e.card.cmc < 3).map((e) => e.name),
  },
  {
    name: 'Lurrus of the Dream-Den',
    condition: 'Each permanent card in your starting deck has mana value 2 or less.',
    violations: (d) => startingDeck(d).filter((e) => isPermanent(e.card) && !isLand(e.card) && e.card.cmc > 2).map((e) => e.name),
  },
  {
    name: 'Lutri, the Spellchaser',
    condition: 'Each nonland card in your starting deck has a different name.',
    violations: (d) => nonland(startingDeck(d)).filter((e) => e.qty > 1).map((e) => e.name),
  },
  {
    name: 'Obosh, the Preypiercer',
    condition: 'Each nonland card in your starting deck has an odd mana value.',
    violations: (d) => nonland(startingDeck(d)).filter((e) => e.card.cmc % 2 !== 1).map((e) => e.name),
  },
  {
    name: 'Umori, the Collector',
    condition: 'Each nonland card in your starting deck shares a card type.',
    violations: (d) => {
      const cards = nonland(startingDeck(d));
      const types = ['Creature', 'Artifact', 'Enchantment', 'Planeswalker', 'Instant', 'Sorcery', 'Battle', 'Kindred'];
      const typesOf = (c: CardRecord) => types.filter((t) => new RegExp(`\\b${t}\\b`).test(frontTypeLine(c)));
      // The best shared type is the one the most copies have; everything else breaks it.
      const best = types
        .map((t) => ({ t, n: countCards(cards.filter((e) => typesOf(e.card).includes(t))) }))
        .sort((a, b) => b.n - a.n)[0];
      return best ? cards.filter((e) => !typesOf(e.card).includes(best.t)).map((e) => e.name) : [];
    },
  },
  {
    name: 'Yorion, Sky Nomad',
    condition: 'Your starting deck contains at least twenty cards more than the minimum deck size.',
    violations: (d, fmt) =>
      countCards(startingDeck(d)) >= fmt.minDeck + 20 ? [] : [`deck has ${countCards(startingDeck(d))} cards; needs ${fmt.minDeck + 20}`],
  },
  {
    name: 'Zirda, the Dawnwaker',
    condition: 'Each permanent card in your starting deck has an activated ability.',
    violations: (d) => startingDeck(d).filter((e) => isPermanent(e.card) && !hasActivatedAbility(e.card)).map((e) => e.name),
  },
];

export function companionRule(card: CardRecord): CompanionRule | undefined {
  const key = normalizeName(card.name);
  return COMPANIONS.find((c) => normalizeName(c.name) === key);
}

/** Cards in the deck that break its companion's condition (empty when fine or no companion). */
export function companionViolations(deck: ResolvedDeck, fmt: FormatRules): { rule: CompanionRule; cards: string[] } | null {
  if (!deck.companion) return null;
  const rule = companionRule(deck.companion.card);
  if (!rule) return null;
  return { rule, cards: [...new Set(rule.violations(deck, fmt))] };
}
