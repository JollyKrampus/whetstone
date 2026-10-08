import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { type MetaSnapshot, parseSnapshot } from '../core/meta.js';

/** Reads `<config dir>/meta/<format>.json`, or returns null when there is none. */
export function loadSnapshot(configDir: string, format: string): { snapshot: MetaSnapshot; path: string } | null {
  const file = path.join(configDir, 'meta', `${format}.json`);
  if (!existsSync(file)) return null;
  return { snapshot: parseSnapshot(JSON.parse(readFileSync(file, 'utf8')), file), path: file };
}
