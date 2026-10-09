/**
 * Search aliases for heroes.json (SPEC §8 alias search, critique D4).
 *
 * Sources, all lowercased:
 *  1. curated/hots/aliases.yaml (nicknames, punctuation variants);
 *  2. the outbound slug when it differs from ours (`li-ming`, `the-butcher`);
 *  3. the hero's name in the other 11 game locales (`리밍`, `диабло`);
 *  4. name-like tokens from the enUS `searchText` game string: a token is kept only when no
 *     other hero's searchText has it AND it looks like a spelling of the hero (edit distance ≤ 2
 *     from the name, slug or internal id) or is a 2–4 letter all-caps abbreviation (`KT`, `TLV`).
 *     searchText also lists generic words ("Stun", "Burst", "Tank"); those are dropped so a
 *     search for a mechanic never jumps to one hero.
 */
import { compareStrings, outboundSlug, searchKey } from '../util.ts';

export interface AliasInput {
  /** Our slug (`liming`). */
  slug: string;
  /** English name (`Li-Ming`). */
  name: string;
  /** heroes-data2 key (`Wizard`) and hyperlink id (`LiMing`). */
  internalIds: readonly string[];
  /** enUS searchText. */
  searchText?: string | undefined;
  /** Localized names from other locales. */
  localizedNames: readonly string[];
  /** Curated aliases for this slug. */
  curated: readonly string[];
}

/** Levenshtein distance with an early exit above `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min((prev[j] ?? 0) + 1, (cur[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length] ?? max + 1;
}

function tokens(searchText: string | undefined): string[] {
  return (searchText ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
}

/** searchKey → number of heroes whose searchText contains it. */
export function searchTextOwners(all: readonly AliasInput[]): Map<string, number> {
  const owners = new Map<string, number>();
  for (const h of all) {
    for (const key of new Set(tokens(h.searchText).map(searchKey).filter(Boolean))) owners.set(key, (owners.get(key) ?? 0) + 1);
  }
  return owners;
}

function looksLikeName(token: string, h: AliasInput): boolean {
  const key = searchKey(token);
  if (key.length < 3) return /^[A-Z]{2,4}\d?$/.test(token);
  if (/^[A-Z]{2,4}\d?$/.test(token)) return true;
  const targets = [h.name, h.slug, ...h.internalIds].map(searchKey).filter(Boolean);
  return targets.some((t) => t === key || editDistance(t, key, 2) <= 2);
}

export function buildAliases(h: AliasInput, owners: ReadonlyMap<string, number>): string[] {
  const out = new Set<string>();
  const add = (raw: string): void => {
    const a = raw.normalize('NFC').toLowerCase().replace(/\s+/g, ' ').trim();
    if (a && a !== h.slug) out.add(a);
  };
  for (const a of h.curated) add(a);
  const ob = outboundSlug(h.name);
  if (ob !== h.slug) add(ob);
  // The name itself when punctuation or spaces make it differ from the slug ("xal'atath", "the butcher").
  add(h.name);
  for (const n of h.localizedNames) add(n);
  for (const t of tokens(h.searchText)) {
    const key = searchKey(t);
    if (!key || (owners.get(key) ?? 0) !== 1) continue;
    if (looksLikeName(t, h)) add(t);
  }
  return [...out].sort(compareStrings);
}
