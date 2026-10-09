/**
 * Alias-aware entity search for grids, pickers and the site search box. Small and synchronous:
 * a HotS roster is ~100 entries, a Pokémon dex ~350, a card index tens of thousands, all fine
 * for a linear scan per keystroke.
 *
 * Ranking: exact > prefix > token-prefix > substring > subsequence; within a tier, name matches
 * beat aliases beat extras, shorter keys beat longer ones, then name and id order.
 */

export interface SearchEntity {
  id: string;
  name: string;
  aliases?: readonly string[];
  /** Low-priority extra text (role, type, set name …). */
  extra?: string | readonly string[];
}

export type MatchTier = 'exact' | 'prefix' | 'token-prefix' | 'substring' | 'subsequence';
export type MatchField = 'name' | 'alias' | 'extra';

export interface SearchHit {
  id: string;
  tier: MatchTier;
  field: MatchField;
  /** The normalized key that matched. */
  key: string;
}

const TIER_RANK: Record<MatchTier, number> = { exact: 0, prefix: 1, 'token-prefix': 2, substring: 3, subsequence: 4 };
const FIELD_RANK: Record<MatchField, number> = { name: 0, alias: 1, extra: 2 };
const APOSTROPHES = /['’‘`´ʼ]/g;

function fold(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
}

function tidy(text: string): string {
  return text
    .replace(APOSTROPHES, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Canonical search form: accents folded (Lúcio → lucio), lowercase, possessive 's dropped
 * (Thrall's → thrall), apostrophes removed without a gap (Kel'Thuzad → kelthuzad), any other
 * punctuation turned into single spaces (Li-Ming → "li ming", E.T.C. → "e t c").
 */
export function normalize(text: string): string {
  return tidy(fold(text).replace(/['’‘`´ʼ]s(?![\p{L}\p{N}])/gu, ''));
}

/** {@link normalize} without spaces: "li ming" and "liming" share "liming". */
export function compactKey(text: string): string {
  return normalize(text).replace(/ /g, '');
}

interface Key {
  spaced: string;
  compact: string;
  tokens: string[];
  field: MatchField;
}

interface Entry {
  id: string;
  order: number;
  sortName: string;
  keys: Key[];
}

function makeKeys(text: string, fieldName: MatchField): Key[] {
  const variants = new Set<string>([normalize(text), tidy(fold(text))]);
  const out: Key[] = [];
  for (const spaced of variants) {
    if (!spaced) continue;
    out.push({ spaced, compact: spaced.replace(/ /g, ''), tokens: spaced.split(' '), field: fieldName });
  }
  return out;
}

function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) if (hay[j] === needle[i]) i++;
  return i === needle.length;
}

function matchTier(q: { spaced: string; compact: string; tokens: string[] }, k: Key): MatchTier | null {
  if (k.spaced === q.spaced || k.compact === q.compact) return 'exact';
  if (k.spaced.startsWith(q.spaced) || k.compact.startsWith(q.compact)) return 'prefix';
  if (q.tokens.every((t) => k.tokens.some((kt) => kt.startsWith(t)))) return 'token-prefix';
  if (q.compact.length >= 2 && k.compact.includes(q.compact)) return 'substring';
  if (q.compact.length >= 2 && isSubsequence(q.compact, k.compact)) return 'subsequence';
  return null;
}

export interface SearchIndex {
  readonly size: number;
  /** Ranked ids. A blank query returns every id in input order. */
  search(query: string, limit?: number): string[];
  /** Ranked hits with the tier and field that matched (blank query → []). */
  hits(query: string, limit?: number): SearchHit[];
}

const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

export function createSearchIndex(entities: readonly SearchEntity[]): SearchIndex {
  const entries: Entry[] = [];
  const seen = new Set<string>();
  entities.forEach((e, order) => {
    if (seen.has(e.id)) return;
    seen.add(e.id);
    const extras = e.extra === undefined ? [] : typeof e.extra === 'string' ? [e.extra] : e.extra;
    entries.push({
      id: e.id,
      order,
      sortName: normalize(e.name),
      keys: [
        ...makeKeys(e.name, 'name'),
        ...(e.aliases ?? []).flatMap((a) => makeKeys(a, 'alias')),
        ...extras.flatMap((x) => makeKeys(x, 'extra')),
      ],
    });
  });

  const hits = (query: string, limit = Number.POSITIVE_INFINITY): SearchHit[] => {
    const spaced = normalize(query);
    if (!spaced) return [];
    const q = { spaced, compact: spaced.replace(/ /g, ''), tokens: spaced.split(' ') };
    const scored: { hit: SearchHit; entry: Entry; keyLength: number }[] = [];
    for (const entry of entries) {
      let best: { hit: SearchHit; keyLength: number } | null = null;
      for (const k of entry.keys) {
        const tier = matchTier(q, k);
        if (!tier) continue;
        const better =
          !best ||
          TIER_RANK[tier] < TIER_RANK[best.hit.tier] ||
          (TIER_RANK[tier] === TIER_RANK[best.hit.tier] &&
            (FIELD_RANK[k.field] < FIELD_RANK[best.hit.field] ||
              (FIELD_RANK[k.field] === FIELD_RANK[best.hit.field] && k.compact.length < best.keyLength)));
        if (better) best = { hit: { id: entry.id, tier, field: k.field, key: k.spaced }, keyLength: k.compact.length };
      }
      if (best) scored.push({ ...best, entry });
    }
    scored.sort(
      (x, y) =>
        TIER_RANK[x.hit.tier] - TIER_RANK[y.hit.tier] ||
        FIELD_RANK[x.hit.field] - FIELD_RANK[y.hit.field] ||
        x.keyLength - y.keyLength ||
        cmp(x.entry.sortName, y.entry.sortName) ||
        cmp(x.entry.id, y.entry.id),
    );
    return scored.slice(0, limit).map((s) => s.hit);
  };

  return {
    size: entries.length,
    hits,
    search: (query, limit = Number.POSITIVE_INFINITY) => {
      if (!normalize(query)) return entries.slice(0, limit).map((e) => e.id);
      return hits(query, limit).map((h) => h.id);
    },
  };
}
