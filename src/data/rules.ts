import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { USER_AGENT } from '../version.js';
import type { FetchLike } from './scryfall.js';
import { findRulesTxtUrl, parseRules, type RulesDoc } from '../core/rules.js';

export { findRulesTxtUrl, lookupNumber, parseRules, type Rule, type RulesDoc, searchRules } from '../core/rules.js';

/*
 * The Comprehensive Rules are downloaded from Wizards at runtime and cached; the text is
 * never committed to this repo. Wizards changes the file name with every update, so the
 * current .txt link is discovered from the rules page.
 */
export const RULES_PAGE = 'https://magic.wizards.com/en/rules';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

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
