/**
 * Blizzard TACT version server responses (hots-static.md §5.1): a pipe-delimited table
 *
 *   Region!STRING:0|BuildConfig!HEX:16|CDNConfig!HEX:16|KeyRing!HEX:16|BuildId!DEC:4|VersionsName!String:0|ProductConfig!HEX:16
 *   ## seqn = 4058626
 *   us|a64c…|9575…||98348|2.57.0.98348|a0c5…
 *
 * The `cn` row is frozen at an old build and ignored. Pure.
 */
import { BUILD_RE, compareBuilds } from '../util.ts';

export interface TactRow {
  region: string;
  build: string;
}

export function parseTactTable(text: string): TactRow[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('##'));
  const header = lines.shift();
  if (!header) return [];
  const cols = header.split('|').map((c) => c.split('!')[0]?.trim().toLowerCase() ?? '');
  const regionIdx = cols.indexOf('region');
  const versionIdx = cols.indexOf('versionsname');
  if (regionIdx < 0 || versionIdx < 0) throw new Error('TACT table has no Region/VersionsName columns');
  const rows: TactRow[] = [];
  for (const line of lines) {
    const cells = line.split('|');
    const region = (cells[regionIdx] ?? '').trim().toLowerCase();
    const build = (cells[versionIdx] ?? '').trim();
    if (region && BUILD_RE.test(build)) rows.push({ region, build });
  }
  return rows;
}

/**
 * The live build: the `us` row, else the most common build among non-`cn` regions (ties → newest).
 * Throws when the table has no usable row.
 */
export function tactBuild(text: string): string {
  const rows = parseTactTable(text).filter((r) => r.region !== 'cn');
  if (rows.length === 0) throw new Error('TACT response has no region rows');
  const us = rows.find((r) => r.region === 'us');
  if (us) return us.build;
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.build, (counts.get(r.build) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || compareBuilds(b[0], a[0]))[0]?.[0] as string;
}
