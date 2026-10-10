import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { suggestUpgrades } from '../core/suggest.js';
import { buildVersions } from '../core/versions.js';
import { wildcardCost } from '../core/wildcards.js';
import { loadPreferences } from '../data/preferences.js';
import { deckInput, formatInput, loadDeck, resolveFormat } from './deckInput.js';
import { asOfDate, metaContext, metaInput } from './metaInput.js';
import { loadRecommendations, recommendationsInput } from './recsInput.js';
import { guarded } from './result.js';

const count = z.number().int().min(0);
const wildcardsInput = z
  .object({ mythic: count.optional(), rare: count.optional(), uncommon: count.optional(), common: count.optional() })
  .optional()
  .describe('Wildcard budget; a rarity left out is unlimited');
const profileInput = z
  .enum(['faithful', 'competitive', 'casual'])
  .describe(
    'faithful = same deck, best available version of each card (same roles and types, same or lower mana value); ' +
      'competitive = as strong as possible, changing as much as needed; casual = friendly to a casual table (no ' +
      'Game Changers, extra turns, land destruction, lock pieces or mass discard)',
  );
const premiumInput = z
  .boolean()
  .optional()
  .describe('Lean toward mythics, rares and pricier cards whenever there is a choice (default from preferences.json)');

export function registerUpgradeTools(server: McpServer, ctx: Context) {
  const premiumDefault = () => loadPreferences(ctx.configDir).preferPremium ?? false;

  server.registerTool(
    'suggest_upgrades',
    {
      title: 'Suggest upgrades',
      description:
        'Suggest swaps (cut X, add Y) using cards legal in the format, on Arena, within the deck colors, filling the ' +
        'same role at a similar mana value. Every swap is checked against the format rules (copy limits, color ' +
        'identity, companion conditions, legality) and dropped if it would break one. Pass `profile` for one of the ' +
        'three deck versions, or `mode` + `intensity` for a custom pass. In Brawl every added card must support the ' +
        "commander's theme. Never exceeds `wildcards`.",
      inputSchema: {
        ...deckInput,
        format: formatInput.optional(),
        profile: profileInput.optional(),
        mode: z.enum(['casual', 'competitive']).optional().describe('Scoring mode when no profile is given (default competitive)'),
        preferPremium: premiumInput,
        wildcards: wildcardsInput,
        maxSwaps: z.number().int().min(1).max(60).optional().describe('Default 5, or the profile’s'),
        intensity: z
          .enum(['light', 'normal', 'heavy'])
          .optional()
          .describe('How much the deck may change: light ≈7% of cards, normal ≈15% (default), heavy ≈30%'),
        maxChangePercent: z.number().min(1).max(100).optional().describe('Overrides the intensity or profile cap'),
        keepCards: z.array(z.string()).optional().describe('Card names that must not be cut'),
        meta: metaInput,
        recommendations: recommendationsInput,
      },
    },
    guarded(async (args) => {
      const fmt = resolveFormat(args.format, args.deck);
      const deck = await loadDeck(ctx, args);
      const index = await ctx.getIndex();
      const { meta, source } = await metaContext(ctx, args.meta, index, fmt.id);
      const { recs, summary } = loadRecommendations(args.recommendations, index, deck, fmt.legalityKey);
      const result = suggestUpgrades(deck, fmt, index, {
        recommendations: recs,
        profile: args.profile,
        mode: args.mode,
        preferPremium: args.preferPremium ?? premiumDefault(),
        wildcards: args.wildcards,
        maxSwaps: args.maxSwaps,
        intensity: args.intensity,
        maxChangePercent: args.maxChangePercent,
        keepCards: args.keepCards,
        meta,
        asOf: asOfDate(index),
      });
      return { format: fmt.id, metaSource: source, recommendations: summary, ...result, unresolved: deck.unresolved };
    }),
  );

  server.registerTool(
    'build_versions',
    {
      title: 'Build deck versions',
      description:
        'Build up to three versions of a deck in one call: "Same deck, best cards" (faithful: same roles, card ' +
        'types and tribes, same or lower mana value, tapped/off-color lands fixed), "Most competitive" (changes as ' +
        'much as needed) and "Friendly casual" (swaps out Game Changers, extra turns, land destruction, lock pieces ' +
        'and mass discard). Each comes with its swaps and reasons, wildcard cost, power rating before and after, a ' +
        'legality check, and an MTG Arena import of the finished deck.',
      inputSchema: {
        ...deckInput,
        format: formatInput.optional(),
        profiles: z.array(profileInput).optional().describe('Which versions to build (default all three)'),
        preferPremium: premiumInput,
        wildcards: wildcardsInput,
        keepCards: z.array(z.string()).optional().describe('Card names no version may cut'),
        meta: metaInput,
        recommendations: recommendationsInput,
      },
    },
    guarded(async (args) => {
      const fmt = resolveFormat(args.format, args.deck);
      const deck = await loadDeck(ctx, args);
      const index = await ctx.getIndex();
      const { meta, source } = await metaContext(ctx, args.meta, index, fmt.id);
      const { recs, summary } = loadRecommendations(args.recommendations, index, deck, fmt.legalityKey);
      const versions = buildVersions(deck, fmt, index, {
        profiles: args.profiles,
        preferPremium: args.preferPremium ?? premiumDefault(),
        keepCards: args.keepCards,
        wildcards: args.wildcards,
        meta,
        recommendations: recs,
        asOf: asOfDate(index),
      });
      return { format: fmt.id, metaSource: source, recommendations: summary, versions, unresolved: deck.unresolved };
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
