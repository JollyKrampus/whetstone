/**
 * Validation helpers for game pipelines: run a zod schema over a file and turn failures into
 * ValidationIssue[] the runner understands (any `error` keeps last-good data for the game).
 */
import type { ZodType } from 'zod';
import type { CustodyClass, OutputFile, ValidationIssue } from '../src/core/game.ts';
import { RESERVED_PATHS } from './manifest.ts';

export interface ValidateOptions {
  /** File name shown in messages, e.g. "heroes.json". */
  file: string;
  /** SourceRef.id the data came from, so the runner can mark that source failed. */
  source?: string;
  level?: ValidationIssue['level'];
  /** Cap on issues reported per file; the rest are summarised in one line. */
  max?: number;
}

interface IssueLike {
  path: readonly PropertyKey[];
  message: string;
}

/** `[3].abilities[0].name` style path. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else {
      const key = String(seg);
      out += /^[A-Za-z_$][\w$]*$/.test(key) ? (out ? `.${key}` : key) : `[${JSON.stringify(key)}]`;
    }
  }
  return out || '(root)';
}

export function issue(level: ValidationIssue['level'], message: string, source?: string): ValidationIssue {
  return source === undefined ? { level, message } : { level, source, message };
}

/** Convert zod issues (ZodError.issues) into ValidationIssue[]. */
export function zodIssues(issues: readonly IssueLike[], opts: ValidateOptions): ValidationIssue[] {
  const max = opts.max ?? 20;
  const level = opts.level ?? 'error';
  const out = issues.slice(0, max).map((i) => issue(level, `${opts.file}: ${formatPath(i.path)}: ${i.message}`, opts.source));
  if (issues.length > max) out.push(issue(level, `${opts.file}: ${issues.length - max} more schema issue(s)`, opts.source));
  return out;
}

export type ValidateResult<T> = { ok: true; data: T; issues: [] } | { ok: false; issues: ValidationIssue[] };

/** Validate `data` against `schema`; on success returns the parsed (possibly transformed) value. */
export function validateData<T>(schema: ZodType<T>, data: unknown, opts: ValidateOptions): ValidateResult<T> {
  const parsed = schema.safeParse(data);
  if (parsed.success) return { ok: true, data: parsed.data, issues: [] };
  return { ok: false, issues: zodIssues(parsed.error.issues, opts) };
}

/**
 * Validate every output whose path has a schema. Paths without a schema are ignored, so a game
 * can pass its whole file list.
 */
export function validateOutputs(
  files: readonly OutputFile[],
  schemas: Readonly<Record<string, ZodType>>,
  opts: Omit<ValidateOptions, 'file'> = {},
): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const f of files) {
    const schema = schemas[f.path];
    if (!schema || f.bytes) continue;
    const r = validateData(schema, f.data, { ...opts, file: f.path });
    if (!r.ok) out.push(...r.issues);
  }
  return out;
}

/** One entry of a game's file registry (HOTS_FILES, MTGA_FILES, POKEMON_FILES in src/games/<game>/schema.ts). */
export interface FileSpec {
  schema: ZodType;
  custody: CustodyClass;
}

/**
 * Output path → spec. A `<name>` segment part is a placeholder matching any run of characters
 * other than '/', e.g. 'limited/<SET>.<Format>.json' or 'usage/<format>-<cutoff>.json'.
 */
export type FileRegistry = Readonly<Record<string, FileSpec>>;

const patternCache = new Map<string, RegExp>();

function patternOf(key: string): RegExp {
  let re = patternCache.get(key);
  if (!re) {
    const source = key
      .split(/(<[^<>/]+>)/)
      .map((part) => (/^<[^<>/]+>$/.test(part) ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
      .join('');
    re = new RegExp(`^${source}$`);
    patternCache.set(key, re);
  }
  return re;
}

/** Spec for an output path: an exact key wins over placeholder keys, which are tried in key order. */
export function registryEntry(registry: FileRegistry, path: string): FileSpec | null {
  const exact = registry[path];
  if (exact) return exact;
  for (const key of Object.keys(registry).sort()) {
    if (key.includes('<') && patternOf(key).test(path)) return registry[key] ?? null;
  }
  return null;
}

export interface ValidateFilesOptions {
  /** Private overlays of public shards (e.g. HOTS_PRIVATE_OVERLAYS): same path, class B/C, own schema. */
  overlays?: FileRegistry;
  source?: string;
  max?: number;
}

/**
 * Validate a game's outputs against its file registry: each JSON file must be registered, carry
 * the registry's custody class and match its schema. A class-B/C file whose path is in
 * `overlays` is checked against the overlay spec instead (the stage-time merge pattern). Byte
 * outputs (images) and the runner's reserved files are skipped; unregistered JSON is a warning
 * so a new file is noticed without failing the run.
 */
export function validateFiles(files: readonly OutputFile[], registry: FileRegistry, opts: ValidateFilesOptions = {}): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const f of files) {
    if (f.bytes || RESERVED_PATHS.includes(f.path)) continue;
    const isPrivate = f.custody === 'B' || f.custody === 'C';
    const spec = (isPrivate && opts.overlays ? registryEntry(opts.overlays, f.path) : null) ?? registryEntry(registry, f.path);
    if (!spec) {
      out.push(issue('warn', `${f.path}: no schema registered for this file`, opts.source));
      continue;
    }
    if (spec.custody !== f.custody) {
      out.push(issue('error', `${f.path}: emitted as class ${f.custody} but registered as class ${spec.custody}`, opts.source));
      continue;
    }
    const r = validateData(spec.schema, f.data, { file: f.path, ...(opts.source === undefined ? {} : { source: opts.source }), ...(opts.max === undefined ? {} : { max: opts.max }) });
    if (!r.ok) out.push(...r.issues);
  }
  return out;
}

export interface CountCheck {
  /** What is counted, e.g. "heroes". */
  name: string;
  count: number;
  /** Count in the last-good data (null on first run). */
  previous: number | null;
  /** Fail when the count dropped by more than this percentage (default 10). */
  maxDropPct?: number;
  /** Fail below this absolute count. */
  min?: number;
  source?: string;
}

/** Sanity gate against truncated upstream data: absolute minimum and relative drop vs last-good. */
export function checkCount(c: CountCheck): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  if (c.min !== undefined && c.count < c.min) {
    out.push(issue('error', `${c.name}: ${c.count} is below the minimum of ${c.min}`, c.source));
  }
  const maxDrop = c.maxDropPct ?? 10;
  if (c.previous !== null && c.previous > 0) {
    const dropPct = ((c.previous - c.count) / c.previous) * 100;
    if (dropPct > maxDrop) {
      out.push(issue('error', `${c.name}: dropped from ${c.previous} to ${c.count} (-${dropPct.toFixed(1)}%, limit ${maxDrop}%)`, c.source));
    }
  }
  return out;
}

export function hasErrors(issues: readonly ValidationIssue[]): boolean {
  return issues.some((i) => i.level === 'error');
}
