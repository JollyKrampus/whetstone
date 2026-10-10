import { frontTypeLine, isLand, rulesText } from './cards.js';
import type { ResolvedDeck } from './deck.js';
import type { CardRecord } from './types.js';

export interface CommanderThemes {
  commander: string;
  /** Rubric theme names the commander's text cares about (tokens, sacrifice, …). */
  themes: string[];
  /** Creature types the commander's text names that the deck plays (Goblin, Elf, …). */
  tribes: string[];
  /** The themes and tribes this card supports; empty when it supports none. */
  matches(card: CardRecord): string[];
}

function subtypes(card: CardRecord): string[] {
  return (frontTypeLine(card).split('—')[1] ?? '').trim().split(/\s+/).filter(Boolean);
}

/**
 * What the commander builds around, read from its rules text: the rubric's theme regexes
 * plus any creature type it names. Null when there's no commander or no clear theme.
 */
export function commanderThemes(deck: ResolvedDeck, themeRegexes: Record<string, string>): CommanderThemes | null {
  const cmd = deck.commander;
  if (!cmd) return null;
  const text = rulesText(cmd.card);
  const themes = Object.entries(themeRegexes)
    .filter(([, re]) => new RegExp(re).test(text))
    .map(([name, re]) => ({ name, re: new RegExp(re) }));
  const deckTypes = new Set(deck.main.filter((e) => !isLand(e.card)).flatMap((e) => subtypes(e.card)));
  const tribes = [...deckTypes].filter((t) => new RegExp(`\\b${t.toLowerCase()}s?\\b`).test(text)).sort();
  if (!themes.length && !tribes.length) return null;
  return {
    commander: cmd.name,
    themes: themes.map((t) => t.name),
    tribes,
    matches(card) {
      const t = rulesText(card);
      const types = subtypes(card);
      return [...themes.filter((x) => x.re.test(t)).map((x) => x.name), ...tribes.filter((tr) => types.includes(tr))];
    },
  };
}
