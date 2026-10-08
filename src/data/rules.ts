import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { USER_AGENT } from '../version.js';
import type { FetchLike } from './scryfall.js';

/*
 * The Comprehensive Rules are downloaded from Wizards at runtime and cached; the text is
 * never committed to this repo. Wizards changes the file name with every update, so the
 * current .txt link is discovered from the rules page.
 */
export const RULES_PAGE = 'https://magic.wizards.com/en/rules';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface Rule {
  number: string;
  text: string;
  examples: string[];
}

export interface RulesDoc {
  effective?: string;
  source: string;
  rules: Rule[];
  byNumber: Map<string, Rule>;
  glossary: Map<string, { term: string; definition: string }>;
}

export function findRulesTxtUrl(html: string): string | null {
  const m = /https:\/\/media\.wizards\.com\/[^"'<>\s]*?MagicCompRules[^"'<>]*?\.txt/i.exec(html);
  return m ? m[0].replace(/ /g, '%20') : null;
}

const RULE_LINE = /^(\d{1,3}(?:\.\d+[a-z]?)?)\.?\s+(\S.*)$/;

export function parseRules(text: string, source: string): RulesDoc {
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim());
  const effective = /effective as of ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(text)?.[1];

  // The table of contents repeats the headings, so the body starts at the second "1. Game Concepts".
  const starts = lines.flatMap((l, i) => (/^1\.\s+Game Concepts$/.test(l) ? [i] : []));
  const glossaryAt = lines.flatMap((l, i) => (l === 'Glossary' ? [i] : []));
  const creditsAt = lines.flatMap((l, i) => (l === 'Credits' ? [i] : []));
  const bodyStart = starts[1] ?? starts[0] ?? 0;
  const glossaryStart = glossaryAt.find((i) => i > bodyStart) ?? lines.length;
  const glossaryEnd = creditsAt.find((i) => i > glossaryStart) ?? lines.length;

  const rules: Rule[] = [];
  for (let i = bodyStart; i < glossaryStart; i++) {
    const line = lines[i]!;
    if (!line) continue;
    if (/^Example:/.test(line)) {
      rules[rules.length - 1]?.examples.push(line.replace(/^Example:\s*/, ''));
      continue;
    }
    const m = RULE_LINE.exec(line);
    if (m) rules.push({ number: m[1]!, text: m[2]!, examples: [] });
    else if (rules.length) rules[rules.length - 1]!.text += ` ${line}`;
  }

  const glossary = new Map<string, { term: string; definition: string }>();
  let term: string | null = null;
  let def: string[] = [];
  const flush = () => {
    if (term && def.length) glossary.set(term.toLowerCase(), { term, definition: def.join(' ') });
    term = null;
    def = [];
  };
  for (let i = glossaryStart + 1; i < glossaryEnd; i++) {
    const line = lines[i]!;
    if (!line) flush();
    else if (term === null) term = line;
    else def.push(line);
  }
  flush();

  return { ...(effective ? { effective } : {}), source, rules, byNumber: new Map(rules.map((r) => [r.number, r])), glossary };
}

/** A rule plus its subrules (e.g. 702.19 → 702.19a, 702.19b…); a section (702) lists its rules. */
export function lookupNumber(doc: RulesDoc, number: string, limit = 40): Rule[] {
  const key = number.trim().replace(/\.$/, '');
  const exact = doc.byNumber.get(key);
  const children = doc.rules.filter(
    (r) => r.number !== key && (r.number.startsWith(`${key}.`) || (/\d$/.test(key) && new RegExp(`^${escape(key)}[a-z]$`).test(r.number))),
  );
  return [...(exact ? [exact] : []), ...children].slice(0, limit);
}

function escape(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function searchRules(doc: RulesDoc, query: string, limit = 10) {
  const q = query.trim().toLowerCase();
  const terms = q.split(/\s+/).filter((t) => t.length > 1);
  const glossary = doc.glossary.get(q);
  const scored = doc.rules
    .map((r) => {
      const text = r.text.toLowerCase();
      let score = text.includes(q) ? 10 : 0;
      for (const t of terms) if (text.includes(t)) score += 1;
      return { r, score };
    })
    .filter((x) => x.score >= Math.max(1, terms.length))
    .sort((a, b) => b.score - a.score || a.r.number.length - b.r.number.length || cmpRule(a.r.number, b.r.number))
    .slice(0, limit)
    .map((x) => x.r);
  return { glossary: glossary ?? null, rules: scored };
}

function cmpRule(a: string, b: string) {
  return a.localeCompare(b, 'en', { numeric: true });
}

export interface RulesStoreOptions {
  dir: string;
  fetch: FetchLike;
  online: boolean;
  now?: () => number;
}

let memo: { key: string; doc: RulesDoc } | undefined;

/** Loads the cached rules, refreshing from Wizards when the cache is over a week old. */
export async function loadRules(opts: RulesStoreOptions): Promise<RulesDoc> {
  const now = opts.now ?? Date.now;
  const dir = path.join(opts.dir, 'rules');
  const metaFile = path.join(dir, 'rules.json');
  const textFile = path.join(dir, 'rules.txt');
  const cached = existsSync(metaFile) && existsSync(textFile)
    ? (JSON.parse(readFileSync(metaFile, 'utf8')) as { url: string; fetchedAt: number })
    : null;

  if (cached && (!opts.online || now() - cached.fetchedAt < MAX_AGE_MS)) return parseCached(cached.url, textFile);
  if (!opts.online) throw new Error('The Comprehensive Rules are not cached yet and network access is off.');

  try {
    const headers = { 'User-Agent': USER_AGENT, Accept: 'text/html,text/plain;q=0.9,*/*;q=0.8' };
    const page = await opts.fetch(RULES_PAGE, { headers });
    const url = findRulesTxtUrl(await page.text());
    if (!url) throw new Error('could not find the rules .txt link on the Wizards rules page');
    if (!cached || cached.url !== url) {
      const res = await opts.fetch(url, { headers });
      if (!res.ok) throw new Error(`rules download failed: HTTP ${res.status}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      mkdirSync(dir, { recursive: true });
      writeFileSync(textFile, decodeRules(bytes));
    }
    writeFileSync(metaFile, JSON.stringify({ url, fetchedAt: now() }));
    return parseCached(url, textFile);
  } catch (err) {
    if (cached) return parseCached(cached.url, textFile);
    throw err;
  }
}

/** Wizards has shipped the rules as UTF-8 and as Windows-1252 over the years. */
function decodeRules(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

function parseCached(url: string, textFile: string): RulesDoc {
  const key = `${url}|${textFile}`;
  if (memo?.key === key) return memo.doc;
  const doc = parseRules(readFileSync(textFile, 'utf8'), url);
  memo = { key, doc };
  return doc;
}
