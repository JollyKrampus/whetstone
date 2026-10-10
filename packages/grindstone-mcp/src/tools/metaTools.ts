import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { compareToMeta } from '../core/meta.js';
import { loadRules, lookupNumber, searchRules } from '../data/rules.js';
import { deckInput, formatInput, loadDeck, resolveFormat } from './deckInput.js';
import { metaContext, metaListSchema } from './metaInput.js';
import { guarded, ToolError } from './result.js';

export function registerMetaTools(server: McpServer, ctx: Context) {
  server.registerTool(
    'compare_to_meta',
    {
      title: 'Compare to meta',
      description:
        'Compare a deck with meta decklists: the closest archetype and its nonland overlap %, the meta core cards ' +
        "this deck is missing, and this deck's unusual inclusions. Pass `metaLists` (e.g. found by web search) or " +
        'keep a snapshot at <config dir>/meta/<format>.json.',
      inputSchema: { ...deckInput, format: formatInput.optional(), metaLists: z.array(metaListSchema).optional() },
    },
    guarded(async (args) => {
      const fmt = resolveFormat(args.format, args.deck);
      const deck = await loadDeck(ctx, args);
      const index = await ctx.getIndex();
      const { meta, source } = await metaContext(ctx, args.metaLists, index, fmt.id);
      if (!meta) {
        throw new ToolError('no_meta', {
          reason: `Pass metaLists, or save a snapshot as ${ctx.configDir}/meta/${fmt.id}.json.`,
        });
      }
      return {
        format: fmt.id,
        metaSource: source,
        ...compareToMeta(deck, meta),
        unresolvedMetaCards: meta.unresolved,
        unresolved: deck.unresolved,
      };
    }),
  );

  server.registerTool(
    'lookup_rule',
    {
      title: 'Look up a rule',
      description:
        'Look up the Magic Comprehensive Rules by number (e.g. "702.19" returns trample and its subrules) or search ' +
        'by keyword (e.g. "trample planeswalker"). Glossary terms are matched too. The rules are downloaded from ' +
        'Wizards on first use and cached for a week.',
      inputSchema: {
        number: z.string().optional().describe('Rule number such as 702.19, 702.19b or 702'),
        query: z.string().optional().describe('Keywords or a glossary term'),
      },
    },
    guarded(async ({ number, query }) => {
      if (!number && !query) throw new ToolError('missing_query', { reason: 'Pass `number` or `query`.' });
      const doc = await loadRules({ dir: ctx.cacheDir, fetch: ctx.fetch, online: ctx.online }).catch((err: Error) => {
        throw new ToolError('rules_unavailable', { reason: err.message });
      });
      const head = { effective: doc.effective ?? null, source: doc.source };
      if (number) {
        const rules = lookupNumber(doc, number);
        if (!rules.length) throw new ToolError('rule_not_found', { number });
        return { ...head, rules };
      }
      return { ...head, ...searchRules(doc, query!) };
    }),
  );
}
