/**
 * Liquipedia tournament wikitext → pro.json (class A-SA, CC BY-SA 3.0). Pure.
 *
 * Each played map is a `{{Map|map=… |winner=1|2 |t1h1..t1h5= |t2h1..t2h5= |t1b1..t1b3= |t2b1..t2b3=}}`
 * template inside a `{{Match …}}`; heroes are Liquipedia short names (`liming`, `tlv`,
 * `xalatath`). Only aggregates are kept: per draftable entity picks, bans, wins and rates over
 * all drafted maps, plus per-tournament map counts. Team and player names are never read into
 * the output (SPEC §1.2). Cho and Gall count once, as the composite `chogall`.
 */
import type { ValidationIssue } from '../../../../core/game.ts';
import type { Pro } from '../../schema.ts';
import { compareStrings, round, searchKey, warn } from '../util.ts';

export const LIQUIPEDIA_ATTRIBUTION: Pro['attribution'] = {
  source: 'liquipedia',
  text: 'Pro draft data from Liquipedia, licensed CC-BY-SA 3.0',
  url: 'https://liquipedia.net/heroes/',
  license: 'CC BY-SA 3.0',
  licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
};

export interface WikiTemplate {
  name: string;
  params: Record<string, string>;
  /** Raw text of the whole template (for nested searches). */
  raw: string;
}

/** Removes `<!-- … -->` comments. */
export function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

/** Every top-level-or-nested `{{name…}}` whose name matches, with its params split at depth 0. */
export function findTemplates(text: string, name: string): WikiTemplate[] {
  const out: WikiTemplate[] = [];
  const lower = text.toLowerCase();
  const needle = `{{${name.toLowerCase()}`;
  let from = 0;
  for (;;) {
    const start = lower.indexOf(needle, from);
    if (start < 0) break;
    const next = text[start + needle.length] ?? '';
    if (/[A-Za-z0-9_/]/.test(next)) {
      from = start + needle.length;
      continue;
    }
    const end = matchBraces(text, start);
    if (end < 0) break;
    const raw = text.slice(start, end);
    out.push({ name, params: splitParams(raw.slice(2 + name.length, -2)), raw });
    from = start + needle.length;
  }
  return out;
}

/** Index after the `}}` closing the `{{` at `start`, or -1. */
function matchBraces(text: string, start: number): number {
  let depth = 0;
  for (let i = start; i < text.length - 1; i++) {
    if (text[i] === '{' && text[i + 1] === '{') {
      depth++;
      i++;
    } else if (text[i] === '}' && text[i + 1] === '}') {
      depth--;
      i++;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function splitParams(body: string): Record<string, string> {
  const params: Record<string, string> = {};
  let depth = 0;
  let link = 0;
  let cur = '';
  const parts: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const two = body.slice(i, i + 2);
    if (two === '{{') { depth++; cur += two; i++; continue; }
    if (two === '}}') { depth--; cur += two; i++; continue; }
    if (two === '[[') { link++; cur += two; i++; continue; }
    if (two === ']]') { link--; cur += two; i++; continue; }
    if (body[i] === '|' && depth === 0 && link === 0) {
      parts.push(cur);
      cur = '';
      continue;
    }
    cur += body[i];
  }
  parts.push(cur);
  let positional = 0;
  for (const p of parts) {
    const eq = p.indexOf('=');
    const key = eq > 0 && !p.slice(0, eq).includes('{{') ? p.slice(0, eq).trim().toLowerCase() : null;
    if (key) params[key] = p.slice(eq + 1).trim();
    else if (p.trim()) params[String(++positional)] = p.trim();
  }
  return params;
}

export interface DraftedMap {
  winner: 1 | 2 | null;
  picks: [string[], string[]];
  bans: [string[], string[]];
}

export function parseMaps(wikitext: string): DraftedMap[] {
  const text = stripComments(wikitext);
  const out: DraftedMap[] = [];
  for (const t of findTemplates(text, 'Map')) {
    const p = t.params;
    const team = (side: 1 | 2, kind: 'h' | 'b', n: number): string[] =>
      Array.from({ length: n }, (_, i) => (p[`t${side}${kind}${i + 1}`] ?? '').trim().toLowerCase()).filter(Boolean);
    const picks: [string[], string[]] = [team(1, 'h', 5), team(2, 'h', 5)];
    if (picks[0].length + picks[1].length === 0) continue;
    const w = (p.winner ?? '').trim();
    out.push({ winner: w === '1' ? 1 : w === '2' ? 2 : null, picks, bans: [team(1, 'b', 3), team(2, 'b', 3)] });
  }
  return out;
}

export interface TournamentPage {
  title: string;
  wikitext: string;
}

export interface ParsedTournament {
  id: string;
  name: string;
  url: string;
  tier?: number;
  region?: string;
  startDate: string;
  endDate?: string;
  maps: DraftedMap[];
  /** Subpage part of the title (`League Stage`), used to tell same-named stages apart. */
  subpage?: string;
}

/** Stages of one event often share the infobox name: suffix the subpage when names collide. */
export function distinctNames(list: readonly ParsedTournament[]): Map<string, string> {
  const count = new Map<string, number>();
  for (const t of list) count.set(t.name, (count.get(t.name) ?? 0) + 1);
  return new Map(list.map((t) => [t.id, (count.get(t.name) ?? 0) > 1 && t.subpage ? `${t.name} (${t.subpage})` : t.name]));
}

function isoDate(v: string | undefined): string | undefined {
  const m = /(\d{4})-(\d{2})-(\d{2})/.exec(v ?? '');
  return m ? `${m[1]}-${m[2]}-${m[3]}` : undefined;
}

function plain(v: string | undefined): string {
  return (v ?? '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[(?:[^|\]]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'{2,}/g, '')
    .replace(/<[^>]+>/g, '')
    .trim();
}

export function parseTournament(page: TournamentPage): ParsedTournament | null {
  const text = stripComments(page.wikitext);
  if (/\{\{\s*Cancelled Tournament/i.test(text)) return null;
  const info = findTemplates(text, 'Infobox league')[0]?.params ?? {};
  const startDate = isoDate(info.sdate) ?? isoDate(info.date);
  if (!startDate) return null;
  const id = page.title.replace(/ /g, '_');
  const name = plain(info.name) || page.title.replace(/\//g, ' ');
  const t: ParsedTournament = { id, name, url: `https://liquipedia.net/heroes/${encodeURI(id)}`, startDate, maps: parseMaps(text) };
  if (page.title.includes('/')) t.subpage = page.title.split('/').slice(1).join(' / ');
  const endDate = isoDate(info.edate);
  if (endDate) t.endDate = endDate;
  const tier = Number.parseInt(info.liquipediatier ?? '', 10);
  if (Number.isInteger(tier) && tier >= 1 && tier <= 5) t.tier = tier;
  const region = plain(info.region ?? info.server ?? info.country);
  if (region) t.region = region;
  return t;
}

export interface AggregateOptions {
  /** searchKey(Liquipedia hero name) → draftable entity id. */
  entityIndex: ReadonlyMap<string, string>;
  from: string;
  to: string;
  label: string;
  major?: string;
}

export function aggregatePro(tournaments: readonly ParsedTournament[], opts: AggregateOptions): { pro: Pro; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  const unknown = new Set<string>();
  const stats = new Map<string, { picks: number; bans: number; wins: number }>();
  const entity = (lp: string): string | null => {
    const id = opts.entityIndex.get(searchKey(lp));
    if (!id) unknown.add(lp);
    return id ?? null;
  };
  const kept = tournaments
    .filter((t) => t.startDate >= opts.from && t.startDate <= opts.to && t.maps.length > 0)
    .sort((a, b) => compareStrings(b.startDate, a.startDate) || compareStrings(a.id, b.id));
  let totalMaps = 0;
  for (const t of kept) {
    for (const m of t.maps) {
      totalMaps++;
      const pickedBy = new Map<string, 1 | 2>();
      for (const side of [1, 2] as const) for (const h of m.picks[side - 1] ?? []) {
        const id = entity(h);
        if (id && !pickedBy.has(id)) pickedBy.set(id, side);
      }
      const banned = new Set<string>();
      for (const side of [0, 1]) for (const h of m.bans[side] ?? []) {
        const id = entity(h);
        if (id && !pickedBy.has(id)) banned.add(id);
      }
      for (const [id, side] of pickedBy) {
        const s = stats.get(id) ?? { picks: 0, bans: 0, wins: 0 };
        s.picks++;
        if (m.winner === side) s.wins++;
        stats.set(id, s);
      }
      for (const id of banned) {
        const s = stats.get(id) ?? { picks: 0, bans: 0, wins: 0 };
        s.bans++;
        stats.set(id, s);
      }
    }
  }
  if (unknown.size > 0) issues.push(warn(`Liquipedia hero names without a match: ${[...unknown].sort(compareStrings).join(', ')}`, 'liquipedia'));
  const names = distinctNames(kept);
  const rate = (n: number): number => (totalMaps > 0 ? Math.min(1, round(n / totalMaps, 4)) : 0);
  const heroes: Pro['heroes'] = [...stats]
    .map(([hero, s]) => ({ hero, picks: s.picks, bans: s.bans, wins: s.wins, pickRate: rate(s.picks), banRate: rate(s.bans), presence: rate(s.picks + s.bans) }))
    .sort((a, b) => b.presence - a.presence || compareStrings(a.hero, b.hero));
  const pro: Pro = {
    attribution: { ...LIQUIPEDIA_ATTRIBUTION },
    window: { label: opts.label, from: opts.from, to: opts.to, ...(opts.major ? { major: opts.major } : {}) },
    totals: { tournaments: kept.length, maps: totalMaps },
    tournaments: kept.map((t) => ({
      id: t.id,
      name: names.get(t.id) ?? t.name,
      url: t.url,
      ...(t.tier !== undefined ? { tier: t.tier } : {}),
      ...(t.region ? { region: t.region } : {}),
      startDate: t.startDate,
      ...(t.endDate ? { endDate: t.endDate } : {}),
      maps: t.maps.length,
    })),
    heroes,
  };
  return { pro, issues };
}

/** searchKey → entity id for Liquipedia short names: slugs, names and aliases; members map to their composite. */
export function buildEntityIndex(heroes: readonly { id: string; slug: string; name: string; aliases: readonly string[]; memberOf?: string | undefined }[]): Map<string, string> {
  const index = new Map<string, string>();
  const own = new Map<string, string>();
  for (const h of heroes) {
    const entity = h.memberOf ?? h.id;
    for (const k of [h.slug, h.name].map(searchKey)) if (k) own.set(k, entity);
  }
  for (const h of heroes) {
    const entity = h.memberOf ?? h.id;
    for (const a of h.aliases) {
      const k = searchKey(a);
      if (k && !own.has(k) && !index.has(k)) index.set(k, entity);
    }
  }
  for (const [k, v] of own) index.set(k, v);
  return index;
}
