/**
 * Our own structured summaries of patch-note lines (patches.json). Pure.
 *
 * Blizzard's change sentences are read, never stored. Each line becomes facts in our own terms:
 *  - numeric: a short label for the value that changed, old → new numbers (or a signed "by"
 *    amount) with a unit, and a computed buff/nerf direction ("Damage 345 → 360");
 *  - qualitative: what kind of change it is (added, removed, reworked, changed, bug fix), written
 *    as a fixed template ("Effect changed (see Blizzard's notes)") and never in the original words.
 * General and map lines are kept as categories with counts; the record links the article.
 *
 * `longestSharedRun` measures how many consecutive words a stored string shares with its source;
 * parseArticle replaces anything that reaches VERBATIM_LIMIT, and the tests assert none does.
 */
import type { ChangeDir, PatchChange } from './patches.ts';

export type ChangeKind = PatchChange['kind'];
export type ChangeUnit = NonNullable<PatchChange['unit']>;

/** The facts of one change: a PatchChange without its place (section, target, level) and text. */
export interface ChangeFacts {
  kind: ChangeKind;
  stat?: string;
  old?: number;
  new?: number;
  by?: number;
  unit?: ChangeUnit;
  dir?: ChangeDir;
}

/** Points readers to the article (each record carries its URL) instead of quoting it. */
export const SEE_NOTES = "(see Blizzard's notes)";
/** A stored string sharing this many consecutive words with its source is treated as copied. */
export const VERBATIM_LIMIT = 8;
/** Stat labels taken from a line are at most this many words; longer subjects use VOCABULARY. */
export const MAX_LABEL_WORDS = 4;

// ---- numbers ---------------------------------------------------------------------------------

const NUM = String.raw`(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)`;
const UNIT = String.raw`(?:\s*(%|seconds?\b|secs?\b|s\b))?`;
const INCREASE = 'increased|raised|improved|extended|lengthened|buffed';
const DECREASE = 'reduced|lowered|decreased|shortened|cut|nerfed';
const CHANGE_VERB = new RegExp(String.raw`\b(?:${INCREASE}|${DECREASE}|increases|reduces|changed|adjusted|modified|updated|bumped|dropped|scaled)\b`, 'i');

/** "… from A … to B" */
const FROM_TO = new RegExp(String.raw`\bfrom\s+(${NUM})${UNIT}(?:[^.;]|\.(?=\d))*?\bto\s+(${NUM})${UNIT}`, 'gi');
/** "… to B, up/down from A" */
const TO_FROM = new RegExp(String.raw`\bto\s+(${NUM})${UNIT}[^,.;]*?,?\s*\b(?:up|down)\s+from\s+(${NUM})${UNIT}`, 'gi');
/** "A → B" */
const ARROW = new RegExp(String.raw`(${NUM})${UNIT}\s*(?:→|->)\s*(${NUM})${UNIT}`, 'gi');
/** "increased by N" / "reduced by N" */
const BY = new RegExp(String.raw`\b(${INCREASE}|${DECREASE})\s+by\s+(${NUM})${UNIT}`, 'gi');

function toNumber(text: string): number {
  return Number(text.replace(/,/g, '').replace(/^\./, '0.'));
}

function unitOf(...raw: (string | undefined)[]): ChangeUnit | undefined {
  if (raw.some((u) => u === '%')) return '%';
  if (raw.some((u) => u !== undefined && /^s|^sec/i.test(u))) return 's';
  return undefined;
}

// ---- direction -------------------------------------------------------------------------------

const LOWER_IS_BETTER =
  /\b(cooldowns?|costs?|mana|delay|cast time|channel(?:ing)? time|channel duration|requirements?|required|time to|every\s+[\d.]+\s+seconds?|wind-?up|charge time|damage taken|self[- ]damage)\b/i;

/**
 * Whether less of the quantity named in `subject` is better for the hero: cooldowns, costs,
 * delays and requirements are; "cooldown reduction", "Mana refund" and the like are not.
 */
export function lowerIsBetter(subject: string, line: string, hasOld: boolean): boolean {
  let lower =
    LOWER_IS_BETTER.test(subject) &&
    !/\b(cooldowns?|costs?|mana)\s+(reduction|refunds?|refresh|restored?|regen(?:eration)?|return(?:ed)?)\b/i.test(subject);
  if (/\bdecay\b/i.test(subject) && !/\breduction\b/i.test(subject)) lower = true;
  if (/\bnow strikes every\b|\bevery\s+[\d.]+\s+seconds?\b/i.test(line) && hasOld) lower = true;
  return lower;
}

function signedDir(sign: number, subject: string, line: string, hasOld: boolean): ChangeDir {
  if (sign === 0) return 'change';
  return (sign > 0) !== lowerIsBetter(subject, line, hasOld) ? 'buff' : 'nerf';
}

// ---- labels ----------------------------------------------------------------------------------

/** Our own names for the values patch notes change, matched when a line's subject is long. */
const VOCABULARY = [
  'Basic Attack damage', 'Basic Attack range', 'Attack Speed', 'Movement Speed', 'Spell Power', 'Spell Armor',
  'Physical Armor', 'Armor', 'Health Regeneration', 'Mana Regeneration', 'Mana cost', 'Cooldown reduction', 'Cooldown',
  'Damage reduction', 'Damage bonus', 'Damage', 'Healing', 'Shield', 'Duration', 'Range', 'Radius', 'Slow', 'Stun',
  'Root', 'Silence', 'Charges', 'Cast time', 'Channel', 'Delay', 'Lifesteal', 'Width', 'Speed', 'Stacks', 'Requirement',
  'Health', 'Mana', 'Cost', 'Energy', 'Fury', 'Brew', 'Bonus', 'Threshold', 'Scaling', 'Experience', 'Penalty', 'Timer',
] as const;
const VOCAB_RE = VOCABULARY.map((v) => [v, new RegExp(String.raw`\b${v.replace(/ /g, String.raw`\s+`)}s?\b`, 'i')] as const);

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The words before a change verb or number: "Health", "Shield gained from Basic Attacks". */
export function cleanSubject(region: string): string {
  let s = region.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ');
  s = s.replace(/^[\s,;:–—-]*(?:(?:and|but|while|also|then|plus)\s+)*/i, '');
  s = s.replace(new RegExp(String.raw`[\s,]*(?:(?:has|have|had|is|are|was|were|will be)\s+)?(?:been\s+)?(?:${INCREASE}|${DECREASE}|changed|adjusted|modified|updated|bumped|dropped)?\s*$`, 'i'), '');
  s = s.replace(new RegExp(String.raw`^(?:${INCREASE}|${DECREASE}|changed|adjusted)\s+(?:the\s+)?(?:amount\s+of\s+)?`, 'i'), '');
  s = s.replace(/^(?:the|its|their|his|her|all)\s+/i, '');
  return s.replace(/[^\p{L}\p{N}'’ .%-]/gu, ' ').replace(/\s+/g, ' ').replace(/[\s.,;:-]+$/, '').trim();
}

/** A short label for the value: the subject when it is at most MAX_LABEL_WORDS words, else ours. */
export function statLabel(subject: string): string {
  const words = subject.split(' ').filter(Boolean);
  if (words.length > 0 && words.length <= MAX_LABEL_WORDS) return capitalise(subject);
  let best: { label: string; at: number } | null = null;
  for (const [label, re] of VOCAB_RE) {
    const m = re.exec(subject);
    if (m && (best === null || m.index < best.at || (m.index === best.at && label.length > best.label.length))) best = { label, at: m.index };
  }
  return best?.label ?? 'Value';
}

// ---- lines -----------------------------------------------------------------------------------

interface NumericHit {
  facts: ChangeFacts;
  /** Span of the line the hit explains (its subject and its numbers). */
  start: number;
  end: number;
}

interface Match {
  index: number;
  end: number;
  kind: 'pair' | 'by';
  oldV: number;
  newV: number;
  unit: ChangeUnit | undefined;
  /** Verb carried by the match itself ("by" amounts). */
  sign?: number;
  /** "from … to" needs a change verb before it ("now grows from 20 to 35" is not a change). */
  needsVerb: boolean;
}

function allMatches(line: string): Match[] {
  const out: Match[] = [];
  for (const m of line.matchAll(FROM_TO)) {
    out.push({ index: m.index, end: m.index + m[0].length, kind: 'pair', oldV: toNumber(m[1] as string), newV: toNumber(m[3] as string), unit: unitOf(m[2], m[4]), needsVerb: true });
  }
  for (const m of line.matchAll(TO_FROM)) {
    out.push({ index: m.index, end: m.index + m[0].length, kind: 'pair', oldV: toNumber(m[3] as string), newV: toNumber(m[1] as string), unit: unitOf(m[2], m[4]), needsVerb: false });
  }
  for (const m of line.matchAll(ARROW)) {
    out.push({ index: m.index, end: m.index + m[0].length, kind: 'pair', oldV: toNumber(m[1] as string), newV: toNumber(m[3] as string), unit: unitOf(m[2], m[4]), needsVerb: false });
  }
  for (const m of line.matchAll(BY)) {
    const sign = new RegExp(`^(?:${INCREASE})$`, 'i').test(m[1] as string) ? 1 : -1;
    out.push({ index: m.index, end: m.index + m[0].length, kind: 'by', oldV: 0, newV: toNumber(m[2] as string), unit: unitOf(m[3]), sign, needsVerb: false });
  }
  return out.sort((a, b) => a.index - b.index || b.end - a.end);
}

/** Lines that introduce new or replaced behaviour are summarised as qualitative, whatever numbers they quote. */
const BEHAVIOUR_LINE = /^(?:new\b|now\b|no longer\b|can now\b|can no longer\b|will now\b|quest\b|reward\b|passive\b|active\b|rework)/i;

function numericHits(line: string, context: string): NumericHit[] {
  if (BEHAVIOUR_LINE.test(line)) return [];
  const hits: NumericHit[] = [];
  let prevEnd = 0;
  for (const m of allMatches(line)) {
    if (m.index < prevEnd) continue;
    const sentenceStart = Math.max(prevEnd, ...[...line.slice(0, m.index).matchAll(/[.;:!?](?=\s)/g)].map((x) => x.index + 1));
    const region = line.slice(sentenceStart, m.index);
    if (m.needsVerb && !CHANGE_VERB.test(region)) continue;
    if (m.kind === 'pair' && (!Number.isFinite(m.oldV) || !Number.isFinite(m.newV) || m.oldV === m.newV)) continue;
    const subject = cleanSubject(region);
    const stat = statLabel(subject);
    const scope = `${region} ${context}`;
    const facts: ChangeFacts =
      m.kind === 'by'
        ? { kind: 'numeric', stat, by: (m.sign ?? 1) * m.newV, dir: signedDir(m.sign ?? 1, scope, line, false) }
        : { kind: 'numeric', stat, old: m.oldV, new: m.newV, dir: signedDir(Math.sign(m.newV - m.oldV), scope, line, true) };
    if (m.unit) facts.unit = m.unit;
    hits.push({ facts, start: sentenceStart, end: m.end });
    prevEnd = m.end;
  }
  return hits;
}

/** What a line without usable numbers does, in our categories. */
export function qualitativeKind(line: string): Exclude<ChangeKind, 'numeric'> {
  const t = line.toLowerCase();
  if (/\b(?:fix(?:ed|es)?|bugs?|exploits?)\b|\bissue where\b|\bno longer (?:incorrectly|unintentionally|erroneously)\b/.test(t)) return 'bugfix';
  if (/\brework(?:ed)?\b|\bredesign(?:ed)?\b|\bnew functionality\b|\breplace[sd]?\b/.test(t)) return 'reworked';
  if (/\binstead of\b|\brather than\b/.test(t)) return 'changed';
  if (/\bno longer\b|\bremoved\b/.test(t)) return 'removed';
  if (/^(?:new\b|added\b|now also\b|can now\b|additionally\b)|\bhas been added\b|\bhave been added\b|\bnew (?:quest|baseline|effect|ability|talent|passive|active)\b/.test(t)) return 'added';
  return 'changed';
}

/**
 * Direction of a qualitative line: 'rework' for rework wording, buff/nerf from "increased"/"reduced"
 * wording, 'change' for "Now …"/"No longer …" lines, else undefined.
 */
export function qualitativeDir(text: string, context = ''): ChangeDir | undefined {
  const t = text.replace(/\s+/g, ' ');
  if (/\brework(?:ed)?\b|\bredesigned\b/i.test(t) || /^rework:/i.test(context)) return 'rework';
  if (!/\bno longer\b/i.test(t)) {
    const v = /\b(increased|increases|raised|improved|extended|faster|more)\b|\b(reduced|reduces|decreased|lowered|shortened|slower|less|fewer)\b/i.exec(t);
    if (v) {
      const head = t.slice(0, v.index);
      const clauseStart = Math.max(0, ...[...head.matchAll(/[.:;](?=\s)/g)].map((x) => (x.index ?? 0) + 1));
      return signedDir(v[1] ? 1 : -1, `${head.slice(clauseStart)} ${context}`, t, false);
    }
  }
  if (/^(now|no longer|can now|can no longer|will now|is now|are now|new)\b/i.test(t) || /\b(moved|replaced|changed|swapped|now|removed|disabled|added|no longer)\b/i.test(t)) {
    return 'change';
  }
  return undefined;
}

/** Words left once the explained spans (and parentheticals) are cut out. */
function leftoverWords(line: string, hits: readonly NumericHit[]): string {
  let rest = '';
  let at = 0;
  for (const h of hits) {
    rest += ` ${line.slice(at, h.start)}`;
    at = h.end;
  }
  rest += ` ${line.slice(at)}`;
  return rest.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A change line → the facts we keep (numbers first, then one qualitative entry for the rest). */
export function summarizeLine(line: string, context = ''): ChangeFacts[] {
  const rework = /^rework:/i.test(context);
  const hits = numericHits(line, context);
  const out: ChangeFacts[] = hits.map((h) => (rework ? { ...h.facts, dir: 'rework' } : h.facts));
  const rest = hits.length > 0 ? leftoverWords(line, hits) : line;
  const restWords = rest.split(' ').filter((w) => /\p{L}{2,}/u.test(w) && !/^(?:and|but|or|the|a|an|of|to|seconds?|per|level)$/i.test(w));
  if (hits.length === 0 || restWords.length >= 3) {
    // Under a "(New)" label every description line belongs to the new talent or ability.
    const facts: ChangeFacts = { kind: /^new:/i.test(context) ? 'added' : qualitativeKind(rest) };
    const dir = qualitativeDir(rest, context);
    if (dir) facts.dir = dir;
    out.push(facts);
  }
  return out;
}

// ---- text ------------------------------------------------------------------------------------

function fmt(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

function withUnit(n: number, unit: ChangeUnit | undefined): string {
  return unit === 's' ? `${fmt(n)} s` : unit === '%' ? `${fmt(n)}%` : fmt(n);
}

const QUALITATIVE: Record<Exclude<ChangeKind, 'numeric'>, [one: string, many: (n: number) => string]> = {
  added: ['New effect', (n) => `${n} new effects`],
  removed: ['Effect removed', (n) => `${n} effects removed`],
  reworked: ['Reworked', (n) => `Reworked (${n} notes)`],
  changed: ['Effect changed', (n) => `${n} effect changes`],
  bugfix: ['Bug fix', (n) => `${n} bug fixes`],
};

/**
 * The stored sentence for a change, built only from its facts: "Damage 345 → 360",
 * "Cooldown 12 s → 10 s", "Uncharged damage −20%", "Effect changed (see Blizzard's notes)".
 * `gameData` adds numbers from the game-data diff to a qualitative line.
 */
export function changeText(c: ChangeFacts & { count?: number }, gameData?: string): string {
  if (c.kind === 'numeric') {
    const stat = c.stat ?? 'Value';
    if (c.by !== undefined) return `${stat} ${c.by < 0 ? '−' : '+'}${withUnit(Math.abs(c.by), c.unit)}`;
    return `${stat} ${withUnit(c.old ?? 0, c.unit)} → ${withUnit(c.new ?? 0, c.unit)}`;
  }
  const [one, many] = QUALITATIVE[c.kind];
  const head = (c.count ?? 1) > 1 ? many(c.count ?? 1) : one;
  return `${head}${gameData ? `; game data: ${gameData}` : ''} ${SEE_NOTES}`;
}

// ---- general and map lines ---------------------------------------------------------------------

/** Our categories for general (system) lines, checked in order; the last one catches the rest. */
export const GENERAL_CATEGORIES: readonly (readonly [category: string, test: RegExp])[] = [
  ['Bug fixes', /\b(?:fix(?:ed|es)?|bugs?|exploits?)\b|\bissue where\b/i],
  ['Modes and matchmaking', /\b(?:storm league|ranked|unranked|matchmak\w*|quick match|party|parties|brawls?|custom games?|aram|game modes?|draft|placement)\b/i],
  ['Collection and rewards', /\b(?:bundles?|purchase|shop|loot|gems?|shards?|skins?|mounts?|portraits?|sprays?|banners?|emojis?|announcers?|voice ?lines?|rewards?)\b/i],
  ['Interface and audio', /\b(?:music|sounds?|audio|announcements?|pings?|homescreen|interface|ui|menus?|chat|tooltips?|icons?|colou?rs?|visibility|display\w*|loading screens?|names?)\b/i],
  ['Maps and structures', /\b(?:forts?|keeps?|cores?|towers?|structures?|mercenar\w*|camps?|minions?|battlegrounds?|maps?|objectives?|watch towers?)\b/i],
  ['Gameplay', /\b(?:respawn\w*|xp|experience|levels?|comeback|quests?|summon\w*|abilit\w*|attacks?|talents?|heroes|hero|armor|damage|healing|cooldowns?)\b/i],
  ['Other', /.*/],
];

export function generalCategory(line: string): string {
  return GENERAL_CATEGORIES.find(([, re]) => re.test(line))?.[0] ?? 'Other';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** General lines → "Interface and audio: 2 changes", one line per category in GENERAL_CATEGORIES order. */
export function generalSummary(lines: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const l of lines) counts.set(generalCategory(l), (counts.get(generalCategory(l)) ?? 0) + 1);
  return GENERAL_CATEGORIES.map(([c]) => c)
    .filter((c) => counts.has(c))
    .map((c) => `${c}: ${plural(counts.get(c) ?? 0, 'change', 'changes')}`);
}

/** One map's lines → its numeric changes as templates, then a count of the other changes. */
export function mapSummary(lines: readonly string[]): string[] {
  const out: string[] = [];
  let other = 0;
  for (const line of lines) {
    for (const f of summarizeLine(line)) {
      if (f.kind === 'numeric') {
        const t = changeText(f);
        if (!out.includes(t)) out.push(t);
      } else other++;
    }
  }
  if (other > 0) out.push(`${plural(other, out.length > 0 ? 'other change' : 'change', out.length > 0 ? 'other changes' : 'changes')} ${SEE_NOTES}`);
  return out;
}

// ---- verbatim check ----------------------------------------------------------------------------

/** Lower-case words (letters and digits, inner apostrophes kept). */
export function words(text: string): string[] {
  return (text.toLowerCase().replace(/’/g, "'").match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) ?? []);
}

/** Index of every run of VERBATIM_LIMIT consecutive words in the source texts. */
export function sourceRuns(texts: readonly string[], n = VERBATIM_LIMIT): Set<string> {
  const runs = new Set<string>();
  for (const t of texts) {
    const w = words(t);
    for (let i = 0; i + n <= w.length; i++) runs.add(w.slice(i, i + n).join(' '));
  }
  return runs;
}

/** True when `text` repeats VERBATIM_LIMIT (or `n`) consecutive words indexed by sourceRuns. */
export function copiesSource(text: string, runs: ReadonlySet<string>, n = VERBATIM_LIMIT): boolean {
  const w = words(text);
  for (let i = 0; i + n <= w.length; i++) if (runs.has(w.slice(i, i + n).join(' '))) return true;
  return false;
}

/** Longest run of consecutive words `text` shares with `source` (for tests and reports). */
export function longestSharedRun(text: string, source: string): number {
  const a = words(text);
  const b = words(source);
  let best = 0;
  const prev = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    let diag = 0;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j] as number;
      prev[j] = a[i - 1] === b[j - 1] ? diag + 1 : 0;
      if ((prev[j] as number) > best) best = prev[j] as number;
      diag = up;
    }
  }
  return best;
}
