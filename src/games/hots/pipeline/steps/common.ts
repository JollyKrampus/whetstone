/**
 * Shared plumbing for the HotS pipeline steps (one step per source): source statuses with the
 * right `fetchedAt` semantics, schema-checked access to last-good files, and the issue list.
 *
 * Status rules (SPEC §1.8, src/core/freshness.ts):
 *  - ok:       fetched in this run; fetchedAt = now.
 *  - stale:    fetch failed (or was not attempted with --only); last-good data is re-emitted and
 *              fetchedAt keeps the last successful fetch.
 *  - failed:   fetch failed and there is no last-good data for it.
 *  - disabled: switched off (missing key, HP_MODE=off, offline run for keyed sources).
 */
import type { ZodType } from 'zod';
import { isSelected } from '../../../../../pipeline/context.ts';
import type { PipelineContext, SourceState, SourceStatus, ValidationIssue } from '../../../../core/game.ts';
import { HotsMetaSchema, type HotsMeta } from '../../schema.ts';
import { SOURCE_IDS, errorMessage, isoDate, status, warn, type SourceId } from '../util.ts';

export interface RunEnv {
  ctx: PipelineContext;
  now: Date;
  nowIso: string;
  /** UTC date of the run. */
  today: string;
  /** Last-good meta.json, when it still matches the schema. */
  prevMeta: HotsMeta | null;
  issues: ValidationIssue[];
  statuses: Map<SourceId, SourceStatus>;
}

export function createEnv(ctx: PipelineContext): RunEnv {
  const issues: ValidationIssue[] = [];
  let prevMeta: HotsMeta | null = null;
  if (ctx.previousMeta) {
    const parsed = HotsMetaSchema.safeParse(ctx.previousMeta);
    if (parsed.success) prevMeta = parsed.data;
    else issues.push(warn('last-good meta.json does not match the current schema; treating this run as a first run'));
  }
  return { ctx, now: ctx.now, nowIso: ctx.now.toISOString(), today: isoDate(ctx.now), prevMeta, issues, statuses: new Map() };
}

export function prevStatus(env: RunEnv, id: SourceId): SourceStatus | null {
  return env.prevMeta?.sources.find((s) => s.id === id) ?? null;
}

/** fetchedAt of the last successful fetch of a source (kept across stale runs). */
export function lastFetchedAt(env: RunEnv, id: SourceId): string | null {
  return prevStatus(env, id)?.fetchedAt ?? null;
}

export function setStatus(env: RunEnv, id: SourceId, state: SourceState, detail?: string): SourceStatus {
  const fetchedAt = state === 'ok' ? env.nowIso : state === 'disabled' ? null : lastFetchedAt(env, id);
  const s = status(id, state, fetchedAt, detail);
  env.statuses.set(id, s);
  return s;
}

/** ok with an explicit fetchedAt (e.g. an unchanged source that was checked now). */
export function setOk(env: RunEnv, id: SourceId, detail?: string): SourceStatus {
  return setStatus(env, id, 'ok', detail);
}

/**
 * The fetch failed: 'stale' when last-good data stays in use, else 'failed'. Records a warn
 * issue tagged with the source.
 */
export function setFallback(env: RunEnv, id: SourceId, err: unknown, haveLastGood: boolean, what: string): SourceStatus {
  const reason = errorMessage(err);
  env.issues.push(warn(`${id}: ${reason}; ${haveLastGood ? `kept last-good ${what}` : `no last-good ${what} to keep`}`, id));
  return setStatus(env, id, haveLastGood ? 'stale' : 'failed', haveLastGood ? `fetch failed; last-good ${what} kept` : `fetch failed: ${reason}`.slice(0, 300));
}

/** --only: a source that was not selected keeps its previous status and last-good files. */
export function selected(env: RunEnv, id: SourceId): boolean {
  return isSelected(env.ctx, id);
}

export function setNotSelected(env: RunEnv, id: SourceId): SourceStatus {
  const prev = prevStatus(env, id);
  const s = prev ? { ...prev } : status(id, 'stale', null, 'not fetched in this run (--only)');
  env.statuses.set(id, s);
  return s;
}

/** Statuses in module.ts order; sources never touched are reported as failed. */
export function orderedStatuses(env: RunEnv): SourceStatus[] {
  return SOURCE_IDS.map((id) => env.statuses.get(id) ?? status(id, 'failed', lastFetchedAt(env, id), 'not run'));
}

/**
 * Last-good JSON file, validated. A file that no longer matches its schema is ignored with a
 * warning (e.g. after a schema change), which degrades to the "no last-good" path.
 */
export async function previousFile<T>(env: RunEnv, file: string, schema: ZodType<T>): Promise<T | null> {
  let raw: unknown;
  try {
    raw = await env.ctx.previous(file);
  } catch (err) {
    env.issues.push(warn(`could not read last-good ${file}: ${errorMessage(err)}`));
    return null;
  }
  if (raw === null || raw === undefined) return null;
  const parsed = schema.safeParse(raw);
  if (parsed.success) return parsed.data;
  env.issues.push(warn(`last-good ${file} does not match its schema; ignored (${parsed.error.issues[0]?.message ?? 'invalid'})`));
  return null;
}

/** Last-good binary file (images), or null. */
export async function previousBytes(env: RunEnv, file: string): Promise<Uint8Array | null> {
  try {
    const raw = await env.ctx.previous(file);
    return raw instanceof Uint8Array ? raw : null;
  } catch {
    return null;
  }
}

/** Runs `fn` over `items` with at most `limit` in flight; results keep input order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}
