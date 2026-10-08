import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { suggestUpgrades } from '../core/suggest.js';
import { wildcardCost } from '../core/wildcards.js';
import { deckInput, formatInput, loadDeck, resolveFormat } from './deckInput.js';
import { asOfDate, metaContext, metaInput } from './metaInput.js';
import { guarded } from './result.js';

const count = z.number().int().min(0);

export function registerUpgradeTools(server: McpServer, ctx: Context) {
  server.registerTool(
    'suggest_upgrades',
    {
      title: 'Suggest upgrades',
      description:
        'Suggest swaps (cut X, add Y) using cards legal in the format, on Arena, within the deck colors, filling the ' +
        "same role at a similar mana value. `competitive` weighs meta presence heavily; `casual` weighs role fit and " +
        'penalizes wildcard cost. Picks the best value per wildcard and never exceeds `wildcards` (a rarity left out ' +
        'of `wildcards` is unlimited).',
      inputSchema: {
        ...deckInput,
        format: formatInput.optional(),
        mode: z.enum(['casual', 'competitive']),
        wildcards: z
          .object({ mythic: count.optional(), rare: count.optional(), uncommon: count.optional(), common: count.optional() })
          .optional(),
        maxSwaps: z.number().int().min(1).max(20).optional().describe('Default 5'),
        keepCards: z.array(z.string()).optional().describe('Card names that must not be cut'),
        meta: metaInput,
      },
    },
    guarded(async (args) => {
      const fmt = resolveFormat(args.format, args.deck);
      const deck = await loadDeck(ctx, args);
      const index = await ctx.getIndex();
      const meta = await metaContext(args.meta, index);
      const result = suggestUpgrades(deck, fmt, index, {
        mode: args.mode,
        wildcards: args.wildcards,
        maxSwaps: args.maxSwaps,
        keepCards: args.keepCards,
        meta,
        asOf: asOfDate(index),
      });
      return { format: fmt.id, ...result, unresolved: deck.unresolved };
    }),
  );

  server.registerTool(
    'wildcard_cost',
    {
      title: 'Wildcard cost',
      description:
        'Wildcards needed to craft the deck (main, sideboard, commander), by rarity, pricing each card at its ' +
        'lowest-rarity Arena printing. Basic lands are free.',
      inputSchema: { ...deckInput },
    },
    guarded(async (args) => {
      const deck = await loadDeck(ctx, args);
      return { ...wildcardCost(deck), unresolved: deck.unresolved };
    }),
  );
}
