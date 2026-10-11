/**
 * Blizzard patch-note articles → patches.json records (SPEC §5). Pure.
 *
 * An article is one main record (live / balance / PTR notes) plus one record per
 * "Hotfix - M/D/YYYY" section that Blizzard appends at the top of the live article without
 * changing its date. Each record carries the hash of the section text it came from, so a silent
 * hotfix append shows up as a new record and edits as a changed hash.
 *
 * What is kept is our own structured summary, never Blizzard's sentences (./summary.ts):
 *  - general: list lines of the General section and of hotfix sections without a hero, kept as
 *    our category counts ("Interface and audio: 2 changes");
 *  - maps: per map, numeric changes as templates plus a count of the other changes;
 *  - heroes: per line under a hero (Balance section, hotfix hero blocks) the section label (Base,
 *    Abilities, Talents, Level N…), the ability/talent it is about, its kind (numeric with label,
 *    old → new and unit; or added/removed/reworked/changed/bug fix), a computed direction and a
 *    template sentence built from those fields;
 *  - new heroes: one line of our own ("X joins the Nexus as a Ranged Assassin.").
 * Bug-fix sections, collection/bundle sections, intros and new-hero kit descriptions are skipped,
 * and a hero marked "fully reworked" gets one summary line instead of its whole new kit. As a last
 * guard, any stored text that repeats VERBATIM_LIMIT consecutive words of the article is replaced.
 */
import type { z } from 'zod';
import type { ChangeDirSchema, Patch, PatchChangeSchema, PatchHeroSchema, TalentTier } from '../../schema.ts';
import { TALENT_TIERS } from '../../schema.ts';
import { cleanText, compareStrings, hash16, isoDate, searchKey } from '../util.ts';
import { findElement, hasClass, isElement, parseHtml, textOf, type HtmlElement } from './html.ts';
import { changeText, copiesSource, generalSummary, mapSummary, sourceRuns, summarizeLine, type ChangeFacts } from './summary.ts';

export type PatchKind = Patch['kind'];
export type ChangeDir = z.infer<typeof ChangeDirSchema>;
export type PatchChange = z.infer<typeof PatchChangeSchema>;
export type PatchHero = z.infer<typeof PatchHeroSchema>;

/** Raw lines are cut to this length before they are summarised (they are never stored). */
export const MAX_LINE = 300;
/** A list label longer than this is description, not an ability or talent name. */
const MAX_TARGET_WORDS = 6;
const MAX_TARGET_CHARS = 60;

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

/** Where a change sits in a hero block. */
type Place = Pick<PatchChange, 'section' | 'target' | 'level'>;

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

// ---- direction ---------------------------------------------------------------------------

/**
 * buff / nerf / change / rework of a raw line: the direction of its first summarised fact
 * (numbers first: "from A to B", "to B, up from A", "increased by N", with cooldowns, costs and
 * requirements better when lower; else the wording). Undefined when nothing says.
 */
export function changeDirection(text: string, context = ''): ChangeDir | undefined {
  return summarizeLine(text, context)[0]?.dir;
}

export function verdictOf(changes: readonly PatchChange[]): NonNullable<PatchHero['verdict']> {
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
/** Shop and cosmetic announcements are not game changes. */
const COSMETIC_RE = /^(new|added)\s+(skins?|mounts?|bundles?|portraits?|sprays?|banners?|emojis?|announcers?|voice ?lines?|loot chests?)\b/i;

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
  /** Raw general lines: hashed and counted by category, never stored. */
  readonly general: string[] = [];
  /** Raw map lines per map slug: summarised by mapSummary, never stored. */
  readonly maps = new Map<string, string[]>();
  readonly heroes = new Map<string, PatchChange[]>();
  readonly newHeroes: string[] = [];
  /** Raw lines of the section (content hash only). */
  readonly text: string[] = [];
  /** Hero lines already summarised (id, place and raw text), so a repeated line counts once. */
  private readonly seen = new Set<string>();
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
  /** One of our own lines (new hero, full rework). */
  addHero(id: string, change: PatchChange): void {
    const list = this.heroes.get(id) ?? [];
    if (!list.some((c) => c.text === change.text && c.target === change.target && c.section === change.section)) list.push(change);
    this.heroes.set(id, list);
  }
  /** The summarised facts of one raw hero line. */
  addHeroLine(id: string, place: Place, raw: string, facts: readonly ChangeFacts[]): void {
    const key = `${id}|${place.section}|${place.target ?? ''}|${raw}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);
    const list = this.heroes.get(id) ?? [];
    for (const f of facts) addFact(list, place, f);
    this.heroes.set(id, list);
  }
  empty(): boolean {
    return this.general.length === 0 && this.maps.size === 0 && this.heroes.size === 0 && this.newHeroes.length === 0;
  }
}

/**
 * Adds one fact to a hero's changes: numeric facts once each; qualitative facts of the same kind
 * and direction about the same target are counted ("2 effect changes") instead of repeated.
 */
export function addFact(list: PatchChange[], place: Place, f: ChangeFacts): void {
  if (f.kind !== 'numeric') {
    const same = list.find((c) => c.kind === f.kind && c.dir === f.dir && c.section === place.section && c.target === place.target && c.level === place.level);
    if (same) {
      same.count = (same.count ?? 1) + 1;
      same.text = changeText(same);
      return;
    }
  }
  const change: PatchChange = { ...place, ...f, text: changeText(f) };
  if (!list.some((c) => c.text === change.text && c.target === change.target && c.section === change.section)) list.push(change);
}

/** "(New) Slapathur", "New: Slapathur": a talent or ability added in this patch. */
const NEW_LABEL_RE = /^(?:\(new\)|new:)\s*/i;

/** A list label as a change target: an ability or talent name, never a sentence. */
function targetName(label: string): string | undefined {
  const t = label.replace(/^rework:\s*/i, '').replace(NEW_LABEL_RE, '').replace(TARGET_HOTKEY_RE, '').trim();
  return t && t.length <= MAX_TARGET_CHARS && t.split(/\s+/).length <= MAX_TARGET_WORDS ? t : undefined;
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
  /** Collects block headings in hero sections that match no hero (their lines are skipped). */
  unmatched?: Set<string>;
  /** Called with each stored string that had to be replaced because it repeated the article. */
  onCopied?: (text: string) => void;
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
  let area = 'preamble' as Area;
  let hero: readonly string[] | null = null;
  let skipHero = false;
  let section: string | null = null;
  const reworked = new Set<string>();
  // Labels of list items with children, by depth (section, level or target).
  let labels: { section?: string; target?: string | undefined; label?: boolean; hero?: readonly string[]; skip?: boolean; rework?: boolean; added?: boolean }[] = [];
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
      if (!skipHero && !COSMETIC_RE.test(text)) rec.addGeneral(text);
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
      const target = [...ancestors].reverse().find((l) => l?.label)?.target;
      const reworkLabel = ancestors.some((l) => l?.rework);
      const newLabel = ancestors.some((l) => l?.added);
      const place: Place = { section: sec };
      if (target) place.target = target;
      const lm = /^Level (\d+)$/.exec(sec);
      if (lm && (TALENT_TIERS as readonly string[]).includes(lm[1] ?? '')) place.level = lm[1] as TalentTier;
      const facts = summarizeLine(text.replace(/^rework:\s*/i, ''), `${reworkLabel ? 'REWORK: ' : newLabel ? 'NEW: ' : ''}${target ?? ''} ${sec}`);
      for (const id of hero) if (!reworked.has(id)) rec.addHeroLine(id, place, text, facts);
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
          main.addHero(id, { section: 'New Hero', kind: 'added', text: `${info?.name ?? name} joins the Nexus as a ${info?.role ?? 'new hero'}.`, dir: 'change' });
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
        else {
          // An unknown block (a hero missing from the data, a renamed hero): never attribute its
          // lines to the previous hero or to the general list.
          resetHero(null, true);
          if (item.text.length <= 40) opts.unmatched?.add(item.text);
        }
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
          // A label that is a sentence rather than a name still scopes its children, without a target.
          labels[item.depth] = { label: true, target: targetName(label), rework, added: NEW_LABEL_RE.test(label) };
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
      rec.addHero(id, { section: 'Base', kind: 'reworked', text: 'Full rework: new base abilities and talent tree.', dir: 'rework' });
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

  // Last guard: nothing stored may repeat VERBATIM_LIMIT consecutive words of the article.
  const runs = sourceRuns(items.flatMap((it) => (it.type === 'li' ? it.lines : it.type === 'heading' || it.type === 'para' ? [it.text] : [])));
  const guard = (text: string): boolean => {
    if (!copiesSource(text, runs)) return true;
    opts.onCopied?.(text);
    return false;
  };
  const safeChange = (c: PatchChange): PatchChange => {
    const { target, ...rest } = c;
    const kept: PatchChange = target === undefined || guard(target) ? c : rest;
    if (guard(kept.text)) return kept;
    const { stat: _s, old: _o, new: _n, by: _b, unit: _u, count: _c, ...place } = kept;
    const kind = kept.kind === 'numeric' ? 'changed' : kept.kind;
    return { ...place, kind, text: changeText({ kind }) };
  };

  const toRecord = (b: RecordBuilder, url: string): ParsedPatch => {
    const heroes: Record<string, PatchHero> = {};
    for (const id of [...b.heroes.keys()].sort(compareStrings)) {
      const changes = (b.heroes.get(id) as PatchChange[]).map(safeChange);
      heroes[id] = { verdict: b.newHeroes.includes(id) ? 'new' : verdictOf(changes), changes };
    }
    const rec: ParsedPatch = {
      date: b.date,
      title: b.title,
      url,
      kind: b.kind,
      // Raw lines feed the hash (they are never stored), so an edited or appended section shows up.
      contentHash: hash16(`${b.kind}|${b.date}|${b.text.join('\n')}|${b.general.join('\n')}`),
      notes: 'summary',
      general: generalSummary(b.general).filter(guard),
      heroes,
    };
    const maps = [...b.maps]
      .sort(([x], [y]) => compareStrings(x, y))
      .map(([slug, lines]) => [slug, mapSummary(lines).filter(guard)] as const)
      .filter(([, lines]) => lines.length > 0);
    if (maps.length > 0) rec.maps = Object.fromEntries(maps);
    if (b.newHeroes.length > 0) rec.newHeroes = [...b.newHeroes].sort(compareStrings);
    return rec;
  };
  return [...hotfixes, main].filter((b) => !b.empty()).map((b) => toRecord(b, meta.url));
}

// ---- last-good files from before the summaries ---------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []);
const GAME_DATA_NUMBERS = /^(.+?) (-?\d+(?:\.\d+)?)(%?) → (-?\d+(?:\.\d+)?)(%?)\.?$/;
const ENRICHED = /\s*\(game data: [^)]*\)\.?$/;

/** One stored change of an old record → our facts, keeping its place and direction. */
function migrateChange(list: PatchChange[], c: Record<string, unknown>): void {
  const text = typeof c.text === 'string' ? c.text : '';
  if (!text) return;
  const place: Place = { section: typeof c.section === 'string' && c.section ? c.section : 'Changes' };
  const added = typeof c.target === 'string' && NEW_LABEL_RE.test(c.target);
  const target = typeof c.target === 'string' ? c.target.replace(NEW_LABEL_RE, '') : '';
  if (target) place.target = target;
  if (typeof c.level === 'string' && (TALENT_TIERS as readonly string[]).includes(c.level)) place.level = c.level as TalentTier;
  const dir = typeof c.dir === 'string' ? (c.dir as ChangeDir) : undefined;
  const own = (kind: PatchChange['kind'], facts: Partial<PatchChange> = {}): void => {
    list.push({ ...place, kind, ...facts, text, ...(dir ? { dir } : {}) });
  };
  if (place.section === 'New Hero') return own('added');
  if (text === 'Full rework: new base abilities and talent tree.') return own('reworked');
  if (place.section === 'Game data') {
    // Always our own lines; numeric ones get their fields back.
    const m = GAME_DATA_NUMBERS.exec(text);
    if (m) {
      const facts: ChangeFacts = { kind: 'numeric', stat: m[1] as string, old: Number(m[2]), new: Number(m[4]) };
      if (m[3] || m[5]) facts.unit = '%';
      list.push({ ...place, ...facts, text: changeText(facts), ...(dir ? { dir } : {}) });
      return;
    }
    return own(/^New\b/.test(text) ? 'added' : /\bremoved\b/i.test(text) ? 'removed' : 'changed');
  }
  // Blizzard's sentence: summarise it like a freshly parsed line (game-data numbers are re-added
  // by enrichWithDiff when the record is assembled).
  const prefix = dir === 'rework' ? 'REWORK: ' : added ? 'NEW: ' : '';
  for (const f of summarizeLine(text.replace(ENRICHED, ''), `${prefix}${place.target ?? ''} ${place.section}`)) addFact(list, place, f);
}

/**
 * patches.json written before 2026-10-10 (records without `notes`) stored Blizzard's change
 * sentences. Re-summarises such records the way parseArticle does, so a run that cannot fetch an
 * article never carries those sentences forward. Anything else is returned unchanged.
 */
export function migrateLegacyPatches(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((r) => {
    if (!isObj(r) || 'notes' in r) return r;
    const heroes: Record<string, PatchHero> = {};
    for (const [id, h] of Object.entries(isObj(r.heroes) ? r.heroes : {})) {
      const list: PatchChange[] = [];
      for (const c of isObj(h) && Array.isArray(h.changes) ? h.changes : []) if (isObj(c)) migrateChange(list, c);
      if (list.length > 0) heroes[id] = { verdict: isObj(h) && h.verdict === 'new' ? 'new' : verdictOf(list), changes: list };
    }
    const out: Record<string, unknown> = { ...r, notes: 'summary', general: generalSummary(strings(r.general)), heroes };
    const maps = Object.entries(isObj(r.maps) ? r.maps : {})
      .map(([slug, lines]) => [slug, mapSummary(strings(lines))] as const)
      .filter(([, lines]) => lines.length > 0);
    if (maps.length > 0) out.maps = Object.fromEntries(maps);
    else delete out.maps;
    return out;
  });
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

