import { COLORS, type CardRecord, type Color, type IndexMeta, type Rarity } from './types.js';

/** Case-, accent-, quote- and split-separator-insensitive name key. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s*\/{1,3}\s*/g, ' // ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function levenshtein(a: string, b: string, limit = Infinity): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > limit) return limit + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

export class CardIndex {
  readonly byOracle = new Map<string, CardRecord>();
  private readonly byName = new Map<string, CardRecord>();

  constructor(
    readonly records: CardRecord[],
    readonly meta: IndexMeta,
  ) {
    const faceNames: [string, CardRecord][] = [];
    for (const r of records) {
      this.byOracle.set(r.oracleId, r);
      this.claim(normalizeName(r.name), r);
      for (const f of r.faces) faceNames.push([normalizeName(f.name), r]);
    }
    // Face names only fill gaps, so a real card name always wins over another card's face.
    for (const [key, r] of faceNames) {
      if (!this.byName.has(key)) this.byName.set(key, r);
    }
  }

  private claim(key: string, r: CardRecord) {
    const prev = this.byName.get(key);
    if (!prev || rank(r) < rank(prev)) this.byName.set(key, r);
  }

  lookup(name: string): CardRecord | undefined {
    return this.byName.get(normalizeName(name));
  }

  /** Up to `n` closest card names, for "did you mean" hints. */
  suggest(name: string, n = 3): string[] {
    const key = normalizeName(name);
    const limit = Math.max(2, Math.floor(key.length / 4));
    const scored: [number, string][] = [];
    for (const r of this.records) {
      if (!r.onArena) continue;
      const d = levenshtein(key, normalizeName(r.name), limit);
      if (d <= limit) scored.push([d, r.name]);
    }
    scored.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    return [...new Set(scored.map((s) => s[1]))].slice(0, n);
  }
}

function rank(r: CardRecord): number {
  const legalSomewhere = Object.values(r.legalities).some((v) => v !== 'not_legal');
  return (r.onArena ? 0 : 2) + (legalSomewhere ? 0 : 1);
}

// ---- card helpers -------------------------------------------------------------------

export function frontTypeLine(c: CardRecord): string {
  return c.faces[0]?.typeLine ?? c.typeLine;
}

export function isLand(c: CardRecord): boolean {
  return /\bLand\b/.test(frontTypeLine(c));
}

/** Modal double-faced spell whose back face is a land. */
export function isMdfcLand(c: CardRecord): boolean {
  return c.layout === 'modal_dfc' && !isLand(c) && /\bLand\b/.test(c.faces[1]?.typeLine ?? '');
}

export function isBasicLand(c: CardRecord): boolean {
  return /\bBasic\b/.test(c.typeLine) && /\bLand\b/.test(c.typeLine);
}

export function isCreature(c: CardRecord): boolean {
  return /\bCreature\b/.test(frontTypeLine(c));
}

/** Copy limit printed on the card ("any number" → Infinity, "up to seven" → 7), else null. */
export function printedCopyLimit(c: CardRecord): number | null {
  if (/A deck can have any number of cards named/i.test(c.oracleText)) return Infinity;
  const m = /A deck can have up to (\w+) cards named/i.exec(c.oracleText);
  if (m) {
    const words: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
    return words[m[1]!.toLowerCase()] ?? Number(m[1]);
  }
  return null;
}

/** Mana cost used to cast the card from hand: the front face, or the first half of a split card. */
export function castingCost(c: CardRecord): string {
  const cost = c.faces[0]?.manaCost || c.manaCost;
  return cost.split(' // ')[0] ?? '';
}

/** Mana value of the front face / first half (MDFCs and adventures are cast as the front). */
export function castingMv(c: CardRecord): number {
  if (c.faces.length < 2 || c.layout === 'transform' || c.layout === 'flip' || c.layout === 'meld') return c.cmc;
  return manaValueOf(castingCost(c));
}

export function manaValueOf(cost: string): number {
  let mv = 0;
  for (const m of cost.matchAll(/\{([^}]+)\}/g)) {
    const s = m[1]!;
    if (/^\d+$/.test(s)) mv += Number(s);
    else if (s === 'X' || s === 'Y' || s === 'Z') continue;
    else if (/^2\//.test(s)) mv += 2;
    else mv += 1;
  }
  return mv;
}

export interface Pips {
  /** Hard colored pips per color (phyrexian and hybrid excluded). */
  hard: Record<Color, number>;
  /** Hybrid pips, each listed with the colors that can pay it. */
  hybrid: Color[][];
}

export function pipsOf(cost: string): Pips {
  const hard = Object.fromEntries(COLORS.map((c) => [c, 0])) as Record<Color, number>;
  const hybrid: Color[][] = [];
  for (const m of cost.matchAll(/\{([^}]+)\}/g)) {
    const parts = m[1]!.split('/');
    if (parts.includes('P')) continue;
    const colors = parts.filter((p): p is Color => (COLORS as string[]).includes(p));
    if (colors.length === 1 && parts.length === 1) hard[colors[0]!]++;
    else if (colors.length === 1 && parts[0] === '2') hard[colors[0]!]++;
    else if (colors.length > 1) hybrid.push(colors);
  }
  return { hard, hybrid };
}

/** Rarity a wildcard would cost: the lowest Arena rarity, else the lowest overall. */
export function wildcardRarity(c: CardRecord): Rarity {
  return c.arenaRarity ?? c.rarity;
}

/** Strips reminder text so role regexes don't match explanations of keywords. */
export function rulesText(c: CardRecord): string {
  return c.oracleText.replace(/\([^)]*\)/g, '').toLowerCase();
}

export function summarize(c: CardRecord) {
  return {
    name: c.name,
    manaCost: c.manaCost,
    mv: c.cmc,
    type: c.typeLine,
    colorIdentity: c.colorIdentity.join(''),
    rarity: wildcardRarity(c),
    onArena: c.onArena,
    text: c.oracleText,
  };
}
