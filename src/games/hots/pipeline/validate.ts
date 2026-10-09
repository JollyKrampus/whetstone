/**
 * Output validation for the HotS pipeline (SPEC §12 entry 4): every file against its registry
 * schema and custody class, sanity minimums and drops against last-good counts (online runs
 * only: offline fixtures are deliberately small), and cross-file references.
 */
import { checkCount, validateFiles } from '../../../../pipeline/validate.ts';
import type { GameMeta, OutputFile, ValidationIssue } from '../../../core/game.ts';
import { HOTS_FILES, HOTS_PRIVATE_OVERLAYS, HotsMetaSchema, type GameMap, type Hero, type Links, type Rotation, type Theory } from '../schema.ts';
import { warn } from './util.ts';

/** Below these an online run is treated as truncated upstream data. */
export const MINIMUMS = { heroes: 80, maps: 10 } as const;

export interface HotsValidationInput {
  files: readonly OutputFile[];
  offline: boolean;
  previousCounts: Readonly<Record<string, number>> | null;
  counts: Readonly<Record<string, number>>;
}

export function validateHots(input: HotsValidationInput): ValidationIssue[] {
  const issues = validateFiles(input.files, HOTS_FILES, { overlays: HOTS_PRIVATE_OVERLAYS });
  if (!input.offline) {
    const prev = (k: string): number | null => input.previousCounts?.[k] ?? null;
    issues.push(
      ...checkCount({ name: 'heroes', count: input.counts.heroes ?? 0, previous: prev('heroes'), min: MINIMUMS.heroes, source: 'heroes-data2' }),
      ...checkCount({ name: 'maps', count: input.counts.maps ?? 0, previous: prev('maps'), min: MINIMUMS.maps, source: 'heroes-data2' }),
      ...checkCount({ name: 'patches', count: input.counts.patches ?? 0, previous: prev('patches'), maxDropPct: 50, source: 'blizzard-news' }),
    );
  }
  return issues;
}

/**
 * meta.json is written by the runner, which adds generatedAt and dataHash; check the rest
 * against HotsMetaSchema now so a bad meta fails this run instead of the site build.
 */
export function validateMeta(meta: Omit<GameMeta, 'generatedAt' | 'dataHash'>, nowIso: string): ValidationIssue[] {
  const parsed = HotsMetaSchema.safeParse({ ...meta, generatedAt: nowIso, dataHash: '0'.repeat(64) });
  if (parsed.success) return [];
  return parsed.error.issues.slice(0, 10).map((i) => ({ level: 'error' as const, message: `meta.json: ${i.path.join('.') || '(root)'}: ${i.message}` }));
}

/** References between files that schemas cannot see; problems are warnings. */
export function crossCheck(input: { heroes: readonly Hero[]; maps: readonly GameMap[]; theory: Theory; links: Links; rotation: Rotation | null }): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const entities = new Set(input.heroes.filter((h) => !h.memberOf).map((h) => h.id));
  const members = new Set(input.heroes.filter((h) => !h.members).map((h) => h.id));
  const maps = new Set(input.maps.map((m) => m.id));
  const badEdges = [...input.theory.counters, ...input.theory.synergies].filter((e) => !entities.has(e.a) || !entities.has(e.b)).length;
  if (badEdges > 0) issues.push(warn(`theory.json: ${badEdges} edge(s) reference unknown entities`));
  const badFit = input.theory.mapFit.filter((f) => !entities.has(f.hero) || !maps.has(f.map)).length;
  if (badFit > 0) issues.push(warn(`theory.json: ${badFit} map-fit row(s) reference unknown heroes or maps`));
  const badLinks = Object.keys(input.links.heroes).filter((id) => !members.has(id));
  if (badLinks.length > 0) issues.push(warn(`links.json: unknown hero ids ${badLinks.join(', ')}`));
  const badRotation = (input.rotation?.heroes ?? []).filter((id) => !members.has(id));
  if (badRotation.length > 0) issues.push(warn(`rotation.json: unknown hero ids ${badRotation.join(', ')}`, 'nexus-compendium'));
  return issues;
}
