import { z } from 'zod';
import type { Context } from '../context.js';
import { type FuzzyLookup, parseAndResolve, rawFromDeck, type ResolvedDeck, resolveDeck } from '../core/deck.js';
import { type FormatRules, getFormat } from '../core/formats.js';
import { ToolError } from './result.js';

const entrySchema = z.object({
  qty: z.number().int().min(1),
  name: z.string(),
  oracleId: z.string().optional(),
});

export const deckSchema = z
  .object({
    name: z.string().optional(),
    format: z.string().optional(),
    commander: entrySchema.partial({ qty: true }).optional(),
    companion: entrySchema.partial({ qty: true }).optional(),
    main: z.array(entrySchema),
    side: z.array(entrySchema).optional(),
  })
  .passthrough();

/** Input fields shared by every tool that takes a deck: a parsed deck or raw export text. */
export const deckInput = {
  deck: deckSchema.optional().describe('A deck object as returned by parse_decklist'),
  text: z.string().optional().describe('An MTG Arena export (Deck / Sideboard / Commander sections)'),
};

export const formatInput = z
  .string()
  .describe('Arena format: standard, pioneer (alias explorer), historic, timeless, brawl, standardbrawl');

const fuzzyCache = new Map<string, string | undefined>();

function fuzzyLookup(ctx: Context): FuzzyLookup | undefined {
  if (!ctx.online) return undefined;
  return async (name) => {
    if (fuzzyCache.has(name)) return fuzzyCache.get(name);
    const card = await ctx.scryfall
      .getJson<{ oracle_id?: string }>(`/cards/named?fuzzy=${encodeURIComponent(name)}`)
      .catch(() => undefined);
    fuzzyCache.set(name, card?.oracle_id);
    return card?.oracle_id;
  };
}

export async function loadDeck(
  ctx: Context,
  args: { deck?: z.infer<typeof deckSchema>; text?: string },
): Promise<ResolvedDeck> {
  const index = await ctx.getIndex();
  if (args.text !== undefined && args.text.trim()) return parseAndResolve(args.text, index, fuzzyLookup(ctx));
  if (args.deck) {
    const { raw, ids } = rawFromDeck(args.deck);
    return resolveDeck(raw, index, fuzzyLookup(ctx), ids);
  }
  throw new ToolError('missing_deck', { reason: 'Pass either `text` (an Arena export) or `deck` (from parse_decklist).' });
}

/** The explicit format, else the one recorded on the deck object. */
export function resolveFormat(format: string | undefined, deck?: { format?: string }): FormatRules {
  const f = format ?? deck?.format;
  if (!f) throw new ToolError('missing_format', { reason: 'Pass `format`.' });
  return getFormat(f);
}
