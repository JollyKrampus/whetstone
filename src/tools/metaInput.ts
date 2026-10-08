import { z } from 'zod';
import type { Context } from '../context.js';
import type { CardIndex } from '../core/cards.js';
import { buildMeta, loadSnapshot, type MetaContext, type MetaListInput } from '../core/meta.js';

export const metaListSchema = z.object({
  name: z.string().optional(),
  archetype: z.string().optional(),
  list: z.string().describe('The decklist as an Arena export'),
  winRate: z.number().optional(),
  metaShare: z.number().min(0).optional().describe('Share of the metagame, 0-1 or a percentage'),
});

export const metaInput = z
  .array(metaListSchema)
  .optional()
  .describe(
    'Current meta decklists (e.g. found by web search), with optional win rate and meta share. When omitted, ' +
      'a local snapshot at <config dir>/meta/<format>.json is used if present.',
  );

export interface ResolvedMeta {
  meta?: MetaContext;
  /** "supplied", "snapshot: <path>", or "none". */
  source: string;
}

/** Supplied lists win; otherwise the local snapshot for the format; otherwise none. */
export async function metaContext(
  ctx: Context,
  inputs: MetaListInput[] | undefined,
  index: CardIndex,
  format: string,
): Promise<ResolvedMeta> {
  if (inputs?.length) return { meta: await buildMeta(inputs, index), source: 'supplied' };
  const snap = loadSnapshot(ctx.configDir, format);
  if (snap) return { meta: await buildMeta(snap.snapshot.decks, index), source: `snapshot: ${snap.path}` };
  return { source: 'none' };
}

/** The data snapshot date (YYYY-MM-DD), used instead of "today" so results are reproducible. */
export function asOfDate(index: CardIndex): string {
  for (const candidate of [index.meta.snapshot, index.meta.builtAt]) {
    const t = Date.parse(candidate);
    if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  }
  return '2026-01-01';
}
