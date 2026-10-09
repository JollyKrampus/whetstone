/**
 * Build-to-build game-data diff per hero (diffs.json, SPEC §5): base stats, abilities and
 * talents old → new, with numbers paired up when only numbers changed. Pure.
 *
 * Text diffs: both tooltips (per-level scaling annotations removed) are split into word, number
 * and punctuation tokens and aligned on their "shape" (numbers as #) with a longest common
 * subsequence. Aligned numbers that differ become one entry each, labelled with the nearest stat
 * word ("damage", "cooldown", "radius" …). Reworded parts become one `text` entry holding only
 * the old and new sentences that changed, so "each dealing 90 damage" → "72" is still a number
 * change when the sentence before it was rewritten.
 */
import { TALENT_TIERS, type Ability, type Diff, type DiffEntry, type TalentTier } from '../../schema.ts';
import { compareBuilds, compareStrings, round } from '../util.ts';
import { stripScaling } from './gametext.ts';
import type { HeroModel } from './heroes.ts';

const NUMBER_RE = /[+-]?\d+(?:\.\d+)?%?/g;
const MAX_TEXT = 600;

/** Words that name what a number measures (longest match wins at the same position). */
const FIELD_WORDS = [
  'mana cost', 'spell power', 'spell armor', 'physical armor', 'attack speed', 'movement speed', 'basic attack damage',
  'cooldown', 'damage', 'healing', 'heals', 'heal', 'shield', 'health', 'mana', 'armor', 'radius', 'range',
  'distance', 'width', 'duration', 'slowed', 'slow', 'stunned', 'stun', 'rooted', 'root', 'silenced', 'silence',
  'blinded', 'blind', 'speed', 'charges', 'stacks', 'hits', 'regeneration', 'cost', 'energy', 'fury', 'power',
];
/** Words that may label a number of seconds. */
const TIME_WORDS = ['cooldown', 'stunned', 'stun', 'rooted', 'root', 'silenced', 'silence', 'blinded', 'blind', 'slowed', 'slow', 'sleep', 'duration'];
const FIELD_ALIASES: Record<string, string> = {
  'mana cost': 'cost', heals: 'healing', heal: 'healing', slowed: 'slow', stunned: 'stun', rooted: 'root',
  silenced: 'silence', blinded: 'blind',
};

function shapeOf(text: string): { shape: string; numbers: string[] } {
  const plain = stripScaling(text);
  return { shape: plain.replace(NUMBER_RE, '#'), numbers: plain.match(NUMBER_RE) ?? [] };
}

function numeric(token: string): number | string {
  const n = Number(token.replace(/%$/, ''));
  return token.endsWith('%') || !Number.isFinite(n) ? token : n;
}

/** Stat word near the i-th number of a text (after it first, then before it). */
export function fieldNear(text: string, index: number): string {
  const plain = stripScaling(text);
  let count = -1;
  let pos = -1;
  let len = 0;
  for (const m of plain.matchAll(NUMBER_RE)) {
    count++;
    if (count === index) {
      pos = m.index ?? -1;
      len = m[0].length;
      break;
    }
  }
  if (pos < 0) return 'value';
  // The clause around the number: punctuation followed by a space (or a line break) ends it, so
  // decimals like "0.62" stay intact.
  const head = plain.slice(0, pos);
  const tail = plain.slice(pos + len);
  const clauseStart = Math.max(...[...head.matchAll(/[.,;:!?](?=\s)|\n/g)].map((m) => (m.index ?? -1) + 1), 0);
  const endMatch = /[.,;:!?](?=\s|$)|\n/.exec(tail);
  const before = head.slice(clauseStart).toLowerCase();
  const after = (endMatch ? tail.slice(0, endMatch.index) : tail).toLowerCase();
  const find = (s: string, fromEnd: boolean, words: readonly string[] = FIELD_WORDS): string | undefined => {
    const hits: { w: string; i: number }[] = [];
    for (const w of words) {
      const re = new RegExp(`\\b${w.replace(/ /g, '\\s+')}\\b`, 'g');
      for (const m of s.matchAll(re)) hits.push({ w, i: m.index ?? 0 });
    }
    if (hits.length === 0) return undefined;
    hits.sort((a, b) => (fromEnd ? b.i - a.i : a.i - b.i) || b.w.length - a.w.length);
    const w = hits[0]?.w as string;
    return FIELD_ALIASES[w] ?? w;
  };
  if (/^\s*seconds?\b/.test(after)) {
    if (/\bafter\s*$/.test(before)) return 'delay';
    return find(before, true, TIME_WORDS) ?? 'duration';
  }
  return find(before, true) ?? find(after, false) ?? 'value';
}

interface Token {
  text: string;
  /** Lowercased word, punctuation, or '#' for a number. */
  shape: string;
  sentence: number;
  /** Index among the text's numbers (same order as NUMBER_RE / fieldNear). */
  num?: number;
}

const TOKEN_RE = /[+-]?\d+(?:\.\d+)?%?|[\p{L}'’]+|[^\s\p{L}\d]/gu;

function tokenize(plain: string): { tokens: Token[]; sentences: string[] } {
  const sentences = plain
    .split(/\n+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const tokens: Token[] = [];
  let num = 0;
  sentences.forEach((s, sentence) => {
    for (const m of s.matchAll(TOKEN_RE)) {
      const text = m[0];
      if (/^[+-]?\d/.test(text)) tokens.push({ text, shape: '#', sentence, num: num++ });
      else tokens.push({ text, shape: text.toLowerCase(), sentence });
    }
  });
  return { tokens, sentences };
}

/** Index pairs of a longest common subsequence of two shape lists. */
function lcsPairs(a: readonly string[], b: readonly string[]): [number, number][] {
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i] as Uint16Array;
    const below = dp[i + 1] as Uint16Array;
    for (let j = m - 1; j >= 0; j--) row[j] = a[i] === b[j] ? (below[j + 1] as number) + 1 : Math.max(below[j] as number, row[j + 1] as number);
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      pairs.push([i, j]);
      i++;
      j++;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) i++;
    else j++;
  }
  return pairs;
}

/** Longest tooltip (in tokens) that is aligned token by token; longer ones compare by shape only. */
const MAX_ALIGN_TOKENS = 1500;

/** Entries for a changed tooltip. */
export function textEntries(kind: 'ability' | 'talent', target: string, oldText: string, newText: string, level?: TalentTier): DiffEntry[] {
  if (oldText === newText) return [];
  const base = (): DiffEntry => (level ? { kind, target, level } : { kind, target });
  const whole = (): DiffEntry[] => [{ ...base(), field: 'text', old: oldText.slice(0, MAX_TEXT), new: newText.slice(0, MAX_TEXT) }];
  const a = tokenize(stripScaling(oldText));
  const b = tokenize(stripScaling(newText));
  if (a.tokens.length > MAX_ALIGN_TOKENS || b.tokens.length > MAX_ALIGN_TOKENS) {
    const sa = shapeOf(oldText);
    const sb = shapeOf(newText);
    if (sa.shape !== sb.shape) return whole();
  }
  const pairs = lcsPairs(
    a.tokens.map((t) => t.shape),
    b.tokens.map((t) => t.shape),
  );
  const out: DiffEntry[] = [];
  const matchedA = new Set<number>();
  const matchedB = new Set<number>();
  for (const [i, j] of pairs) {
    matchedA.add(i);
    matchedB.add(j);
    const ta = a.tokens[i] as Token;
    const tb = b.tokens[j] as Token;
    if (ta.shape === '#' && ta.text !== tb.text) {
      out.push({ ...base(), field: fieldNear(newText, tb.num ?? 0), old: numeric(ta.text), new: numeric(tb.text) });
    }
  }
  const changedA = [...new Set(a.tokens.filter((_, i) => !matchedA.has(i)).map((t) => t.sentence))].sort((x, y) => x - y);
  const changedB = [...new Set(b.tokens.filter((_, j) => !matchedB.has(j)).map((t) => t.sentence))].sort((x, y) => x - y);
  if (changedA.length > 0 || changedB.length > 0) {
    const pick = (sentences: readonly string[], idx: readonly number[]): string => idx.map((i) => sentences[i]).join(' ').slice(0, MAX_TEXT);
    const entry: DiffEntry = { ...base(), field: 'text' };
    const o = pick(a.sentences, changedA);
    const n = pick(b.sentences, changedB);
    if (o) entry.old = o;
    if (n) entry.new = n;
    out.unshift(entry);
  }
  // Same words and numbers, different text (a scaling annotation added or removed, spacing).
  return out.length > 0 ? out : whole();
}

function abilityKey(a: Ability): string {
  return `${a.kind}|${a.name.toLowerCase()}`;
}

function diffAbilities(oldList: readonly Ability[], newList: readonly Ability[]): DiffEntry[] {
  const out: DiffEntry[] = [];
  const oldMap = new Map(oldList.map((a) => [abilityKey(a), a]));
  const newMap = new Map(newList.map((a) => [abilityKey(a), a]));
  for (const a of newList) {
    const o = oldMap.get(abilityKey(a));
    if (!o) {
      out.push({ kind: 'ability-added', target: a.name });
      continue;
    }
    if (o.cooldown !== a.cooldown && (o.cooldown !== undefined || a.cooldown !== undefined)) {
      out.push({ kind: 'ability', target: a.name, field: 'cooldown', ...(o.cooldown !== undefined ? { old: o.cooldown } : {}), ...(a.cooldown !== undefined ? { new: a.cooldown } : {}) });
    }
    const explicit = new Set<string>();
    const pairs = new Set<string>();
    const lead = (v: string | number | undefined): string => String(typeof v === 'number' ? v : (/[\d.]+/.exec(v ?? '')?.[0] ?? ''));
    if (o.cost !== a.cost) {
      explicit.add('cost');
      pairs.add(`${lead(o.cost)}>${lead(a.cost)}`);
      out.push({ kind: 'ability', target: a.name, field: 'cost', ...(o.cost !== undefined ? { old: o.cost } : {}), ...(a.cost !== undefined ? { new: a.cost } : {}) });
    }
    if (o.cooldown !== a.cooldown) {
      explicit.add('cooldown');
      pairs.add(`${lead(o.cooldown)}>${lead(a.cooldown)}`);
    }
    // Tooltips repeat the cost/cooldown ("Current Mana Cost: 45"); keep only the explicit entry.
    out.push(...textEntries('ability', a.name, o.text, a.text).filter((e) => !explicit.has(e.field ?? '') && !pairs.has(`${lead(e.old)}>${lead(e.new)}`)));
  }
  for (const o of oldList) if (!newMap.has(abilityKey(o))) out.push({ kind: 'ability-removed', target: o.name });
  return out;
}

function diffTalents(oldModel: HeroModel, newModel: HeroModel): DiffEntry[] {
  const out: DiffEntry[] = [];
  const oldById = new Map<string, { tier: TalentTier; name: string; text: string }>();
  for (const tier of TALENT_TIERS) for (const t of oldModel.talents[tier]) oldById.set(t.id, { tier, name: t.name, text: t.text });
  const newIds = new Set<string>();
  for (const tier of TALENT_TIERS) {
    for (const t of newModel.talents[tier]) {
      newIds.add(t.id);
      const o = oldById.get(t.id);
      if (!o) {
        out.push({ kind: 'talent-added', target: t.name, level: tier });
        continue;
      }
      if (o.tier !== tier) out.push({ kind: 'talent-moved', target: t.name, field: 'tier', level: tier, old: Number(o.tier), new: Number(tier) });
      out.push(...textEntries('talent', t.name, o.text, t.text, tier));
    }
  }
  for (const [id, o] of oldById) if (!newIds.has(id)) out.push({ kind: 'talent-removed', target: o.name, level: o.tier });
  return out;
}

function diffStats(oldStats: Record<string, number>, newStats: Record<string, number>): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const name of [...new Set([...Object.keys(oldStats), ...Object.keys(newStats)])].sort(compareStrings)) {
    const o = oldStats[name];
    const n = newStats[name];
    if (o === n || (o !== undefined && n !== undefined && round(o, 3) === round(n, 3))) continue;
    out.push({ kind: 'stat', target: name, ...(o !== undefined ? { old: round(o, 3) } : {}), ...(n !== undefined ? { new: round(n, 3) } : {}) });
  }
  return out;
}

/** Diff of every hero present in the new build (new heroes list their abilities as added). */
export function diffModels(from: string, to: string, oldModels: Readonly<Record<string, HeroModel>>, newModels: Readonly<Record<string, HeroModel>>, date?: string): Diff {
  const heroes: Record<string, DiffEntry[]> = {};
  for (const id of Object.keys(newModels).sort(compareStrings)) {
    const n = newModels[id] as HeroModel;
    const o = oldModels[id];
    const entries = o
      ? [...diffStats(o.stats, n.stats), ...diffAbilities(o.abilities, n.abilities), ...diffTalents(o, n)]
      : n.abilities.map((a): DiffEntry => ({ kind: 'ability-added', target: a.name }));
    if (entries.length > 0) heroes[id] = entries;
  }
  const diff: Diff = { id: `${from}..${to}`, from, to, heroes };
  if (date) diff.date = date;
  return diff;
}

/** Newest `to` first, unique ids; keeps at most `max` diffs. */
export function mergeDiffs(previous: readonly Diff[], added: readonly Diff[], max = 60): Diff[] {
  const byId = new Map<string, Diff>();
  for (const d of [...previous, ...added]) byId.set(d.id, d);
  return [...byId.values()]
    .sort((a, b) => compareBuilds(b.to, a.to) || compareBuilds(b.from, a.from))
    .slice(0, max);
}

/** Hero id → newest build whose diff touched it. */
export function lastChangedBuilds(diffs: readonly Diff[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const d of diffs) {
    for (const id of Object.keys(d.heroes)) {
      const cur = out.get(id);
      if (!cur || compareBuilds(d.to, cur) > 0) out.set(id, d.to);
    }
  }
  return out;
}
