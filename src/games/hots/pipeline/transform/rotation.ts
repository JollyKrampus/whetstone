/**
 * Nexus Compendium `/api/currently/herorotation+ranked` → rotation.json (SPEC §5). Pure.
 *
 * Response shape (verified 2026-10-08):
 *   { RotationHero: { Heroes: [{ ID: 'li-li', Name: 'Li Li', … }], StartDate, EndDate, AllHeroesFree },
 *     Ranked: { ID: '2026-season-3', Name: '2026 Season 3', StartDate, EndDate } }
 * Heroes are matched by name/slug/alias to member hero ids (Cho and Gall rotate separately).
 * The source lags the weekly switch by hours to a day: `lagging` tells the caller to say so.
 */
import type { ValidationIssue } from '../../../../core/game.ts';
import type { Rotation } from '../../schema.ts';
import { asString, compareStrings, isRecord, searchKey, warn } from '../util.ts';

export interface BuiltRotation {
  rotation: Rotation;
  /** The rotation window already ended (the source has not switched yet). */
  lagging: boolean;
  issues: ValidationIssue[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function buildRotation(raw: unknown, heroIndex: ReadonlyMap<string, readonly string[]>, fetchedAt: string, today: string): BuiltRotation {
  if (!isRecord(raw) || !isRecord(raw.RotationHero)) throw new Error('Nexus Compendium response has no RotationHero');
  const r = raw.RotationHero;
  const start = asString(r.StartDate)?.slice(0, 10) ?? '';
  const end = asString(r.EndDate)?.slice(0, 10) ?? '';
  if (!DATE_RE.test(start) || !DATE_RE.test(end)) throw new Error(`Nexus Compendium rotation has invalid dates "${start}".."${end}"`);
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  const unknown: string[] = [];
  for (const h of Array.isArray(r.Heroes) ? r.Heroes : []) {
    if (!isRecord(h)) continue;
    const candidates = [asString(h.Name), asString(h.ID)].filter((x): x is string => Boolean(x));
    const hit = candidates.map((c) => heroIndex.get(searchKey(c))).find((x) => x && x.length > 0);
    if (!hit) {
      unknown.push(candidates[0] ?? '?');
      continue;
    }
    for (const id of hit) ids.add(id);
  }
  if (unknown.length > 0) {
    issues.push(warn(`rotation heroes not in heroes.json (skipped): ${unknown.sort(compareStrings).join(', ')}`, 'nexus-compendium'));
  }
  let ranked: Rotation['ranked'] = null;
  if (isRecord(raw.Ranked)) {
    const k = raw.Ranked;
    const id = asString(k.ID);
    const name = asString(k.Name);
    const s = asString(k.StartDate)?.slice(0, 10);
    const e = asString(k.EndDate)?.slice(0, 10);
    if (id && name && s && e && DATE_RE.test(s) && DATE_RE.test(e)) ranked = { id, name, start: s, end: e };
  }
  const rotation: Rotation = {
    source: 'nexus-compendium',
    fetchedAt,
    start,
    end,
    allFree: r.AllHeroesFree === true,
    heroes: [...ids].sort(compareStrings),
    ranked,
  };
  return { rotation, lagging: end < today, issues };
}

/**
 * Keeps the previous `fetchedAt` when nothing but the fetch time changed, so an unchanged
 * rotation does not count as new data every day (the source status carries the fetch time).
 */
export function stableRotation(next: Rotation, previous: Rotation | null): Rotation {
  if (!previous) return next;
  const same =
    previous.start === next.start &&
    previous.end === next.end &&
    previous.allFree === next.allFree &&
    previous.heroes.join() === next.heroes.join() &&
    JSON.stringify(previous.ranked) === JSON.stringify(next.ranked);
  return same ? { ...next, fetchedAt: previous.fetchedAt } : next;
}
