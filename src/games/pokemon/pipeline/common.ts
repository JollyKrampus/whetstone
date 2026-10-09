/**
 * Shared plumbing for the Pokémon sources: what a source hands back to index.ts, status
 * helpers with consistent last-good semantics, and validated reads of previous files.
 *
 * Status rules (meta.sources, read by src/core/freshness.ts):
 *  - ok:      fetched (or confirmed unchanged upstream) in this run; fetchedAt = now.
 *  - failed:  this run's fetch or validation failed; fetchedAt is the last-good time, and the
 *             last-good files are re-emitted when they exist (null fetchedAt = nothing to show).
 *  - stale:   not fetched in this run by choice (`--only`); last-good files re-emitted.
 */
import type { z } from 'zod';
import type { OutputFile, PipelineContext, SourceStatus, ValidationIssue } from '../../../core/game.ts';
import { validateFiles } from '../../../../pipeline/validate.ts';
import { POKEMON_FILES } from '../schema.ts';

export const SOURCE_IDS = ['showdown', 'smogon', 'limitless', 'showdown-replays', 'smogon-calc'] as const;
export type SourceId = (typeof SOURCE_IDS)[number];

export interface SourceOutcome {
  status: SourceStatus;
  files: OutputFile[];
  issues: ValidationIssue[];
  /** Regulation the emitted data belongs to (drives meta.extra.warmingUp). */
  regulation?: string;
  counts?: Record<string, number>;
}

export function lastFetchedAt(ctx: PipelineContext, id: string): string | null {
  return ctx.previousMeta?.sources.find((s) => s.id === id)?.fetchedAt ?? null;
}

export function ok(ctx: PipelineContext, id: SourceId, detail?: string): SourceStatus {
  return detail ? { id, fetchedAt: ctx.now.toISOString(), status: 'ok', detail } : { id, fetchedAt: ctx.now.toISOString(), status: 'ok' };
}

export function failed(ctx: PipelineContext, id: SourceId, detail: string, kept: boolean): SourceStatus {
  return { id, fetchedAt: kept ? lastFetchedAt(ctx, id) : null, status: 'failed', detail };
}

/** Source not selected with --only: keep its last-good status and files. */
export function notSelected(ctx: PipelineContext, id: SourceId): SourceStatus {
  const prev = ctx.previousMeta?.sources.find((s) => s.id === id);
  return { id, fetchedAt: prev?.fetchedAt ?? null, status: prev ? 'stale' : 'disabled', detail: 'not selected in this run (--only)' };
}

export function warn(source: SourceId, message: string): ValidationIssue {
  return { level: 'warn', source, message };
}

export function error(source: SourceId, message: string): ValidationIssue {
  return { level: 'error', source, message };
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A previous (last-good) JSON file parsed with `schema`, or null when absent or no longer valid. */
export async function previousFile<S extends z.ZodType>(ctx: PipelineContext, file: string, schema: S): Promise<z.output<S> | null> {
  const raw = await ctx.previous(file);
  if (raw === null || raw instanceof Uint8Array) return null;
  const parsed = schema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** Schema problems of `files` against POKEMON_FILES, attributed to `source`. */
export function invalid(files: readonly OutputFile[], source: SourceId): ValidationIssue[] {
  return validateFiles(files, POKEMON_FILES, { source });
}

export const json = (path: string, data: unknown): OutputFile => ({ path, data, custody: 'A' });

/** ISO date (YYYY-MM-DD) of a moment. */
export function isoDate(t: Date | number): string {
  return new Date(t).toISOString().slice(0, 10);
}
