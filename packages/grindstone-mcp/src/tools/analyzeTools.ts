import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Context } from '../context.js';
import { analyzeDeck } from '../core/analyze.js';
import { deckInput, formatInput, loadDeck, resolveFormat } from './deckInput.js';
import { guarded } from './result.js';

export function registerAnalyzeTools(server: McpServer, ctx: Context) {
  server.registerTool(
    'analyze_deck',
    {
      title: 'Analyze deck',
      description:
        'Deck statistics: mana curve of nonland cards, average mana value, land count, colored pips versus colored ' +
        "sources checked against Frank Karsten's source-count table, tapped lands, type breakdown, card roles " +
        '(each card lists the rule that tagged it so you can audit it) and interaction count.',
      inputSchema: { ...deckInput, format: formatInput.optional() },
    },
    guarded(async (args) => {
      const fmt = resolveFormat(args.format, args.deck);
      const deck = await loadDeck(ctx, args);
      return { ...analyzeDeck(deck, fmt), unresolved: deck.unresolved };
    }),
  );
}
