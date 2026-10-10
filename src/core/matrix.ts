/**
 * Compact columnar codec for Edge[] (browser shards such as the draft table). Ids are stored
 * once and edges refer to them by index; numeric columns are plain arrays so gzip does the
 * rest. Reasons are optional and deduplicated into a table because theory reasons repeat a lot.
 */
import type { Edge, EdgeSource, Reason } from './game.ts';

export const MATRIX_VERSION = 1;

export interface EdgeMatrix {
  v: typeof MATRIX_VERSION;
  /** Sorted entity ids; `a`/`b` index into this. */
  ids: string[];
  /** Source table; `src` indexes into this. */
  srcs: EdgeSource[];
  a: number[];
  b: number[];
  score: number[];
  delta: (number | null)[];
  n: (number | null)[];
  /** Present only when at least one edge has z. */
  z?: (number | null)[];
  src: number[];
  /** Present when encoded with reasons: unique reasons + per-edge indices into them. */
  reasons?: { table: Reason[]; rows: number[][] };
}

export interface EncodeOptions {
  /** Include reasons (default true). Drop them for shards that only need numbers. */
  reasons?: boolean;
  /** Round delta/z to this many decimals (default: no rounding, lossless). */
  digits?: number;
}

/** Exhaustive over EdgeSource: adding a source to game.ts without listing it here fails tsc. */
const KNOWN_SOURCES: Readonly<Record<EdgeSource, true>> = {
  stats: true,
  theory: true,
  curated: true,
  votes: true,
  usage: true,
  replays: true,
  community: true,
  personal: true,
};

const isReason = (r: unknown): boolean =>
  !!r && typeof r === 'object' && typeof (r as Reason).kind === 'string' && typeof (r as Reason).text === 'string';

const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);

function roundTo(x: number, digits: number | undefined): number {
  if (digits === undefined) return x;
  const f = 10 ** digits;
  const r = Math.round(x * f) / f;
  return r === 0 ? 0 : r;
}

/** Stable key for a reason (property order independent) for deduplication. */
function reasonKey(r: Reason): string {
  return JSON.stringify([r.kind, r.text, r.n ?? null, r.delta ?? null, r.source ?? null, r.evidence ?? null]);
}

/** Encode edges column-wise. Row order is preserved; ids are sorted for deterministic output. */
export function encodeEdges(edges: readonly Edge[], opts: EncodeOptions = {}): EdgeMatrix {
  const withReasons = opts.reasons ?? true;
  const ids = [...new Set(edges.flatMap((e) => [e.a, e.b]))].sort(cmp);
  const idIndex = new Map(ids.map((id, i) => [id, i]));
  const srcs = [...new Set(edges.map((e) => e.source))].sort(cmp);
  const srcIndex = new Map(srcs.map((s, i) => [s, i]));
  const m: EdgeMatrix = { v: MATRIX_VERSION, ids, srcs, a: [], b: [], score: [], delta: [], n: [], src: [] };
  const hasZ = edges.some((e) => e.z !== undefined);
  const z: (number | null)[] = [];
  const table: Reason[] = [];
  const tableIndex = new Map<string, number>();
  const rows: number[][] = [];
  for (const e of edges) {
    m.a.push(idIndex.get(e.a)!);
    m.b.push(idIndex.get(e.b)!);
    m.score.push(e.score);
    m.delta.push(e.delta === undefined ? null : roundTo(e.delta, opts.digits));
    m.n.push(e.n ?? null);
    if (hasZ) z.push(e.z === undefined ? null : roundTo(e.z, opts.digits));
    m.src.push(srcIndex.get(e.source)!);
    if (withReasons) {
      rows.push(
        e.reasons.map((r) => {
          const key = reasonKey(r);
          let i = tableIndex.get(key);
          if (i === undefined) {
            i = table.length;
            table.push(r);
            tableIndex.set(key, i);
          }
          return i;
        }),
      );
    }
  }
  if (hasZ) m.z = z;
  if (withReasons) m.reasons = { table, rows };
  return m;
}

const isNumArray = (x: unknown, len: number, nullable = false): boolean =>
  Array.isArray(x) && x.length === len && x.every((v) => (nullable && v === null) || (typeof v === 'number' && Number.isFinite(v)));

const isIndexArray = (x: unknown, len: number, max: number): boolean =>
  Array.isArray(x) && x.length === len && x.every((v) => Number.isInteger(v) && v >= 0 && v < max);

/** Structural check of a decoded JSON payload (columns aligned, indices in range). */
export function isEdgeMatrix(x: unknown): x is EdgeMatrix {
  if (!x || typeof x !== 'object') return false;
  const m = x as Partial<EdgeMatrix>;
  if (m.v !== MATRIX_VERSION || !Array.isArray(m.ids) || !Array.isArray(m.srcs) || !Array.isArray(m.a)) return false;
  if (!m.ids.every((id) => typeof id === 'string')) return false;
  if (!m.srcs.every((s) => typeof s === 'string' && Object.hasOwn(KNOWN_SOURCES, s))) return false;
  const len = m.a.length;
  if (!isIndexArray(m.a, len, m.ids.length) || !isIndexArray(m.b, len, m.ids.length)) return false;
  if (!isIndexArray(m.src, len, m.srcs.length)) return false;
  if (!isNumArray(m.score, len) || !isNumArray(m.delta, len, true) || !isNumArray(m.n, len, true)) return false;
  if (m.z !== undefined && !isNumArray(m.z, len, true)) return false;
  if (m.reasons !== undefined) {
    const { table, rows } = m.reasons;
    if (!Array.isArray(table) || !Array.isArray(rows) || rows.length !== len || !table.every(isReason)) return false;
    if (!rows.every((r) => Array.isArray(r) && r.every((i) => Number.isInteger(i) && i >= 0 && i < table.length))) return false;
  }
  return true;
}

/** Decode back to Edge objects. Throws on a malformed payload (shards are our own output). */
export function decodeEdges(m: EdgeMatrix): Edge[] {
  if (!isEdgeMatrix(m)) throw new Error('Malformed edge matrix');
  const out: Edge[] = [];
  for (let i = 0; i < m.a.length; i++) {
    const e: Edge = {
      a: m.ids[m.a[i]!]!,
      b: m.ids[m.b[i]!]!,
      score: m.score[i]!,
      source: m.srcs[m.src[i]!]!,
      reasons: m.reasons ? m.reasons.rows[i]!.map((j) => m.reasons!.table[j]!) : [],
    };
    const delta = m.delta[i];
    const n = m.n[i];
    const z = m.z?.[i];
    if (delta !== null && delta !== undefined) e.delta = delta;
    if (n !== null && n !== undefined) e.n = n;
    if (z !== null && z !== undefined) e.z = z;
    out.push(e);
  }
  return out;
}

export interface EdgeLookup {
  readonly ids: readonly string[];
  readonly size: number;
  /** Edge a→b (for undirected lookups, either orientation, returned with `a` = first arg). */
  get(a: string, b: string): Edge | undefined;
  has(a: string, b: string): boolean;
  /** Score of a→b, or `fallback` (default 50 = neutral) when absent. */
  score(a: string, b: string, fallback?: number): number;
  /** Every edge out of `a` (undirected: every edge touching `a`, oriented with `a` first). */
  from(a: string): Edge[];
  /** Every edge into `b` (directed only; undirected lookups return from(b)). */
  to(b: string): Edge[];
}

export interface LookupOptions {
  /** Synergy-style tables stored once per pair (a < b). */
  undirected?: boolean;
}

function flip(e: Edge): Edge {
  return { ...e, a: e.b, b: e.a };
}

/** Index edges (or an encoded matrix) for O(1) pair lookups and per-entity lists. */
export function createLookup(source: EdgeMatrix | readonly Edge[], opts: LookupOptions = {}): EdgeLookup {
  const edges = Array.isArray(source) ? (source as readonly Edge[]) : decodeEdges(source as EdgeMatrix);
  const undirected = opts.undirected ?? false;
  const pair = new Map<string, Edge>();
  const out = new Map<string, Edge[]>();
  const inn = new Map<string, Edge[]>();
  const push = (map: Map<string, Edge[]>, key: string, e: Edge): void => {
    const list = map.get(key);
    if (list) list.push(e);
    else map.set(key, [e]);
  };
  for (const e of edges) {
    pair.set(`${e.a}\u0000${e.b}`, e);
    push(out, e.a, e);
    push(inn, e.b, e);
    if (undirected && e.a !== e.b) {
      const f = flip(e);
      if (!pair.has(`${e.b}\u0000${e.a}`)) pair.set(`${e.b}\u0000${e.a}`, f);
      push(out, e.b, f);
    }
  }
  const ids = [...new Set(edges.flatMap((e) => [e.a, e.b]))].sort(cmp);
  return {
    ids,
    size: edges.length,
    get: (a, b) => pair.get(`${a}\u0000${b}`),
    has: (a, b) => pair.has(`${a}\u0000${b}`),
    score: (a, b, fallback = 50) => pair.get(`${a}\u0000${b}`)?.score ?? fallback,
    from: (a) => [...(out.get(a) ?? [])],
    to: (b) => (undirected ? [...(out.get(b) ?? [])] : [...(inn.get(b) ?? [])]),
  };
}
