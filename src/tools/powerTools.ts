import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Context } from '../context.js';
import { ratePower } from '../core/power.js';
import { deckInput, formatInput, loadDeck, resolveFormat } from './deckInput.js';
import { asOfDate, metaContext, metaInput } from './metaInput.js';
import { guarded } from './result.js';

export function registerPowerTools(server: McpServer, ctx: Context) {
  server.registerTool(
    'rate_power',
    {
      title: 'Rate power level',
      description:
        'Rate a deck 1-5 (Jank / Casual / Focused / Optimized / Competitive) with a 0-100 score and per-dimension ' +
        'scores and reasons: mana base, speed/curve, interaction, card quality and consistency (Brawl uses its own ' +
        'rubric with commander synergy, ramp and card draw). Card quality is low confidence unless `meta` lists are supplied.',
      inputSchema: { ...deckInput, format: formatInput.optional(), meta: metaInput },
    },
    guarded(async (args) => {
      const fmt = resolveFormat(args.format, args.deck);
      const deck = await loadDeck(ctx, args);
      const index = await ctx.getIndex();
      const meta = await metaContext(args.meta, index);
      const rating = ratePower(deck, fmt, { meta, asOf: asOfDate(index) });
      return { format: fmt.id, ...rating, unresolved: deck.unresolved };
    }),
  );
}
