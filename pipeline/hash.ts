/**
 * Deterministic serialization and hashing. Everything the pipeline writes or compares goes
 * through here so that the same inputs always produce byte-identical outputs (SPEC §1.10).
 */
import { createHash } from 'node:crypto';

/** Locale-independent ordering (UTF-16 code units). `localeCompare` depends on ICU data and must not be used for output order. */
export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isDropped(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

function normalize(value: unknown, stack: Set<object>): unknown {
  if (typeof value === 'bigint') throw new TypeError('BigInt values are not JSON-serializable');
  if (value === null || typeof value !== 'object') return value;
  const withToJson = value as { toJSON?: () => unknown };
  if (typeof withToJson.toJSON === 'function') return normalize(withToJson.toJSON(), stack);
  if (stack.has(value)) throw new TypeError('Cannot serialize a circular structure');
  stack.add(value);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item) => {
      const n = normalize(item, stack);
      return isDropped(n) ? null : n;
    });
  } else {
    const obj: Record<string, unknown> = {};
    const source = value as Record<string, unknown>;
    for (const key of Object.keys(source).sort(compareStrings)) {
      const n = normalize(source[key], stack);
      if (!isDropped(n)) obj[key] = n;
    }
    out = obj;
  }
  stack.delete(value);
  return out;
}

/**
 * JSON.stringify with recursively sorted object keys. Arrays keep their order (producers sort
 * them). Value semantics match JSON.stringify (undefined dropped, NaN/Infinity become null).
 */
export function stableStringify(value: unknown, indent?: number): string {
  const json = JSON.stringify(normalize(value, new Set()), null, indent);
  if (json === undefined) throw new TypeError('Value is not JSON-serializable');
  return json;
}

/** UTF-8 JSON bytes with a trailing newline: compact, or 2-space indented when `pretty`. */
export function jsonBytes(value: unknown, pretty: boolean): Uint8Array {
  return new TextEncoder().encode(stableStringify(value, pretty ? 2 : undefined) + '\n');
}

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/** First `length` hex chars of sha256, used for content-hashed file names. */
export function shortHash(data: string | Uint8Array, length = 8): string {
  return sha256(data).slice(0, length);
}

export interface HashEntry {
  /** POSIX relative path, already namespaced by the caller (e.g. "current/heroes.json"). */
  path: string;
  bytes: Uint8Array;
}

/**
 * Hash of a file tree: sha256 over "<path>\0<sha256(content)>\n" lines in path order, plus an
 * optional canonical extra value (e.g. meta.json without timestamps). Path order is enforced
 * here so callers cannot accidentally make the hash depend on directory listing order.
 */
export function hashTree(entries: readonly HashEntry[], extra?: unknown): string {
  const h = createHash('sha256');
  const sorted = [...entries].sort((x, y) => compareStrings(x.path, y.path));
  for (const e of sorted) h.update(`${e.path}\0${sha256(e.bytes)}\n`);
  if (extra !== undefined) h.update(`\0extra\0${stableStringify(extra)}`);
  return h.digest('hex');
}
