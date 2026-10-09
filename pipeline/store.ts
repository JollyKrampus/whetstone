/**
 * File-system helpers for the data directory. All paths handed in or out as "relative" are POSIX
 * (forward slashes) so outputs, hashes and indexes are identical on Windows and Linux.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import type { OutputFile } from '../src/core/game.ts';
import { compareStrings, jsonBytes } from './hash.ts';

export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/**
 * True for a normalized relative POSIX path that stays inside its base directory. Rejects
 * absolute paths, drive letters, backslashes, empty or dot segments and "..".
 */
export function isSafeRelPath(rel: string): boolean {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 400) return false;
  if (rel.includes('\\') || rel.includes('\0') || rel.startsWith('/') || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

/** Join a base directory and a validated relative POSIX path. */
export function resolveRel(base: string, rel: string): string {
  if (!isSafeRelPath(rel)) throw new Error(`Unsafe relative path: ${JSON.stringify(rel)}`);
  return path.join(base, ...rel.split('/'));
}

/** Recursively list files under `dir` as sorted POSIX relative paths ([] when missing). */
export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (abs: string, rel: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const childAbs = path.join(abs, entry.name);
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(childAbs, childRel);
      else if (entry.isFile()) out.push(childRel);
    }
  };
  walk(dir, '');
  return out.sort(compareStrings);
}

export function readBytes(file: string): Uint8Array | null {
  return existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
}

export function readJson<T = unknown>(file: string): T | null {
  if (!existsSync(file)) return null;
  const text = readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text) as T;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && Buffer.compare(a, b) === 0;
}

/** Write only when content differs, so unchanged files keep their mtime. Returns true when written. */
export function writeIfChanged(file: string, bytes: Uint8Array): boolean {
  const current = readBytes(file);
  if (current && sameBytes(current, bytes)) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, bytes);
  return true;
}

export function writeJsonFile(file: string, data: unknown, pretty = true): boolean {
  return writeIfChanged(file, jsonBytes(data, pretty));
}

export function removeTree(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/** Remove empty directories below (and including, if `includeRoot`) `dir`. */
export function pruneEmptyDirs(dir: string, includeRoot = false): void {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) pruneEmptyDirs(path.join(dir, entry.name), true);
  }
  if (includeRoot && readdirSync(dir).length === 0) rmdirSync(dir);
}

/** Copy every file of `src` into `dst` (merging), returning the copied relative paths. */
export function copyTree(src: string, dst: string): string[] {
  const files = listFiles(src);
  for (const rel of files) {
    const target = resolveRel(dst, rel);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(resolveRel(src, rel)));
  }
  return files;
}

/**
 * Bytes the pipeline writes for an OutputFile: raw bytes when given, else JSON with sorted keys
 * and a trailing newline. Browser shards under `public/` are compact; everything else is
 * indented so the data branch diffs line by line.
 */
export function serializeOutput(file: Pick<OutputFile, 'path' | 'data' | 'bytes'>): Uint8Array {
  if (file.bytes) return file.bytes;
  return jsonBytes(file.data, !file.path.startsWith('public/'));
}

export interface SyncResult {
  written: string[];
  removed: string[];
  unchanged: string[];
}

/**
 * Make `dir` contain exactly `files`, except existing paths for which `keep(rel)` is true.
 * Untouched files keep their bytes and mtime; files no longer emitted are deleted.
 */
export function syncTree(dir: string, files: ReadonlyMap<string, Uint8Array>, keep: (rel: string) => boolean = () => false): SyncResult {
  const result: SyncResult = { written: [], removed: [], unchanged: [] };
  for (const rel of listFiles(dir)) {
    if (!files.has(rel) && !keep(rel)) {
      rmSync(resolveRel(dir, rel), { force: true });
      result.removed.push(rel);
    }
  }
  for (const rel of [...files.keys()].sort(compareStrings)) {
    const bytes = files.get(rel) as Uint8Array;
    if (writeIfChanged(resolveRel(dir, rel), bytes)) result.written.push(rel);
    else result.unchanged.push(rel);
  }
  pruneEmptyDirs(dir);
  return result;
}

/**
 * gzip with a platform-independent header. zlib stamps the OS byte (10 on Windows, 3 on Unix),
 * which would make history files differ between a dev machine and CI.
 */
export function gzipDeterministic(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(gzipSync(bytes, { level: 9 }));
  out[9] = 3;
  return out;
}

/** UTC calendar parts of a date, zero-padded. */
export function utcParts(date: Date): { yyyy: string; mm: string; dd: string } {
  const iso = date.toISOString();
  return { yyyy: iso.slice(0, 4), mm: iso.slice(5, 7), dd: iso.slice(8, 10) };
}
