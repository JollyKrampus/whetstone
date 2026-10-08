import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerTunePrompt(server: McpServer) {
  server.registerPrompt(
    'tune_my_deck',
    {
      title: 'Tune my deck',
      description: 'Walk through parse → validate → analyze → rate → meta research → compare → suggest for an Arena deck.',
      argsSchema: {
        decklist: z.string().describe('The MTG Arena export'),
        format: z.string().describe('standard, pioneer, historic, timeless, brawl or standardbrawl'),
        goal: z.string().optional().describe('"casual" or "competitive" (default competitive)'),
        budget: z.string().optional().describe('Wildcards available, e.g. "4 rares, 2 mythics"'),
      },
    },
    ({ decklist, format, goal, budget }) => {
      const mode = goal?.toLowerCase().startsWith('casual') ? 'casual' : 'competitive';
      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: [
                `Help me tune this ${format} deck for ${mode} play${budget ? ` with a budget of ${budget}` : ''}.`,
                '',
                'Use the Grindstone tools in this order:',
                '1. parse_decklist: fix or ask me about anything in `unresolved`.',
                '2. validate_deck: list every legality problem first.',
                '3. analyze_deck: summarize the curve, mana (quote any Karsten shortfalls) and roles.',
                '4. rate_power: give the tier and the weakest dimensions with their reasons.',
                ...(/brawl/i.test(format)
                  ? [
                      "   For Brawl, ask me to paste my commander's EDHREC page (or any recommendation list). Don't fetch " +
                        'EDHREC yourself; its terms forbid automated access. Pass what I paste as `recommendations` to ' +
                        'rate_power and suggest_upgrades.',
                    ]
                  : []),
                `5. Search the web for the current ${format} metagame on MTG Arena and collect 3-8 recent top decklists ` +
                  'in Arena export format, with meta share and win rate where available. Only use sites that allow it, and say where the lists came from.',
                '6. compare_to_meta with those lists as metaLists, then rate_power again with them as meta.',
                `7. suggest_upgrades in ${mode} mode${budget ? ', converting my budget into the wildcards object' : ''}, with the same meta lists.`,
                '',
                'Finish with: the current tier, the recommended swaps with reasons and wildcard cost, and what the deck would still be weak against.',
                'Keep the math from the tools; do your own reasoning only for the narrative.',
                '',
                'Decklist:',
                decklist,
              ].join('\n'),
            },
          },
        ],
      };
    },
  );
}
