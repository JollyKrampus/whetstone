/**
 * Build-to-build game-data diff per hero (diffs.json, SPEC §5): base stats, abilities and
 * talents old → new, with numbers paired up when only numbers changed. Pure.
 *
 * Text diffs: both tooltips are reduced to a "shape" (numbers replaced by #, the per-level
 * scaling annotations removed). Same shape → one entry per changed number, labelled with the
 * nearest stat word ("damage", "cooldown", "radius" …). Different shape → one `text` entry with
 * both full texts.
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

/** Entries for a changed tooltip. */
export function textEntries(kind: 'ability' | 'talent', target: string, oldText: string, newText: string, level?: TalentTier): DiffEntry[] {
  if (oldText === newText) return [];
  const a = shapeOf(oldText);
  const b = shapeOf(newText);
  const base = (): DiffEntry => (level ? { kind, target, level } : { kind, target });
  if (a.shape === b.shape && a.numbers.length === b.numbers.length) {
    const out: DiffEntry[] = [];
    a.numbers.forEach((oldNum, i) => {
      const newNum = b.numbers[i] as string;
      if (oldNum === newNum) return;
      out.push({ ...base(), field: fieldNear(newText, i), old: numeric(oldNum), new: numeric(newNum) });
    });
    if (out.length > 0) return out;
  }
  return [{ ...base(), field: 'text', old: oldText.slice(0, MAX_TEXT), new: newText.slice(0, MAX_TEXT) }];
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
