/**
 * curated/mtga/meta/<format>.json → meta/<format>.json, validated three ways:
 *   1. Whetstone's MetaSnapshotSchema (source URL required unless the deck is an example);
 *   2. grindstone-mcp's own `parseSnapshot`, so the file stays valid grindstone input;
 *   3. every list resolved against the fresh card index (unknown names fail the run; a list
 *      that is no longer legal in its format, e.g. after a rotation or a ban, only warns).
 * Node-only.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { buildMeta, getFormat, parseAndResolve, parseSnapshot, validateDeck, type CardIndex } from 'grindstone-mcp/core';
import type { ValidationIssue } from '../../../core/game.ts';
import { ConstructedFormatSchema, MetaSnapshotSchema, type ConstructedFormat, type MetaSnapshot } from '../schema.ts';

export const CURATED_DIR = path.join('curated', 'mtga', 'meta');
const SOURCE = 'curated-meta';

export interface CuratedResult {
  snapshots: { format: ConstructedFormat; snapshot: MetaSnapshot }[];
  issues: ValidationIssue[];
}

function issue(level: ValidationIssue['level'], message: string): ValidationIssue {
  return { level, source: SOURCE, message };
}

/** Validate one parsed curated file against the schemas and the card index. */
export async function validateSnapshot(file: string, json: unknown, index: CardIndex): Promise<{ snapshot: MetaSnapshot | null; issues: ValidationIssue[] }> {
  const issues: ValidationIssue[] = [];
  const parsed = MetaSnapshotSchema.safeParse(json);
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 10)) issues.push(issue('error', `${file}: ${i.path.join('.') || '(root)'}: ${i.message}`));
    return { snapshot: null, issues };
  }
  const snapshot = parsed.data;
  if (`${snapshot.format}.json` !== path.basename(file)) {
    issues.push(issue('error', `${file}: declares format "${snapshot.format}" but the file name says otherwise`));
  }
  try {
    parseSnapshot(json, file);
  } catch (err) {
    issues.push(issue('error', `${file}: rejected by grindstone parseSnapshot: ${err instanceof Error ? err.message : String(err)}`));
    return { snapshot: null, issues };
  }

  const meta = await buildMeta(snapshot.decks, index);
  for (const u of meta.unresolved) {
    for (const i of u.issues) {
      issues.push(issue('error', `${file}: "${u.list}" line ${i.line ?? '?'}: ${i.reason}${i.text ? ` (${i.text})` : ''}${i.suggestions?.length ? `; did you mean ${i.suggestions.join(', ')}?` : ''}`));
    }
  }
  const fmt = getFormat(snapshot.format);
  for (const d of snapshot.decks) {
    const deck = await parseAndResolve(d.list, index);
    const v = validateDeck(deck, fmt);
    if (!v.legal) {
      const why = v.issues.filter((i) => i.severity === 'error').map((i) => i.message).slice(0, 3).join('; ');
      issues.push(issue('warn', `${file}: "${d.name ?? d.archetype ?? 'deck'}" is not ${fmt.label}-legal with today's card data: ${why}`));
    }
  }
  return { snapshot: issues.some((i) => i.level === 'error') ? null : snapshot, issues };
}

/** Read and validate every curated snapshot under <root>/curated/mtga/meta/, in file-name order. */
export async function loadCurated(root: string, index: CardIndex): Promise<CuratedResult> {
  const dir = path.join(root, CURATED_DIR);
  const out: CuratedResult = { snapshots: [], issues: [] };
  if (!existsSync(dir)) return out;
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const name of files) {
    const rel = `${CURATED_DIR.split(path.sep).join('/')}/${name}`;
    const format = ConstructedFormatSchema.safeParse(name.slice(0, -'.json'.length));
    if (!format.success) {
      out.issues.push(issue('error', `${rel}: file name must be <format>.json for an Arena constructed format`));
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path.join(dir, name), 'utf8'));
    } catch (err) {
      out.issues.push(issue('error', `${rel}: invalid JSON (${err instanceof Error ? err.message : String(err)})`));
      continue;
    }
    const r = await validateSnapshot(rel, json, index);
    out.issues.push(...r.issues);
    if (r.snapshot) out.snapshots.push({ format: format.data, snapshot: r.snapshot });
  }
  return out;
}
