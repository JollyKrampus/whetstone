import { ToolError } from '../tools/result.js';
import { type CardIndex, frontTypeLine, normalizeName, wildcardRarity } from './cards.js';
import { getFormat } from './formats.js';
import { RARITIES, type CardRecord, type Color } from './types.js';

/*
 * A subset of Scryfall search syntax, evaluated against the local index:
 *   words / "quoted"      name contains          !"Exact Name"   exact name
 *   t: type:              type line              o: oracle:      rules text
 *   kw: keyword:          keyword ability        c: color:       colors (default >=)
 *   id: identity: ci:     color identity (default <=)
 *   mv cmc manavalue      mana value             pow tou         power / toughness
 *   r: rarity:            Arena wildcard rarity  f: format: legal: banned: restricted:
 *   game:arena            on Arena               is:<flag>       see IS_FLAGS
 *   year                  first-printing year    produces:       mana produced
 * Terms are ANDed; `or` and parentheses group; a leading `-` negates.
 */

type Op = ':' | '=' | '!=' | '<' | '<=' | '>' | '>=';
type Pred = (c: CardRecord) => boolean;

interface Tok {
  kind: 'term' | 'lparen' | 'rparen' | 'or' | 'neg';
  key?: string;
  op?: Op;
  value?: string;
  exact?: boolean;
}

const COLOR_WORDS: Record<string, string> = {
  white: 'w',
  blue: 'u',
  black: 'b',
  red: 'r',
  green: 'g',
  colorless: 'c',
  multicolor: 'm',
  azorius: 'wu',
  dimir: 'ub',
  rakdos: 'br',
  gruul: 'rg',
  selesnya: 'gw',
  orzhov: 'wb',
  izzet: 'ur',
  golgari: 'bg',
  boros: 'rw',
  simic: 'gu',
  bant: 'gwu',
  esper: 'wub',
  grixis: 'ubr',
  jund: 'brg',
  naya: 'rgw',
  abzan: 'wbg',
  jeskai: 'urw',
  sultai: 'bgu',
  mardu: 'rwb',
  temur: 'gur',
};

function tokenize(q: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const readValue = (): string => {
    if (q[i] === '"') {
      const end = q.indexOf('"', i + 1);
      const v = q.slice(i + 1, end === -1 ? undefined : end);
      i = end === -1 ? q.length : end + 1;
      return v;
    }
    const start = i;
    while (i < q.length && !/[\s()]/.test(q[i]!)) i++;
    return q.slice(start, i);
  };
  while (i < q.length) {
    const ch = q[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === '(') {
      toks.push({ kind: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      toks.push({ kind: 'rparen' });
      i++;
      continue;
    }
    if (ch === '-' && i + 1 < q.length && !/\s/.test(q[i + 1]!)) {
      toks.push({ kind: 'neg' });
      i++;
      continue;
    }
    if (ch === '!') {
      i++;
      toks.push({ kind: 'term', exact: true, value: readValue() });
      continue;
    }
    const m = /^([a-z]+)(<=|>=|!=|:|=|<|>)/i.exec(q.slice(i));
    if (m) {
      i += m[0].length;
      toks.push({ kind: 'term', key: m[1]!.toLowerCase(), op: m[2] as Op, value: readValue() });
      continue;
    }
    const word = readValue();
    if (word.toLowerCase() === 'or') toks.push({ kind: 'or' });
    else if (word.toLowerCase() !== 'and') toks.push({ kind: 'term', value: word });
  }
  return toks;
}

function parseColors(v: string): Set<Color> | 'm' | number {
  const raw = (COLOR_WORDS[v.toLowerCase()] ?? v).toLowerCase();
  if (/^\d+$/.test(raw)) return Number(raw);
  if (raw === 'm') return 'm';
  if (!/^[wubrgc]+$/.test(raw)) throw new ToolError('bad_query', { reason: `unknown color "${v}"` });
  return new Set([...raw].filter((ch) => ch !== 'c').map((ch) => ch.toUpperCase() as Color));
}

function compareNum(a: number, op: Op, b: number): boolean {
  switch (op) {
    case ':':
    case '=':
      return a === b;
    case '!=':
      return a !== b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
  }
}

function colorPred(get: (c: CardRecord) => Color[], op: Op, value: string, defaultOp: Op): Pred {
  const want = parseColors(value);
  if (want === 'm') return (c) => get(c).length >= 2;
  if (typeof want === 'number') return (c) => compareNum(get(c).length, op === ':' ? '=' : op, want);
  const eff = op === ':' ? defaultOp : op;
  return (c) => {
    const have = new Set(get(c));
    const sub = [...have].every((x) => want.has(x));
    const sup = [...want].every((x) => have.has(x));
    switch (eff) {
      case '=':
        return sub && sup;
      case '!=':
        return !(sub && sup);
      case '<=':
        return sub;
      case '<':
        return sub && have.size < want.size;
      case '>=':
        return sup;
      case '>':
        return sup && have.size > want.size;
      default:
        return sup;
    }
  };
}

function numericPred(get: (c: CardRecord) => number, op: Op, value: string, key: string): Pred {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new ToolError('bad_query', { reason: `${key} needs a number, got "${value}"` });
  return (c) => {
    const v = get(c);
    return Number.isFinite(v) && compareNum(v, op, n);
  };
}

const IS_FLAGS: Record<string, Pred> = {
  arena: (c) => c.onArena,
  permanent: (c) => /\b(Creature|Artifact|Enchantment|Planeswalker|Land|Battle)\b/.test(frontTypeLine(c)),
  spell: (c) => !/\bLand\b/.test(frontTypeLine(c)),
  creature: (c) => /\bCreature\b/.test(frontTypeLine(c)),
  land: (c) => /\bLand\b/.test(frontTypeLine(c)),
  basic: (c) => /\bBasic\b/.test(c.typeLine),
  legendary: (c) => /\bLegendary\b/.test(frontTypeLine(c)),
  commander: (c) =>
    (/\bLegendary\b/.test(frontTypeLine(c)) && /\b(Creature|Planeswalker)\b/.test(frontTypeLine(c))) ||
    /can be your commander/i.test(c.oracleText),
  dfc: (c) => ['transform', 'modal_dfc', 'meld'].includes(c.layout),
  mdfc: (c) => c.layout === 'modal_dfc',
  split: (c) => c.layout === 'split',
  adventure: (c) => c.layout === 'adventure',
  gamechanger: (c) => c.gameChanger,
};

function termPred(t: Tok): Pred {
  const value = t.value ?? '';
  const lower = value.toLowerCase();
  if (t.exact) {
    const key = normalizeName(value);
    return (c) => normalizeName(c.name) === key || c.faces.some((f) => normalizeName(f.name) === key);
  }
  if (!t.key) {
    const key = normalizeName(value);
    return (c) => normalizeName(c.name).includes(key);
  }
  const op = t.op ?? ':';
  switch (t.key) {
    case 'name':
    case 'n':
      return (c) => normalizeName(c.name).includes(normalizeName(value));
    case 't':
    case 'type':
      return (c) => c.typeLine.toLowerCase().includes(lower);
    case 'o':
    case 'oracle':
      return (c) => c.oracleText.toLowerCase().replace(new RegExp(escapeRe(c.name.toLowerCase()), 'g'), '~').includes(lower);
    case 'kw':
    case 'keyword':
      return (c) => c.keywords.some((k) => k.toLowerCase() === lower);
    case 'c':
    case 'color':
      return colorPred((c) => c.colors, op, value, '>=');
    case 'id':
    case 'identity':
    case 'ci':
      return colorPred((c) => c.colorIdentity, op, value, '<=');
    case 'mv':
    case 'cmc':
    case 'manavalue':
      return numericPred((c) => c.cmc, op === ':' ? '=' : op, value, t.key);
    case 'pow':
    case 'power':
      return numericPred((c) => Number(c.power), op === ':' ? '=' : op, value, t.key);
    case 'tou':
    case 'toughness':
      return numericPred((c) => Number(c.toughness), op === ':' ? '=' : op, value, t.key);
    case 'year':
      return numericPred((c) => Number(c.releasedAt.slice(0, 4)), op === ':' ? '=' : op, value, t.key);
    case 'r':
    case 'rarity': {
      const idx = RARITIES.findIndex((r) => r === lower || r[0] === lower);
      if (idx < 0) throw new ToolError('bad_query', { reason: `unknown rarity "${value}"` });
      return (c) => compareNum(RARITIES.indexOf(wildcardRarity(c)), op === ':' ? '=' : op, idx);
    }
    case 'f':
    case 'format':
    case 'legal': {
      const key = getFormat(value).legalityKey;
      return (c) => c.legalities[key] === 'legal' || c.legalities[key] === 'restricted';
    }
    case 'banned':
    case 'restricted': {
      const key = getFormat(value).legalityKey;
      const status = t.key;
      return (c) => c.legalities[key] === status;
    }
    case 'game':
      if (lower !== 'arena') throw new ToolError('bad_query', { reason: 'only game:arena is supported' });
      return (c) => c.onArena;
    case 'is': {
      const p = IS_FLAGS[lower];
      if (!p) throw new ToolError('bad_query', { reason: `unknown is:${value}`, supported: Object.keys(IS_FLAGS) });
      return p;
    }
    case 'produces': {
      const want = lower.toUpperCase().split('');
      return (c) => want.every((w) => c.producedMana.includes(w));
    }
    default:
      throw new ToolError('bad_query', {
        reason: `unsupported search key "${t.key}"`,
        supported: ['t', 'o', 'kw', 'c', 'id', 'mv', 'pow', 'tou', 'r', 'f', 'banned', 'game', 'is', 'year', 'produces'],
      });
  }
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function compileQuery(query: string): Pred {
  const toks = tokenize(query);
  let pos = 0;
  const parseOr = (): Pred => {
    const parts = [parseAnd()];
    while (toks[pos]?.kind === 'or') {
      pos++;
      parts.push(parseAnd());
    }
    return parts.length === 1 ? parts[0]! : (c) => parts.some((p) => p(c));
  };
  const parseAnd = (): Pred => {
    const parts: Pred[] = [];
    while (pos < toks.length && toks[pos]!.kind !== 'or' && toks[pos]!.kind !== 'rparen') parts.push(parseUnary());
    if (!parts.length) throw new ToolError('bad_query', { reason: 'empty expression' });
    return (c) => parts.every((p) => p(c));
  };
  const parseUnary = (): Pred => {
    const t = toks[pos++]!;
    if (t.kind === 'neg') {
      const inner = parseUnary();
      return (c) => !inner(c);
    }
    if (t.kind === 'lparen') {
      const inner = parseOr();
      if (toks[pos]?.kind !== 'rparen') throw new ToolError('bad_query', { reason: 'missing )' });
      pos++;
      return inner;
    }
    return termPred(t);
  };
  const pred = parseOr();
  if (pos < toks.length) throw new ToolError('bad_query', { reason: 'unbalanced )' });
  return pred;
}

export type SearchOrder = 'name' | 'mv' | 'edhrec' | 'released';

export function searchCards(
  index: CardIndex,
  query: string,
  opts: { format?: string; limit?: number; order?: SearchOrder } = {},
) {
  const pred = compileQuery(query);
  const fmt = opts.format ? getFormat(opts.format) : undefined;
  const hits = index.records.filter(
    (c) =>
      pred(c) &&
      (!fmt || ((c.legalities[fmt.legalityKey] === 'legal' || c.legalities[fmt.legalityKey] === 'restricted') && c.onArena)),
  );
  const order = opts.order ?? 'name';
  if (order === 'mv') hits.sort((a, b) => a.cmc - b.cmc || cmpName(a, b));
  else if (order === 'edhrec') hits.sort((a, b) => (a.edhrecRank ?? 1e9) - (b.edhrecRank ?? 1e9) || cmpName(a, b));
  else if (order === 'released') hits.sort((a, b) => cmpStr(b.latestReleasedAt, a.latestReleasedAt) || cmpName(a, b));
  return { total: hits.length, cards: hits.slice(0, opts.limit ?? 50) };
}

function cmpStr(a: string, b: string) {
  return a < b ? -1 : a > b ? 1 : 0;
}
function cmpName(a: CardRecord, b: CardRecord) {
  return cmpStr(a.name, b.name);
}
