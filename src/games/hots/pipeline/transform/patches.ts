/**
 * Blizzard patch-note articles → patches.json records (SPEC §5). Pure.
 *
 * An article is one main record (live / balance / PTR notes) plus one record per
 * "Hotfix - M/D/YYYY" section that Blizzard appends at the top of the live article without
 * changing its date. Each record carries the hash of the section text it came from, so a silent
 * hotfix append shows up as a new record and edits as a changed hash.
 *
 * What is kept (copyright: short factual change lines only, never paragraphs):
 *  - general: list lines of the General section and of hotfix sections without a hero;
 *  - maps: list lines under a map name in the Map section;
 *  - heroes: list lines under a hero (Balance section, hotfix hero blocks), with the section
 *    label (Base, Abilities, Talents, Level N…), the ability/talent they are about, and a
 *    buff/nerf/change/rework direction from the numbers and wording;
 *  - new heroes: one line of our own ("X joins the Nexus as a Ranged Assassin.").
 * Bug-fix sections, collection/bundle sections, intros and new-hero kit descriptions are skipped,
 * and a hero marked "fully reworked" gets one summary line instead of its whole new kit.
 */
import type { ChangeDir, Patch, PatchChange, PatchHero, TalentTier } from '../../schema.ts';
import { TALENT_TIERS } from '../../schema.ts';
import { cleanText, compareStrings, hash16, isoDate, searchKey } from '../util.ts';
import { findElement, hasClass, isElement, parseHtml, textOf, type HtmlElement } from './html.ts';

export type PatchKind = Patch['kind'];

/** Text of a change line is cut to this length (schema allows 400). */
export const MAX_LINE = 300;

export interface ArticleMeta {
  url: string;
  title: string;
  /** Feed timestamp (ISO); the date in the title wins when present. */
  published: string;
}

/** Hero lookup: search key of names/slugs/aliases → member hero ids. */
export type HeroIndex = ReadonlyMap<string, readonly string[]>;
/** Map lookup: search key of a map name/alias → map slug. */
export type MapIndex = ReadonlyMap<string, string>;

export interface HeroInfo {
  name: string;
  role: string;
}

/** A parsed record before version/build are assigned. */
export type ParsedPatch = Omit<Patch, 'id' | 'version'>;

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function kindFromTitle(title: string): PatchKind | null {
  if (!/patch notes|hotfix/i.test(title)) return null;
  if (/\bPTR\b|public test/i.test(title)) return 'ptr';
  if (/balance/i.test(title)) return 'balance';
  if (/hotfix/i.test(title)) return 'hotfix';
  return 'patch';
}

/** "Heroes of the Storm Live Patch Notes - September 28, 2026" → 2026-09-28. */
export function dateFromTitle(title: string): string | null {
  const m = /(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2}),?\s+(\d{4})/i.exec(title);
  if (!m) return null;
  const month = MONTHS.indexOf((m[1] ?? '').toLowerCase()) + 1;
  return `${m[3]}-${String(month).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

/** "Hotfix - 10/5/2026" → 2026-10-05 (US month/day order). */
export function hotfixDate(text: string): string | null {
  const m = /hotfix\s*[-–—:]?\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/i.exec(text);
  if (!m) return null;
  return `${m[3]}-${String(Number(m[1])).padStart(2, '0')}-${String(Number(m[2])).padStart(2, '0')}`;
}

// ---- direction heuristics ---------------------------------------------------------------

const LOWER_IS_BETTER =
  /\b(cooldowns?|costs?|mana|delay|cast time|channel(?:ing)? time|channel duration|requirements?|required|time to|every\s+[\d.]+\s+seconds?|wind-?up|charge time|damage taken|self[- ]damage)\b/i;

function num(s: string): number {
  return Number(s.startsWith('.') ? `0${s}` : s);
}

/**
 * buff / nerf from "from A to B", "to B, up/down from A", "increased/reduced by N" and the
 * quantity named before the verb (cooldowns, costs and requirements are better when lower).
 * 'rework' for rework wording, 'change' for "Now …"/"No longer …" lines, else undefined.
 */
export function changeDirection(text: string, context = ''): ChangeDir | undefined {
  const t = text.replace(/\s+/g, ' ');
  if (/\brework(?:ed)?\b|\bredesigned\b/i.test(t) || /^rework:/i.test(context)) return 'rework';
  const N = '(\\.?\\d+(?:\\.\\d+)?)';
  let oldV: number | null = null;
  let newV: number | null = null;
  let subjectEnd = -1;
  let m = new RegExp(`\\bto\\s+${N}%?[^,.;]*?,?\\s*(up|down)\\s+from\\s+${N}`, 'i').exec(t);
  if (m) {
    newV = num(m[1] as string);
    oldV = num(m[3] as string);
    subjectEnd = m.index;
  } else if ((m = new RegExp(`\\bfrom\\s+${N}%?[^.;]*?\\bto\\s+${N}`, 'i').exec(t))) {
    oldV = num(m[1] as string);
    newV = num(m[2] as string);
    subjectEnd = m.index;
  }
  let sign = 0;
  if (oldV !== null && newV !== null && Number.isFinite(oldV) && Number.isFinite(newV) && oldV !== newV) {
    sign = newV > oldV ? 1 : -1;
  } else if (!/\bno longer\b/i.test(t)) {
    const v = /\b(increased|increases|raised|improved|extended|faster|more)\b|\b(reduced|reduces|decreased|lowered|shortened|slower|less|fewer)\b/i.exec(t);
    if (v) {
      sign = v[1] ? 1 : -1;
      subjectEnd = v.index;
    }
  }
  if (sign !== 0) {
    // The quantity is named in the same clause, just before the verb or "from".
    const head = subjectEnd >= 0 ? t.slice(0, subjectEnd) : t;
    const clauseStart = Math.max(0, ...[...head.matchAll(/[.:;](?=\s)/g)].map((x) => (x.index ?? 0) + 1));
    const subject = `${head.slice(clauseStart)} ${context}`;
    // "Cooldown reduction", "Mana refund", "Mana restore" are good things to have more of.
    let lowerBetter =
      LOWER_IS_BETTER.test(subject) &&
      !/\b(cooldowns?|costs?|mana)\s+(reduction|refunds?|refresh|restored?|regen(?:eration)?|return(?:ed)?)\b/i.test(subject);
    if (/\bdecay\b/i.test(subject) && !/\breduction\b/i.test(subject)) lowerBetter = true;
    if (/\bnow strikes every\b|\bevery\s+[\d.]+\s+seconds?\b/i.test(t) && oldV !== null) lowerBetter = true;
    const better = lowerBetter ? sign < 0 : sign > 0;
    return better ? 'buff' : 'nerf';
  }
  if (/^(now|no longer|can now|can no longer|will now|is now|are now|new)\b/i.test(t) || /\b(moved|replaced|changed|swapped|now|removed|disabled|added|no longer)\b/i.test(t)) {
    return 'change';
  }
  return undefined;
}

export function verdictOf(changes: readonly PatchChange[]): PatchHero['verdict'] {
  const dirs = changes.map((c) => c.dir);
  if (dirs.includes('rework')) return 'rework';
  const buffs = dirs.filter((d) => d === 'buff').length;
  const nerfs = dirs.filter((d) => d === 'nerf').length;
  if (buffs > 0 && nerfs > 0) return 'mixed';
  if (buffs > 0) return 'buff';
  if (nerfs > 0) return 'nerf';
  return 'change';
}

// ---- linearisation ------------------------------------------------------------------------

type Item =
  | { type: 'heading'; text: string }
  | { type: 'anchor'; name: string }
  | { type: 'para'; text: string }
  | { type: 'li'; lines: string[]; depth: number; hasChildren: boolean }
  | { type: 'rule' };

const LIST = new Set(['ul', 'ol']);

/** Struck-out text marks values that changed between PTR and live notes: never part of a line. */
const STRUCK = new Set(['s', 'del', 'strike']);
const skipStruck = (el: HtmlElement): boolean => STRUCK.has(el.tag);

function ownText(li: HtmlElement): string {
  return textOf(li, (el) => LIST.has(el.tag) || el.tag === 'aside' || el.tag === 'figure' || STRUCK.has(el.tag));
}

function linearize(node: HtmlElement, out: Item[], depth: number): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    const tag = child.tag;
    if (/^h[1-6]$/.test(tag)) {
      collectAnchors(child, out);
      const text = cleanText(textOf(child, skipStruck));
      if (text) out.push({ type: 'heading', text });
    } else if (tag === 'a' && child.attrs.name) {
      out.push({ type: 'anchor', name: child.attrs.name });
      linearize(child, out, depth);
    } else if (tag === 'hr') {
      out.push({ type: 'rule' });
    } else if (LIST.has(tag)) {
      for (const li of child.children) {
        if (!isElement(li)) continue;
        if (li.tag !== 'li') {
          linearize(li, out, depth);
          continue;
        }
        const lines = ownText(li).split('\n').map(cleanText).filter(Boolean);
        const nested = li.children.filter((c): c is HtmlElement => isElement(c) && LIST.has(c.tag));
        const deep = findElement(li, (el) => LIST.has(el.tag));
        out.push({ type: 'li', lines, depth, hasChildren: Boolean(deep) });
        for (const n of nested) linearize({ type: 'element', tag: '#wrap', attrs: {}, children: [n] }, out, depth + 1);
        if (nested.length === 0 && deep) linearize({ type: 'element', tag: '#wrap', attrs: {}, children: [deep] }, out, depth + 1);
      }
    } else if (tag === 'p') {
      collectAnchors(child, out);
      const text = cleanText(textOf(child, skipStruck));
      if (text) out.push({ type: 'para', text });
    } else if (tag === 'aside' || tag === 'figure' || tag === 'img') {
      continue;
    } else {
      linearize(child, out, depth);
    }
  }
}

function collectAnchors(node: HtmlElement, out: Item[]): void {
  for (const c of node.children) {
    if (!isElement(c)) continue;
    if (c.tag === 'a' && c.attrs.name) out.push({ type: 'anchor', name: c.attrs.name });
    collectAnchors(c, out);
  }
}

// ---- interpretation -----------------------------------------------------------------------

type Area = 'preamble' | 'hotfix' | 'new' | 'collection' | 'general' | 'map' | 'balance' | 'bugs' | 'other';

const SECTION_RE = /^(base|base stats|stats|abilities|ability|basic abilities|talents|trait|heroic|heroics|heroic abilities|basic attack|mount|quest)$/i;
const LEVEL_RE = /^level\s*(\d{1,2})$/i;
const HERO_SUFFIX_RE = /\s+(balance updates?|bug fixes?|changes|updates?)$/i;
const TARGET_HOTKEY_RE = /\s*[[(]\s*(?:[QWERDZ]|trait|heroic|passive|active|\d)\s*[\])]\s*$/i;

function areaFromAnchor(name: string): Area | null {
  const n = name.toLowerCase();
  if (n === 'new' || n.startsWith('newhero')) return 'new';
  if (n === 'collection' || n === 'shop') return 'collection';
  if (n === 'general') return 'general';
  if (n === 'map' || n === 'maps') return 'map';
  if (n === 'balance') return 'balance';
  if (n === 'bugs' || n === 'bug') return 'bugs';
  if (n === 'return' || n === 'top') return 'other';
  return null;
}

function areaFromHeading(text: string): Area | null {
  if (/^new hero\b/i.test(text)) return 'new';
  if (/^(collection|new bundles?|shop)\b/i.test(text)) return 'collection';
  if (/^general\b/i.test(text)) return 'general';
  if (/^(map updates?|maps?|battlegrounds?)\b/i.test(text)) return 'map';
  if (/\bbalance updates?\b|^heroes$|^hero updates?$/i.test(text)) return 'balance';
  if (/^(general )?bug fixes\b/i.test(text)) return 'bugs';
  if (/quick navigation|return to top/i.test(text)) return 'other';
  return null;
}

class RecordBuilder {
  readonly general: string[] = [];
  readonly maps = new Map<string, string[]>();
  readonly heroes = new Map<string, PatchChange[]>();
  readonly newHeroes: string[] = [];
  readonly text: string[] = [];
  readonly kind: PatchKind;
  readonly date: string;
  readonly title: string;
  constructor(kind: PatchKind, date: string, title: string) {
    this.kind = kind;
    this.date = date;
    this.title = title;
  }
  addGeneral(line: string): void {
    if (!this.general.includes(line)) this.general.push(line);
  }
  addMap(slug: string, line: string): void {
    const list = this.maps.get(slug) ?? [];
    if (!list.includes(line)) list.push(line);
    this.maps.set(slug, list);
  }
  addHero(id: string, change: PatchChange): void {
    const list = this.heroes.get(id) ?? [];
    if (!list.some((c) => c.text === change.text && c.target === change.target && c.section === change.section)) list.push(change);
    this.heroes.set(id, list);
  }
  empty(): boolean {
    return this.general.length === 0 && this.maps.size === 0 && this.heroes.size === 0 && this.newHeroes.length === 0;
  }
}

function shortLine(text: string): string {
  const t = text.replace(/^[•\-–—*]\s*/, '').trim();
  return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE - 1).trimEnd()}…` : t;
}

export interface ParseArticleOptions {
  heroes: HeroIndex;
  maps: MapIndex;
  /** Name/role per hero id for new-hero lines. */
  heroInfo: ReadonlyMap<string, HeroInfo>;
}

function lookupHero(text: string, index: HeroIndex): readonly string[] | null {
  const key = searchKey(text);
  return key ? (index.get(key) ?? null) : null;
}

/** Parses one article into its main record and hotfix records (newest hotfix first). */
export function parseArticle(html: string, meta: ArticleMeta, opts: ParseArticleOptions): ParsedPatch[] {
  const kind = kindFromTitle(meta.title) ?? 'patch';
  const mainDate = dateFromTitle(meta.title) ?? isoDate(meta.published);
  const doc = parseHtml(html);
  const blog = findElement(doc, (el) => el.tag === 'section' && hasClass(el, 'blog')) ?? findElement(doc, (el) => el.tag === 'body') ?? doc;
  const items: Item[] = [];
  linearize(blog, items, 0);

  const main = new RecordBuilder(kind, mainDate, meta.title);
  const hotfixes: RecordBuilder[] = [];
  let rec = main;
  let area: Area = 'preamble';
  let hero: readonly string[] | null = null;
  let skipHero = false;
  let section: string | null = null;
  const reworked = new Set<string>();
  // Labels of list items with children, by depth (section, level or target).
  let labels: { section?: string; target?: string; hero?: readonly string[]; skip?: boolean; rework?: boolean }[] = [];
  let mapSlug: string | null = null;
  let mapLabel: string | null = null;

  const resetHero = (ids: readonly string[] | null, skip: boolean): void => {
    hero = ids;
    skipHero = skip;
    section = null;
    labels = [];
  };
  const enterArea = (a: Area): void => {
    if (rec !== main && a !== 'hotfix' && a !== 'bugs') rec = main;
    area = a;
    resetHero(null, false);
    mapSlug = null;
    mapLabel = null;
  };

  const classifyLabel = (text: string): { hero?: readonly string[]; skip?: boolean; section?: string } | null => {
    const lm = LEVEL_RE.exec(text);
    if (lm) return { section: `Level ${Number(lm[1])}` };
    if (SECTION_RE.test(text)) return { section: text.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Base Stats$/, 'Base').replace(/^Stats$/, 'Base') };
    const stripped = text.replace(/:$/, '');
    const suffix = HERO_SUFFIX_RE.exec(stripped);
    const ids = lookupHero(suffix ? stripped.slice(0, suffix.index) : stripped, opts.heroes);
    if (ids) return { hero: ids, skip: Boolean(suffix && /bug/i.test(suffix[1] ?? '')) };
    if (/^general bug fixes?$/i.test(stripped) || /^bug fixes?$/i.test(stripped)) return { hero: [], skip: true };
    return null;
  };

  const recordLine = (line: string, depth: number): void => {
    const text = shortLine(line);
    if (!text || /^return to top$/i.test(text)) return;
    rec.text.push(text);
    if (area === 'general' || (area === 'hotfix' && !hero)) {
      if (!skipHero) rec.addGeneral(text);
      return;
    }
    if (area === 'map') {
      if (mapSlug) rec.addMap(mapSlug, text);
      else rec.addGeneral(mapLabel ? `${mapLabel}: ${text}` : text);
      return;
    }
    if ((area === 'balance' || area === 'hotfix') && hero && !skipHero) {
      if (markRework(text)) return;
      const ancestors = labels.slice(0, depth);
      const sec = [...ancestors].reverse().find((l) => l?.section)?.section ?? section ?? 'Changes';
      const target = [...ancestors].reverse().find((l) => l?.target)?.target;
      const reworkLabel = ancestors.some((l) => l?.rework);
      const change: PatchChange = { section: sec, text: text.replace(/^rework:\s*/i, '') };
      if (target) change.target = target;
      const lm = /^Level (\d+)$/.exec(sec);
      if (lm && (TALENT_TIERS as readonly string[]).includes(lm[1] ?? '')) change.level = lm[1] as TalentTier;
      const dir = changeDirection(text, `${reworkLabel ? 'REWORK: ' : ''}${target ?? ''} ${sec}`);
      if (dir) change.dir = dir;
      for (const id of hero) if (!reworked.has(id)) rec.addHero(id, change);
    }
  };

  for (const item of items) {
    if (item.type === 'rule') continue;
    if (item.type === 'anchor') {
      const a = areaFromAnchor(item.name);
      if (a) enterArea(a);
      continue;
    }
    if (item.type === 'heading') {
      const hd = hotfixDate(item.text);
      if (hd) {
        rec = new RecordBuilder('hotfix', hd, item.text.replace(/\s+/g, ' ').trim());
        hotfixes.push(rec);
        area = 'hotfix';
        resetHero(null, false);
        continue;
      }
      let a = areaFromHeading(item.text);
      // "Heroes" / "Maps" sub-headings inside Bug Fixes stay bug fixes.
      if (area === 'bugs' && (a === 'balance' || a === 'map' || a === 'general') && !/balance/i.test(item.text)) a = null;
      if (a === 'new' && rec === main) {
        enterArea('new');
        const name = item.text.replace(/^new hero\s*[:\-–—]?\s*/i, '');
        const ids = lookupHero(name, opts.heroes);
        for (const id of ids ?? []) {
          if (main.newHeroes.includes(id)) continue;
          main.newHeroes.push(id);
          const info = opts.heroInfo.get(id);
          main.addHero(id, { section: 'New Hero', text: `${info?.name ?? name} joins the Nexus as a ${info?.role ?? 'new hero'}.`, dir: 'change' });
        }
        continue;
      }
      if (a && !(a === 'bugs' && area === 'hotfix')) {
        if (rec !== main && a !== 'other') rec = main;
        enterArea(a);
        continue;
      }
      if (area === 'balance' || area === 'hotfix') {
        const c = classifyLabel(item.text);
        if (c?.hero) resetHero(c.hero.length ? c.hero : null, Boolean(c.skip));
        else if (c?.section) section = c.section;
      } else if (area === 'map') {
        mapSlug = opts.maps.get(searchKey(item.text)) ?? null;
        mapLabel = item.text;
      }
      continue;
    }
    if (item.type === 'para') {
      if (area !== 'balance' && area !== 'hotfix') continue;
      const c = item.text.length <= 60 ? classifyLabel(item.text) : null;
      if (c?.hero) resetHero(c.hero.length ? c.hero : null, Boolean(c.skip));
      else if (c?.section) {
        section = c.section;
        labels = [];
      } else {
        markRework(item.text);
      }
      continue;
    }
    // List item.
    labels = labels.slice(0, item.depth);
    const lines = [...item.lines];
    if (item.hasChildren) {
      const label = lines.pop();
      for (const l of lines) handleLooseLine(l, item.depth);
      if (label) {
        const c = area === 'balance' || area === 'hotfix' ? classifyLabel(label) : null;
        if (c?.hero) {
          resetHero(c.hero.length ? c.hero : null, Boolean(c.skip));
        } else if (c?.section) {
          labels[item.depth] = { section: c.section };
        } else if (area === 'map' && item.depth === 0) {
          mapSlug = opts.maps.get(searchKey(label)) ?? null;
          mapLabel = label;
        } else if (area === 'general' || (area === 'hotfix' && !hero)) {
          // A general sub-heading ("Storm League") prefixes nothing; its children are general lines.
        } else {
          const rework = /^rework:/i.test(label);
          labels[item.depth] = { target: label.replace(/^rework:\s*/i, '').replace(TARGET_HOTKEY_RE, '').trim(), rework };
        }
      }
      continue;
    }
    for (const l of lines) handleLooseLine(l, item.depth);
  }

  /** "X has been fully reworked": one summary line of our own instead of the whole new kit. */
  function markRework(text: string): boolean {
    if (!hero || !/\bfully reworked\b|\bfull rework\b|\bcomplete rework\b/i.test(text)) return false;
    for (const id of hero) {
      if (reworked.has(id)) continue;
      rec.addHero(id, { section: 'Base', text: 'Full rework: new base abilities and talent tree.', dir: 'rework' });
      reworked.add(id);
    }
    return true;
  }

  function handleLooseLine(line: string, depth: number): void {
    if (area === 'balance' || area === 'hotfix') {
      const c = line.length <= 60 ? classifyLabel(line) : null;
      if (c?.hero) {
        resetHero(c.hero.length ? c.hero : null, Boolean(c.skip));
        return;
      }
      if (c?.section) {
        section = c.section;
        labels = labels.slice(0, depth);
        return;
      }
    }
    if (area === 'preamble' || area === 'new' || area === 'collection' || area === 'bugs' || area === 'other') return;
    recordLine(line, depth);
  }

  const toRecord = (b: RecordBuilder, url: string): ParsedPatch => {
    const heroes: Record<string, PatchHero> = {};
    for (const id of [...b.heroes.keys()].sort(compareStrings)) {
      const changes = b.heroes.get(id) as PatchChange[];
      heroes[id] = { verdict: b.newHeroes.includes(id) ? 'new' : verdictOf(changes), changes };
    }
    const rec: ParsedPatch = {
      date: b.date,
      title: b.title,
      url,
      kind: b.kind,
      contentHash: hash16(`${b.kind}|${b.date}|${b.text.join('\n')}|${b.general.join('\n')}`),
      general: b.general,
      heroes,
    };
    if (b.maps.size > 0) rec.maps = Object.fromEntries([...b.maps].sort(([x], [y]) => compareStrings(x, y)));
    if (b.newHeroes.length > 0) rec.newHeroes = [...b.newHeroes].sort(compareStrings);
    return rec;
  };
  return [...hotfixes, main].filter((b) => !b.empty()).map((b) => toRecord(b, meta.url));
}

/** Map index from map names, slugs and aliases. */
export function buildMapIndex(maps: readonly { id: string; name: string }[], aliases: Readonly<Record<string, readonly string[]>>): Map<string, string> {
  const index = new Map<string, string>();
  for (const m of maps) {
    index.set(searchKey(m.name), m.id);
    index.set(searchKey(m.id), m.id);
    for (const a of aliases[m.id] ?? []) if (!index.has(searchKey(a))) index.set(searchKey(a), m.id);
  }
  return index;
}

/**
 * Hero index for patch notes: names, slugs and aliases of member heroes → [id]; a composite's
 * name ("Cho'gall") → both members. Keys two heroes share are dropped (ambiguous) unless one of
 * them is that hero's own name or slug.
 */
export function buildHeroIndex(
  heroes: readonly { id: string; slug: string; name: string; aliases: readonly string[]; members?: readonly string[] | undefined }[],
): Map<string, string[]> {
  const own = new Map<string, string>();
  const shared = new Map<string, Set<string>>();
  for (const h of heroes) {
    if (h.members) continue;
    for (const k of [h.name, h.slug].map(searchKey)) if (k) own.set(k, h.id);
    for (const a of h.aliases) {
      const k = searchKey(a);
      if (!k) continue;
      const set = shared.get(k) ?? new Set<string>();
      set.add(h.id);
      shared.set(k, set);
    }
  }
  const index = new Map<string, string[]>();
  for (const [k, ids] of shared) if (ids.size === 1) index.set(k, [...ids]);
  for (const [k, id] of own) index.set(k, [id]);
  for (const h of heroes) {
    if (!h.members) continue;
    for (const k of [h.name, h.slug].map(searchKey)) if (k && !own.has(k)) index.set(k, [...h.members]);
  }
  return index;
}

