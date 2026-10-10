import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { countCards, playEntries, toPublicDeck } from '../core/deck.js';
import { getFormat } from '../core/formats.js';
import { validateDeck } from '../core/validate.js';
import { deckInput, formatInput, loadDeck, resolveFormat } from './deckInput.js';
import { guarded } from './result.js';

export function registerDeckTools(server: McpServer, ctx: Context) {
  server.registerTool(
    'parse_decklist',
    {
      title: 'Parse decklist',
      description:
        'Parse an MTG Arena export into a deck with every card resolved by name. Lines that cannot be resolved ' +
        '(typos, Alchemy A- cards) are listed in `unresolved` with a reason and suggestions.',
      inputSchema: {
        text: z.string().describe('The Arena export text'),
        format: formatInput.optional(),
      },
    },
    guarded(async ({ text, format }) => {
      const deck = await loadDeck(ctx, { text });
      if (format) deck.format = getFormat(format).id;
      const index = await ctx.getIndex();
      return {
        snapshot: index.meta.snapshot,
        counts: { main: countCards(playEntries(deck)), side: countCards(deck.side) },
        deck: toPublicDeck(deck),
      };
    }),
  );

  server.registerTool(
    'validate_deck',
    {
      title: 'Validate deck',
      description:
        'Check a deck against an Arena format: deck and sideboard size, copy limits (singleton for Brawl), ' +
        'banned/restricted cards, Arena availability, and commander color identity.',
      inputSchema: { ...deckInput, format: formatInput.optional() },
    },
    guarded(async (args) => {
      const fmt = resolveFormat(args.format, args.deck);
      const deck = await loadDeck(ctx, args);
      return validateDeck(deck, fmt);
    }),
  );
}
