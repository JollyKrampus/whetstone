import { z } from 'zod';
import type { CardIndex } from '../core/cards.js';
import type { ResolvedDeck } from '../core/deck.js';
import { parseRecommendations, recommendationSummary, type RecommendationList } from '../core/recs.js';

export const recommendationsInput = z
  .object({
    text: z
      .string()
      .min(1)
      .describe(
        "Text the user pasted, e.g. copied from their commander's EDHREC page or any card list. Card names are " +
          'picked out; "52% of 1234 decks" and "+38% synergy" lines are used when present. Do not fetch EDHREC ' +
          'yourself: its terms forbid automated access, so ask the user to paste it.',
      ),
    commander: z.string().optional().describe('Commander the list is for, to catch mismatches'),
    source: z.string().optional().describe('Where it came from, e.g. "EDHREC, Krenko, Mob Boss page"'),
  })
  .optional()
  .describe('Commander recommendations pasted by the user (most useful for Brawl)');

export function loadRecommendations(
  input: z.infer<typeof recommendationsInput>,
  index: CardIndex,
  deck: ResolvedDeck,
  legalityKey: string,
): { recs?: RecommendationList; summary: ReturnType<typeof recommendationSummary> | null } {
  if (!input) return { summary: null };
  const recs = parseRecommendations(input.text, index, { commander: input.commander, source: input.source });
  return { recs, summary: recommendationSummary(recs, deck, index, legalityKey) };
}
