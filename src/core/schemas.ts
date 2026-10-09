/**
 * Zod mirrors of the shared contracts in ./game.ts plus small building blocks reused by every
 * game's schema.ts. Browser-safe (zod only).
 *
 * Optional keys use `.exactOptional()` so inferred types match game.ts under
 * `exactOptionalPropertyTypes`: a key is either absent or holds a real value. Producers must
 * omit absent keys instead of writing `undefined` (JSON.stringify does that already); validate
 * with `parseData`, which round-trips through JSON first.
 */
import { z } from 'zod';
import type {
  CustodyClass,
  Edge,
  EdgeSource,
  GameId,
  GameMeta,
  Reason,
  ReasonKind,
  SourceState,
  SourceStatus,
} from './game.ts';

// ---- primitives ------------------------------------------------------------------------

/** ISO-8601 timestamp with `Z` or an offset, e.g. `2026-10-08T10:17:00Z`. */
export const IsoDateTime = z.iso.datetime({ offset: true });
/** Calendar date `YYYY-MM-DD`. */
export const IsoDate = z.iso.date();
/** Lowercase kebab-case slug (`cursed-hollow`) or a lowercase alphanumeric id (`liming`). */
export const Slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'expected a lowercase kebab-case slug');
/** Absolute http(s) URL. */
export const Url = z.url({ protocol: /^https?$/ });
/** Probability / share in [0, 1]. */
export const Rate = z.number().min(0).max(1);
/** Non-negative integer count. */
export const Count = z.number().int().nonnegative();
/** Relative POSIX path inside a game's data dir (no leading slash, no `..`). */
export const DataPath = z
  .string()
  .regex(/^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\-/]+$/, 'expected a relative path inside the data dir');

export const GameIdSchema = z.enum(['hots', 'mtga', 'pokemon']);
export const CustodyClassSchema = z.enum(['A', 'A-SA', 'B', 'C']);

// ---- Reason / Edge ---------------------------------------------------------------------

export const ReasonKindSchema = z.enum(['stat', 'theory', 'curated', 'role', 'map', 'votes', 'pro', 'usage']);

export const ReasonSchema = z.strictObject({
  kind: ReasonKindSchema,
  text: z.string().min(1),
  n: z.number().nonnegative().exactOptional(),
  /** Percentage points. */
  delta: z.number().exactOptional(),
  source: z.string().min(1).exactOptional(),
  evidence: z.array(z.string().min(1)).exactOptional(),
});

export const EdgeSourceSchema = z.enum(['stats', 'theory', 'curated', 'votes', 'usage', 'replays']);

/** 1..100, 50 = neutral (SPEC §6: round(50 + 50·tanh(x))). */
export const Score = z.number().int().min(1).max(100);

export const EdgeSchema = z.strictObject({
  a: z.string().min(1),
  b: z.string().min(1),
  score: Score,
  /** Percentage points. */
  delta: z.number().exactOptional(),
  /** Sample size; may be fractional for weighted sources (Smogon checks). */
  n: z.number().nonnegative().exactOptional(),
  z: z.number().exactOptional(),
  source: EdgeSourceSchema,
  reasons: z.array(ReasonSchema),
});

// ---- meta.json -------------------------------------------------------------------------

export const SourceStateSchema = z.enum(['ok', 'stale', 'failed', 'disabled']);

export const SourceStatusSchema = z.strictObject({
  id: z.string().min(1),
  fetchedAt: IsoDateTime.nullable(),
  status: SourceStateSchema,
  detail: z.string().exactOptional(),
});

export const VersionSchema = z.strictObject({
  label: z.string().min(1),
  build: z.string().min(1).exactOptional(),
  since: IsoDate.exactOptional(),
});

/** Builds the meta.json schema of one game, with its game-specific `extra` block made required. */
export function gameMetaSchema<G extends GameId, E extends z.ZodType<Record<string, unknown>>>(game: G, extra: E) {
  return z.strictObject({
    game: z.literal(game),
    schema: z.number().int().positive(),
    version: VersionSchema,
    generatedAt: IsoDateTime,
    dataHash: z.string().min(8),
    sources: z.array(SourceStatusSchema),
    counts: z.record(z.string(), Count),
    extra,
  });
}

/** Generic meta.json (unknown game extras). */
export const GameMetaSchema = z.strictObject({
  game: GameIdSchema,
  schema: z.number().int().positive(),
  version: VersionSchema,
  generatedAt: IsoDateTime,
  dataHash: z.string().min(8),
  sources: z.array(SourceStatusSchema),
  counts: z.record(z.string(), Count),
  extra: z.record(z.string(), z.unknown()).exactOptional(),
});

// ---- attribution carried inside data files ---------------------------------------------

/** Credit that must travel with a file (share-alike, CC BY, synthetic markers...). */
export const FileAttributionSchema = z.strictObject({
  /** SourceRef.id */
  source: z.string().min(1),
  /** Exact credit text to render. */
  text: z.string().min(1),
  url: Url,
  license: z.string().min(1).exactOptional(),
  licenseUrl: Url.exactOptional(),
});

// ---- contract checks -------------------------------------------------------------------

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/**
 * Compile-time proof that the zod mirrors match game.ts in both directions. If game.ts
 * changes, `tsc` fails here instead of at a distant call site.
 */
export const CONTRACT_MIRRORS_MATCH: [
  Same<z.infer<typeof ReasonSchema>, Reason>,
  Same<z.infer<typeof EdgeSchema>, Edge>,
  Same<z.infer<typeof SourceStatusSchema>, SourceStatus>,
  Same<z.infer<typeof GameMetaSchema>, GameMeta>,
  Same<z.infer<typeof ReasonKindSchema>, ReasonKind>,
  Same<z.infer<typeof EdgeSourceSchema>, EdgeSource>,
  Same<z.infer<typeof SourceStateSchema>, SourceState>,
  Same<z.infer<typeof CustodyClassSchema>, CustodyClass>,
  Same<z.infer<typeof GameIdSchema>, GameId>,
] = [true, true, true, true, true, true, true, true, true];

// ---- validation helpers ----------------------------------------------------------------

/** Error thrown when a data or curated file does not match its schema. */
export class DataValidationError extends Error {
  readonly where: string;
  readonly issues: z.core.$ZodIssue[];
  constructor(where: string, error: z.ZodError) {
    super(`Invalid data in ${where}:\n${z.prettifyError(error)}`);
    this.name = 'DataValidationError';
    this.where = where;
    this.issues = error.issues;
  }
}

/**
 * Validates `value` against `schema`, throwing a DataValidationError that names `where`
 * (usually the file path). By default the value is JSON round-tripped first, so in-memory
 * objects built by the pipeline are checked exactly as they will be written (undefined keys
 * dropped). Loaders pass `roundTrip: false` for values that came straight from JSON.parse.
 */
export function parseData<S extends z.ZodType>(
  schema: S,
  value: unknown,
  where: string,
  opts: { roundTrip?: boolean } = {},
): z.output<S> {
  const plain: unknown = opts.roundTrip === false || value === undefined ? value : JSON.parse(JSON.stringify(value));
  const result = schema.safeParse(plain);
  if (!result.success) throw new DataValidationError(where, result.error);
  return result.data;
}

/** Where a game's loader reads JSON from (wired to src/lib/datadir.ts by each load.ts). */
export interface JsonSource {
  /** Parsed JSON, or null when the file is absent and `optional` is set. */
  read(file: string, opts: { optional: boolean }): unknown;
  /** Full path used in error messages. */
  where(file: string): string;
}

/**
 * Memoized, validated reads over a JsonSource. Kept free of Node imports so this module stays
 * browser-safe; the fs side lives in src/lib/datadir.ts.
 */
export function createCachedLoader(source: JsonSource) {
  const memo = new Map<string, unknown>();
  function read<S extends z.ZodType>(file: string, schema: S, optional: boolean): z.output<S> | null {
    if (memo.has(file)) return memo.get(file) as z.output<S> | null;
    const raw = source.read(file, { optional });
    const value = raw === null || raw === undefined ? null : parseData(schema, raw, source.where(file), { roundTrip: false });
    memo.set(file, value);
    return value;
  }
  return {
    required<S extends z.ZodType>(file: string, schema: S): z.output<S> {
      const v = read(file, schema, false);
      if (v === null) throw new Error(`Missing data file ${source.where(file)}`);
      return v;
    },
    optional<S extends z.ZodType>(file: string, schema: S): z.output<S> | null {
      return read(file, schema, true);
    },
    /** Forget cached values (dev server reloads, tests). */
    clear(): void {
      memo.clear();
    },
  };
}

/** Adds an issue for every value that occurs more than once in `values`. */
export function checkUnique(
  ctx: z.core.$RefinementCtx<unknown>,
  values: readonly string[],
  what: string,
  path: PropertyKey[] = [],
): void {
  const seen = new Set<string>();
  for (const [i, v] of values.entries()) {
    if (seen.has(v)) ctx.addIssue({ code: 'custom', message: `duplicate ${what} "${v}"`, path: [...path, i] });
    seen.add(v);
  }
}
