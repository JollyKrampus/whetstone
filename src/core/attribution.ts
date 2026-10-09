/**
 * Which credits a page must show, and where (SPEC §1.5): `inline` next to the data it covers
 * (Heroes Profile), `top` of the page (17Lands CC BY), or the `footer`. Components feed in every
 * SourceRef whose data appears on the page; this dedupes and orders them deterministically.
 */
import type { AttributionRule, SourceRef } from './game.ts';

export interface CreditGroups {
  inline: SourceRef[];
  top: SourceRef[];
  footer: SourceRef[];
}

export const ATTRIBUTION_RULES: readonly AttributionRule[] = Object.freeze(['inline', 'top', 'footer']);

const STRICTNESS: Readonly<Record<AttributionRule, number>> = { inline: 0, top: 1, footer: 2 };

const byName = (x: SourceRef, y: SourceRef): number => {
  const a = x.name.toLowerCase();
  const b = y.name.toLowerCase();
  if (a !== b) return a < b ? -1 : 1;
  return x.id < y.id ? -1 : x.id > y.id ? 1 : 0;
};

/**
 * Group sources by rule, one entry per id. If the same id arrives with different rules (two
 * components disagreeing), the strictest placement wins so a required credit is never demoted.
 * Within a group, order is by name then id, independent of input order.
 */
export function groupCredits(sources: readonly (SourceRef | null | undefined)[]): CreditGroups {
  const chosen = new Map<string, SourceRef>();
  for (const s of sources) {
    if (!s) continue;
    const prev = chosen.get(s.id);
    if (!prev || STRICTNESS[s.rule] < STRICTNESS[prev.rule]) chosen.set(s.id, s);
  }
  const groups: CreditGroups = { inline: [], top: [], footer: [] };
  for (const s of chosen.values()) (groups[s.rule] ?? groups.footer).push(s);
  groups.inline.sort(byName);
  groups.top.sort(byName);
  groups.footer.sort(byName);
  return groups;
}

/** Every credit once, strictest groups first (for the credits page and share/export text). */
export function allCredits(groups: CreditGroups): SourceRef[] {
  return [...groups.inline, ...groups.top, ...groups.footer];
}

export function hasCredits(groups: CreditGroups): boolean {
  return groups.inline.length + groups.top.length + groups.footer.length > 0;
}

/** Plain-text credit for exports and copied summaries: "<attribution> (<license>) <url>". */
export function creditText(source: SourceRef): string {
  const license = source.license ? ` (${source.license})` : '';
  return `${source.attribution}${license} ${source.url}`;
}
