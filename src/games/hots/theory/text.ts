/**
 * Text helpers for the mechanics extractor: sentence splitting, name masking and
 * index-preserving blanking, so every regex hit can be traced back to the original sentence
 * for its evidence snippet. Browser-safe, pure.
 */

/** Longest evidence snippet (characters). */
export const SNIPPET_MAX = 120;

/** heroes.json renders per-level scaling as "(+4% per level)"; it never matters for tags. */
export function stripScaling(text: string): string {
  return text.replace(/\s*\(\+[0-9.]+% per level\)/g, '');
}

/** Normalises typography the game strings mix (curly quotes, non-breaking spaces). */
export function normalizeText(text: string): string {
  return stripScaling(text)
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/ /g, ' ')
    .replace(/[ \t]+/g, ' ');
}

/**
 * Splits rendered tooltip text into sentences: line breaks, then ". " / "! " / "? " followed by
 * an upper-case letter or digit (keeps "Lt. Morales" and "0.5 seconds" intact).
 */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of normalizeText(text).split(/\n+/)) {
    const parts = line.split(/(?<=[.!?])\s+(?=[A-Z0-9"(])/);
    for (const p of parts) {
      const s = p.trim();
      if (s) out.push(s);
    }
  }
  // Re-join splits after common abbreviations ("Lt. Morales", "Sgt. Hammer").
  const joined: string[] = [];
  for (const s of out) {
    const prev = joined.at(-1);
    if (prev !== undefined && /\b(?:Lt|Sgt|Dr|Mr|Mrs|St)\.$/.test(prev)) joined[joined.length - 1] = `${prev} ${s}`;
    else joined.push(s);
  }
  return joined;
}

/** Replaces every match of `re` (global) with spaces of the same length. */
export function blank(text: string, re: RegExp): string {
  return text.replace(re, (m) => ' '.repeat(m.length));
}

/** Replaces each occurrence of `phrase` (whole words, case-sensitive) with `§` characters. */
export function maskPhrase(text: string, phrase: string): string {
  if (!phrase) return text;
  const re = new RegExp(`(?<![\\w'])${escapeRegExp(phrase)}(?![\\w])`, 'g');
  return text.replace(re, (m) => '§'.repeat(m.length));
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A snippet of `sentence` of at most SNIPPET_MAX characters that contains position `at`
 * (cut at word boundaries, with an ellipsis where text was dropped).
 */
export function snippetAround(sentence: string, at: number, length = 0): string {
  const s = sentence.trim();
  if (s.length <= SNIPPET_MAX) return s;
  const budget = SNIPPET_MAX - 2;
  const centre = Math.max(0, Math.min(s.length, at + Math.floor(length / 2)));
  let start = Math.max(0, centre - Math.floor(budget / 2));
  let end = Math.min(s.length, start + budget);
  start = Math.max(0, end - budget);
  if (start > 0) {
    const sp = s.indexOf(' ', start);
    if (sp !== -1 && sp < centre) start = sp + 1;
  }
  if (end < s.length) {
    const sp = s.lastIndexOf(' ', end);
    if (sp > centre) end = sp;
  }
  const body = s.slice(start, end).trim();
  return `${start > 0 ? '…' : ''}${body}${end < s.length ? '…' : ''}`;
}
