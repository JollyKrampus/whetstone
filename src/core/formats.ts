import { ToolError } from '../tools/result.js';

export interface FormatRules {
  id: string;
  label: string;
  /** Key in Scryfall's `legalities` object. */
  legalityKey: string;
  /** Minimum main-deck size (commander included for Brawl). */
  minDeck: number;
  /** Exact deck size, when the format requires one. */
  exactDeck?: number;
  maxCopies: number;
  maxSideboard: number;
  commander: boolean;
}

/**
 * Arena constructed formats. Alchemy is intentionally unsupported. Arena's Explorer
 * format became Pioneer, and Scryfall no longer has an `explorer` key, so `explorer` is
 * kept only as an alias.
 */
export const FORMATS: Record<string, FormatRules> = {
  standard: {
    id: 'standard',
    label: 'Standard',
    legalityKey: 'standard',
    minDeck: 60,
    maxCopies: 4,
    maxSideboard: 15,
    commander: false,
  },
  pioneer: {
    id: 'pioneer',
    label: 'Pioneer',
    legalityKey: 'pioneer',
    minDeck: 60,
    maxCopies: 4,
    maxSideboard: 15,
    commander: false,
  },
  historic: {
    id: 'historic',
    label: 'Historic',
    legalityKey: 'historic',
    minDeck: 60,
    maxCopies: 4,
    maxSideboard: 15,
    commander: false,
  },
  timeless: {
    id: 'timeless',
    label: 'Timeless',
    legalityKey: 'timeless',
    minDeck: 60,
    maxCopies: 4,
    maxSideboard: 15,
    commander: false,
  },
  brawl: {
    id: 'brawl',
    label: 'Brawl',
    legalityKey: 'brawl',
    minDeck: 100,
    exactDeck: 100,
    maxCopies: 1,
    maxSideboard: 0,
    commander: true,
  },
  standardbrawl: {
    id: 'standardbrawl',
    label: 'Standard Brawl',
    legalityKey: 'standardbrawl',
    minDeck: 60,
    exactDeck: 60,
    maxCopies: 1,
    maxSideboard: 0,
    commander: true,
  },
};

const ALIASES: Record<string, string> = {
  explorer: 'pioneer',
  'standard brawl': 'standardbrawl',
  'standard-brawl': 'standardbrawl',
  'historic brawl': 'brawl',
  historicbrawl: 'brawl',
};

export const FORMAT_NAMES = [...Object.keys(FORMATS), ...Object.keys(ALIASES)];

export function getFormat(name: string): FormatRules {
  const key = name.trim().toLowerCase();
  if (key === 'alchemy') {
    throw new ToolError('unsupported_format', { format: name, reason: 'Alchemy is not supported.' });
  }
  const f = FORMATS[ALIASES[key] ?? key];
  if (!f) throw new ToolError('unknown_format', { format: name, supported: Object.keys(FORMATS) });
  return f;
}
