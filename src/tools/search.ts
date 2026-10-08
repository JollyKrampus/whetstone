import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { summarize } from '../core/cards.js';
import { searchCards } from '../core/search.js';
import type { Context } from '../context.js';
import { guarded } from './result.js';

export function registerSearch(server: McpServer, ctx: Context) {
  server.registerTool(
    'search_cards',
    {
      title: 'Search cards',
      description:
        'Search the local card index with a subset of Scryfall syntax: words (name), t:, o:, kw:, c:, id:/ci: (id<=rg), ' +
        'mv/cmc with < <= = >= >, pow, tou, r:, f:/legal:<format>, banned:, game:arena, is:<flag>, year, produces:, ' +
        '"or", parentheses and -negation. With `format`, results are limited to cards legal in it and on Arena.',
      inputSchema: {
        query: z.string().min(1).describe('Scryfall-style query, e.g. `t:creature id<=rw mv<=2 o:haste`'),
        format: z.string().optional().describe('Arena format: standard, pioneer (explorer), historic, timeless, brawl, standardbrawl'),
        limit: z.number().int().min(1).max(200).optional().describe('Max cards returned (default 50)'),
        order: z.enum(['name', 'mv', 'edhrec', 'released']).optional(),
      },
    },
    guarded(async ({ query, format, limit, order }) => {
      const index = await ctx.getIndex();
      const { total, cards } = searchCards(index, query, { format, limit, order });
      return { snapshot: index.meta.snapshot, total, returned: cards.length, cards: cards.map(summarize) };
    }),
  );
}
