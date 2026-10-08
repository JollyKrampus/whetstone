import { randomInt } from 'node:crypto';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { dealSampleHand, simulateHands } from '../core/simulate.js';
import { type Role, ROLES } from '../data/roles.js';
import { deckInput, loadDeck } from './deckInput.js';
import { guarded, ToolError } from './result.js';

const checkSchema = z.object({
  card: z.string().optional().describe('A card name in the deck'),
  role: z.enum(ROLES as [Role, ...Role[]]).optional().describe('Any card with this role'),
  byTurn: z.number().int().min(1).max(20),
});

export function registerSimTools(server: McpServer, ctx: Context) {
  server.registerTool(
    'simulate_hands',
    {
      title: 'Simulate opening hands',
      description:
        'Seeded Monte Carlo report (no game state): keepable-7 rate, London mulligan rate, P(land drops on curve, ' +
        'turns 2-5), P(colors available) per colored card on its mana-value turn, and custom checks such as ' +
        '{ role: "removal", byTurn: 3 }. `bo1Smoothing` approximates Arena\'s best-of-one hand smoother (its exact ' +
        'algorithm is unpublished). Same deck + seed = same numbers.',
      inputSchema: {
        ...deckInput,
        iterations: z.number().int().min(100).max(100_000).optional().describe('Default 10000'),
        seed: z.number().int().optional().describe('Default 1'),
        playDraw: z.enum(['play', 'draw']).optional(),
        bo1Smoothing: z.boolean().optional(),
        checks: z.array(checkSchema).optional(),
      },
    },
    guarded(async (args) => {
      const deck = await loadDeck(ctx, args);
      for (const c of args.checks ?? []) {
        if (!c.card === !c.role) throw new ToolError('bad_check', { reason: 'Each check needs exactly one of `card` or `role`.', check: c });
      }
      return { ...simulateHands(deck, args), unresolved: deck.unresolved };
    }),
  );

  server.registerTool(
    'deal_sample_hand',
    {
      title: 'Deal a sample hand',
      description:
        'Deal one random opening 7 plus the next 3 draws, for "would you keep this?" practice. Stateless; pass the ' +
        'returned seed to see the same hand again.',
      inputSchema: { ...deckInput, seed: z.number().int().optional() },
    },
    guarded(async (args) => {
      const deck = await loadDeck(ctx, args);
      return dealSampleHand(deck, args.seed ?? randomInt(0, 2 ** 31 - 1));
    }),
  );
}
