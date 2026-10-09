/**
 * "Bring your own meta": decklists a visitor saves in their own browser (localStorage key
 * whetstone:mtga:metaLists) and the curated snapshots, turned into what the analyzer compares
 * against. Import and export use grindstone-mcp's snapshot format, so the same JSON works in the
 * MCP server (<config dir>/meta/<format>.json). Browser-safe, no zod.
 */
import { FORMAT_IDS, FORMAT_LABELS, isFormatId, type FormatId, type MetaListInput, type MetaSelection } from '../worker/protocol.ts';

export const MY_LISTS_KEY = 'metaLists';
export const MAX_LISTS = 200;
const MAX_LIST_CHARS = 20_000;

export interface MyList {
  id: string;
  format: FormatId;
  /** Deck name or label shown in comparisons. */
  name: string;
  archetype?: string;
  /** Share of the metagame, 0..1. */
  metaShare?: number;
  /** Match win rate, 0..1. */
  winRate?: number;
  /** Where the list came from (optional, shown as a link). */
  sourceUrl?: string;
  /** Arena export text. */
  list: string;
  addedAt: string;
}

/** A curated deck as the meta page and analyzer receive it from the build. */
export interface CuratedDeck {
  name?: string;
  archetype?: string;
  metaShare?: number;
  winRate?: number;
  list: string;
  sourceUrl?: string;
  example?: true;
}

export interface CuratedSnapshotView {
  format: FormatId;
  date?: string;
  source?: string;
  example?: true;
  decks: CuratedDeck[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A share given as 0..1 or as a percentage (0..100), as a fraction; undefined if unusable. */
export function toFraction(v: unknown): number | undefined {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v.replace('%', '')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return n > 1 ? Math.round(n * 100) / 10_000 : n;
}

/** A form field typed as a percentage ("12.5", "12.5%", "0.5") as a fraction; undefined if empty or out of range. */
export function percentInput(v: string): number | undefined {
  const t = v.trim().replace(/%$/, '').trim();
  if (t === '') return undefined;
  const n = Number(t.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 100) return undefined;
  return Math.round(n * 100) / 10_000;
}

function cleanUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  try {
    const u = new URL(v.trim());
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function cleanText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim().slice(0, max);
  return t === '' ? undefined : t;
}

/** Validate one stored list (drops it when unusable). */
export function sanitizeList(v: unknown): MyList | null {
  if (!isRecord(v)) return null;
  const list = typeof v.list === 'string' ? v.list.replace(/\r\n/g, '\n').trim().slice(0, MAX_LIST_CHARS) : '';
  if (!list || !isFormatId(v.format)) return null;
  const out: MyList = {
    id: cleanText(v.id, 40) ?? `l${list.length}${Math.abs(hash(list)).toString(36)}`,
    format: v.format,
    name: cleanText(v.name, 80) ?? cleanText(v.archetype, 80) ?? 'Untitled list',
    list,
    addedAt: cleanText(v.addedAt, 40) ?? '1970-01-01T00:00:00.000Z',
  };
  const archetype = cleanText(v.archetype, 80);
  if (archetype) out.archetype = archetype;
  const share = toFraction(v.metaShare);
  if (share !== undefined) out.metaShare = share;
  const wr = toFraction(v.winRate);
  if (wr !== undefined) out.winRate = wr;
  const url = cleanUrl(v.sourceUrl);
  if (url) out.sourceUrl = url;
  return out;
}

/** Validator for Store.get: the stored array with bad entries dropped. */
export function validateMyLists(value: unknown): MyList[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const out: MyList[] = [];
  for (const v of value.slice(0, MAX_LISTS)) {
    const l = sanitizeList(v);
    if (!l || seen.has(l.id)) continue;
    seen.add(l.id);
    out.push(l);
  }
  return out;
}

function hash(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 31) + text.charCodeAt(i)) | 0;
  return h;
}

/** A new id that is unique among `existing`. */
export function newListId(existing: readonly MyList[], now: number, random: () => number = Math.random): string {
  const ids = new Set(existing.map((l) => l.id));
  for (;;) {
    const id = `l${now.toString(36)}${Math.floor(random() * 1e6).toString(36)}`;
    if (!ids.has(id)) return id;
  }
}

const toInput = (d: { name?: string; archetype?: string; metaShare?: number; winRate?: number; list: string }): MetaListInput => ({
  list: d.list,
  ...(d.name ? { name: d.name } : {}),
  ...(d.archetype ? { archetype: d.archetype } : {}),
  ...(d.metaShare !== undefined ? { metaShare: d.metaShare } : {}),
  ...(d.winRate !== undefined ? { winRate: d.winRate } : {}),
});

/** The visitor's lists for a format as an analyzer meta selection, or null when there are none. */
export function mySelection(lists: readonly MyList[], format: FormatId): MetaSelection | null {
  const mine = lists.filter((l) => l.format === format);
  if (mine.length === 0) return null;
  return { label: `My ${FORMAT_LABELS[format]} lists`, lists: mine.map(toInput) };
}

/** Curated non-example decks as a meta selection (examples are never meta). */
export function curatedSelection(snap: CuratedSnapshotView | undefined): MetaSelection | null {
  if (!snap || snap.example) return null;
  const decks = snap.decks.filter((d) => !d.example);
  if (decks.length === 0) return null;
  return { label: `Curated ${FORMAT_LABELS[snap.format]} lists${snap.date ? ` (${snap.date})` : ''}`, lists: decks.map(toInput) };
}

/** grindstone snapshot JSON for one format of the visitor's lists. */
export function toSnapshot(lists: readonly MyList[], format: FormatId, date: string): unknown {
  return {
    format,
    date,
    source: 'Whetstone: my meta lists',
    decks: lists
      .filter((l) => l.format === format)
      .map((l) => ({
        name: l.name,
        ...(l.archetype ? { archetype: l.archetype } : {}),
        ...(l.metaShare !== undefined ? { metaShare: l.metaShare } : {}),
        ...(l.winRate !== undefined ? { winRate: l.winRate } : {}),
        list: l.list,
        ...(l.sourceUrl ? { sourceUrl: l.sourceUrl } : {}),
      })),
  };
}

export interface ImportResult {
  lists: MyList[];
  errors: string[];
}

/**
 * Lists from a pasted or uploaded snapshot (grindstone format: `{ format, decks: [...] }`, or an
 * array of such snapshots). Each deck needs a non-empty `list`; meta share and win rate may be
 * fractions or percentages.
 */
export function fromSnapshot(json: unknown, now: Date, existing: readonly MyList[] = []): ImportResult {
  const snaps = Array.isArray(json) ? json : [json];
  const lists: MyList[] = [];
  const errors: string[] = [];
  let n = 0;
  for (const [si, snap] of snaps.entries()) {
    if (!isRecord(snap) || !Array.isArray(snap.decks)) {
      errors.push(`Snapshot ${si + 1}: expected an object with "format" and a "decks" array.`);
      continue;
    }
    const format = typeof snap.format === 'string' ? snap.format.toLowerCase() : '';
    const fmt = format === 'explorer' ? 'pioneer' : format;
    if (!isFormatId(fmt)) {
      errors.push(`Snapshot ${si + 1}: unknown format "${String(snap.format)}" (use ${FORMAT_IDS.join(', ')}).`);
      continue;
    }
    for (const [di, d] of snap.decks.entries()) {
      const l = sanitizeList({ ...(isRecord(d) ? d : {}), format: fmt, id: newListId([...existing, ...lists], now.getTime() + n++), addedAt: now.toISOString() });
      if (!l) errors.push(`Snapshot ${si + 1}, deck ${di + 1}: needs a non-empty "list" (Arena export).`);
      else lists.push(l);
    }
  }
  return { lists, errors };
}
