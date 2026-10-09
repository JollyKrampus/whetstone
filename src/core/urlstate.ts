/**
 * Versioned, shareable state in the URL hash (SPEC §7, critique C9): "#v=1&m=cursed-hollow&fp=b&s=…".
 * The hash keeps state out of request logs and CDN cache keys. Decoding never throws: anything
 * malformed falls back to the field's default, so a mangled link still opens a working page.
 */

export interface StrField {
  kind: 'str';
  key: string;
  default: string;
  maxLength?: number;
  pattern?: RegExp;
}

export interface EnumField<V extends string = string> {
  kind: 'enum';
  key: string;
  values: readonly V[];
  default: V;
}

export interface IntField {
  kind: 'int';
  key: string;
  default: number;
  min?: number;
  max?: number;
}

export interface BoolField {
  kind: 'bool';
  key: string;
  default: boolean;
}

/**
 * A list of ids (null = empty slot). `csv` writes the ids themselves ("liming,-,muradin");
 * `index` writes fixed-width base36 indices into `universe` ("0a--1f"). The universe must be
 * append-only (e.g. registry order), never re-sorted, or old links change meaning.
 */
export interface IdsField {
  kind: 'ids';
  key: string;
  default: readonly (string | null)[];
  pack: 'csv' | 'index';
  universe?: readonly string[];
  /** Characters per index (default 2 → up to 1,295 ids; `-`×width is the empty slot). */
  width?: number;
  maxItems?: number;
}

export type FieldSpec = StrField | EnumField | IntField | BoolField | IdsField;

export type FieldValue<F> = F extends { kind: 'str' }
  ? string
  : F extends EnumField<infer V>
    ? V
    : F extends { kind: 'int' }
      ? number
      : F extends { kind: 'bool' }
        ? boolean
        : F extends { kind: 'ids' }
          ? (string | null)[]
          : never;

export type HashState<F extends Record<string, FieldSpec>> = { [K in keyof F]: FieldValue<F[K]> };

/** Field builders: they keep literal enum types without `as const` at call sites. */
export const field = {
  str: (key: string, def = '', opts: { maxLength?: number; pattern?: RegExp } = {}): StrField => ({
    kind: 'str',
    key,
    default: def,
    ...opts,
  }),
  enum: <const V extends string>(key: string, values: readonly V[], def: V): EnumField<V> => ({
    kind: 'enum',
    key,
    values,
    default: def,
  }),
  int: (key: string, def = 0, opts: { min?: number; max?: number } = {}): IntField => ({ kind: 'int', key, default: def, ...opts }),
  bool: (key: string, def = false): BoolField => ({ kind: 'bool', key, default: def }),
  ids: (
    key: string,
    opts: { default?: readonly (string | null)[]; universe?: readonly string[]; width?: number; maxItems?: number } = {},
  ): IdsField => {
    const f: IdsField = { kind: 'ids', key, default: opts.default ?? [], pack: opts.universe ? 'index' : 'csv' };
    if (opts.universe) f.universe = opts.universe;
    if (opts.width !== undefined) f.width = opts.width;
    if (opts.maxItems !== undefined) f.maxItems = opts.maxItems;
    return f;
  },
};

/** Budget from the critique: links must survive Discord/chat clients. */
export const DEFAULT_MAX_HASH_LENGTH = 200;

const NULL_TOKEN = '-';
const KEY_RE = /^[a-z][a-z0-9]{0,3}$/;

export interface DecodeResult<S> {
  state: S;
  /** False when anything was ignored or replaced by a default. */
  ok: boolean;
  issues: string[];
  /** Version found in the hash, if any. */
  version: number | null;
}

export interface EncodeResult {
  hash: string;
  length: number;
  fits: boolean;
  /** Ids that could not be packed (not in the universe) and were written as empty slots. */
  dropped: string[];
}

export interface HashCodecOptions<F extends Record<string, FieldSpec>> {
  version: number;
  fields: F;
  maxLength?: number;
  /** Upgrade params from an older version; return null to fall back to defaults. */
  migrate?: (from: number, params: Record<string, string>) => Record<string, string> | null;
}

export interface HashCodec<S> {
  readonly version: number;
  readonly maxLength: number;
  defaults(): S;
  encode(state: Partial<S>): string;
  encodeWithInfo(state: Partial<S>): EncodeResult;
  decode(hash: string | null | undefined): S;
  decodeWithInfo(hash: string | null | undefined): DecodeResult<S>;
}

function cloneDefault(f: FieldSpec): unknown {
  return f.kind === 'ids' ? [...f.default] : f.default;
}

function sameValue(f: FieldSpec, value: unknown): boolean {
  if (f.kind !== 'ids') return value === f.default;
  const list = value as readonly (string | null)[];
  return list.length === f.default.length && list.every((v, i) => v === f.default[i]);
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return null;
  }
}

/** Split "#a=1&b=2" into params (first occurrence of a key wins). */
export function parseHashParams(hash: string): Record<string, string> {
  // Null prototype: a key like "__proto__" in a crafted link stays an inert own property.
  const out = Object.create(null) as Record<string, string>;
  const body = hash.startsWith('#') ? hash.slice(1) : hash;
  for (const part of body.split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const key = safeDecode(eq < 0 ? part : part.slice(0, eq));
    if (key === null || Object.hasOwn(out, key)) continue;
    out[key] = eq < 0 ? '' : part.slice(eq + 1);
  }
  return out;
}

function widthOf(f: IdsField): number {
  return f.width ?? 2;
}

function encodeValue(f: FieldSpec, value: unknown, dropped: string[]): string {
  switch (f.kind) {
    case 'str':
      return encodeURIComponent(String(value));
    case 'enum':
      return encodeURIComponent(String(value));
    case 'int':
      return String(Math.trunc(Number(value)));
    case 'bool':
      return value ? '1' : '0';
    case 'ids': {
      const list = value as readonly (string | null)[];
      if (f.pack === 'csv') return list.map((id) => (id === null ? NULL_TOKEN : encodeURIComponent(id))).join(',');
      const width = widthOf(f);
      const index = new Map((f.universe ?? []).map((id, i) => [id, i]));
      return list
        .map((id) => {
          const i = id === null ? undefined : index.get(id);
          if (id !== null && i === undefined) dropped.push(id);
          return i === undefined ? NULL_TOKEN.repeat(width) : i.toString(36).padStart(width, '0');
        })
        .join('');
    }
  }
}

/** Parse one raw (still percent-encoded) value; undefined = invalid. */
function decodeValue(f: FieldSpec, raw: string, issues: string[]): unknown {
  switch (f.kind) {
    case 'str': {
      const s = safeDecode(raw);
      if (s === null || (f.maxLength !== undefined && s.length > f.maxLength) || (f.pattern && !f.pattern.test(s))) return undefined;
      return s;
    }
    case 'enum': {
      const s = safeDecode(raw);
      return s !== null && (f.values as readonly string[]).includes(s) ? s : undefined;
    }
    case 'int': {
      if (!/^-?\d{1,15}$/.test(raw)) return undefined;
      const n = Number(raw);
      if ((f.min !== undefined && n < f.min) || (f.max !== undefined && n > f.max)) return undefined;
      return n === 0 ? 0 : n;
    }
    case 'bool':
      if (raw === '1' || raw === 'true') return true;
      if (raw === '0' || raw === 'false') return false;
      return undefined;
    case 'ids': {
      let list: (string | null)[];
      if (raw === '') {
        list = [];
      } else if (f.pack === 'csv') {
        list = [];
        for (const token of raw.split(',')) {
          if (token === '' || token === NULL_TOKEN) list.push(null);
          else {
            const id = safeDecode(token);
            if (id === null) return undefined;
            list.push(id);
          }
        }
      } else {
        const width = widthOf(f);
        const universe = f.universe ?? [];
        if (raw.length % width !== 0 || !/^[0-9a-z-]+$/.test(raw)) return undefined;
        list = [];
        for (let i = 0; i < raw.length; i += width) {
          const chunk = raw.slice(i, i + width);
          if (chunk === NULL_TOKEN.repeat(width)) {
            list.push(null);
            continue;
          }
          if (chunk.includes(NULL_TOKEN)) return undefined;
          const idx = parseInt(chunk, 36);
          const id = universe[idx];
          if (id === undefined) issues.push(`${f.key}: unknown index "${chunk}"`);
          list.push(id ?? null);
        }
      }
      if (f.maxItems !== undefined && list.length > f.maxItems) return undefined;
      return list;
    }
  }
}

export function createHashCodec<F extends Record<string, FieldSpec>>(opts: HashCodecOptions<F>): HashCodec<HashState<F>> {
  const { version } = opts;
  const maxLength = opts.maxLength ?? DEFAULT_MAX_HASH_LENGTH;
  const entries = Object.entries(opts.fields) as [keyof F & string, FieldSpec][];
  const seen = new Set<string>(['v']);
  for (const [name, f] of entries) {
    if (!KEY_RE.test(f.key)) throw new Error(`Hash key "${f.key}" for ${name} must be 1–4 lowercase letters/digits`);
    if (seen.has(f.key)) throw new Error(`Hash key "${f.key}" is reserved or used twice`);
    seen.add(f.key);
    if (f.kind === 'ids' && f.pack === 'index') {
      const width = widthOf(f);
      if (!(width >= 1) || (f.universe?.length ?? 0) >= 36 ** width) {
        throw new Error(`Universe for "${f.key}" does not fit in ${width} base36 characters`);
      }
    }
  }
  if (!Number.isInteger(version) || version < 1) throw new Error('Hash version must be a positive integer');

  type S = HashState<F>;
  const defaults = (): S => {
    const out: Record<string, unknown> = {};
    for (const [name, f] of entries) out[name] = cloneDefault(f);
    return out as S;
  };

  const encodeWithInfo = (state: Partial<S>): EncodeResult => {
    const dropped: string[] = [];
    const parts = [`v=${version}`];
    for (const [name, f] of entries) {
      const value = (state as Record<string, unknown>)[name];
      if (value === undefined || sameValue(f, value)) continue;
      parts.push(`${f.key}=${encodeValue(f, value, dropped)}`);
    }
    const hash = `#${parts.join('&')}`;
    return { hash, length: hash.length, fits: hash.length <= maxLength, dropped };
  };

  const decodeWithInfo = (hash: string | null | undefined): DecodeResult<S> => {
    const issues: string[] = [];
    try {
      const text = typeof hash === 'string' ? hash.trim() : '';
      if (text === '' || text === '#') return { state: defaults(), ok: true, issues, version: null };
      let params = parseHashParams(text);
      const rawVersion = params['v'];
      const found = rawVersion !== undefined && /^\d{1,6}$/.test(rawVersion) ? Number(rawVersion) : null;
      if (found === null) return { state: defaults(), ok: false, issues: ['missing or bad version'], version: null };
      if (found !== version) {
        const migrated = found < version && opts.migrate ? opts.migrate(found, params) : null;
        if (!migrated) return { state: defaults(), ok: false, issues: [`unsupported version ${found}`], version: found };
        params = migrated;
        issues.push(`migrated from version ${found}`);
      }
      const state = defaults() as Record<string, unknown>;
      for (const [name, f] of entries) {
        const raw = params[f.key];
        if (raw === undefined) continue;
        const value = decodeValue(f, raw, issues);
        if (value === undefined) issues.push(`${f.key}: invalid value`);
        else state[name] = value;
      }
      return { state: state as S, ok: issues.length === 0, issues, version: found };
    } catch {
      return { state: defaults(), ok: false, issues: ['unreadable hash'], version: null };
    }
  };

  return {
    version,
    maxLength,
    defaults,
    encode: (state) => encodeWithInfo(state).hash,
    encodeWithInfo,
    decode: (hash) => decodeWithInfo(hash).state,
    decodeWithInfo,
  };
}

/** Does a hash fit the share budget? */
export function withinBudget(hash: string, max = DEFAULT_MAX_HASH_LENGTH): boolean {
  return hash.length <= max;
}

// ---- browser helpers --------------------------------------------------------------------------

export interface LocationLike {
  hash: string;
  pathname?: string;
  search?: string;
}

export interface HistoryLike {
  readonly state?: unknown;
  replaceState(data: unknown, unused: string, url?: string | null): void;
  pushState(data: unknown, unused: string, url?: string | null): void;
}

export interface HashEventTarget {
  addEventListener(type: 'hashchange', listener: () => void): void;
  removeEventListener(type: 'hashchange', listener: () => void): void;
}

/** Injected browser objects (tests pass fakes; the default reads globalThis safely). */
export interface HashEnv {
  location?: LocationLike | null;
  history?: HistoryLike | null;
  events?: HashEventTarget | null;
}

function browserEnv(): HashEnv {
  try {
    const g = globalThis as unknown as {
      location?: LocationLike;
      history?: HistoryLike;
      addEventListener?: unknown;
    };
    return {
      location: g.location ?? null,
      history: g.history ?? null,
      events: typeof g.addEventListener === 'function' ? (g as unknown as HashEventTarget) : null,
    };
  } catch {
    return {};
  }
}

/** Current hash including '#', or '' (never throws, e.g. during SSR). */
export function readHash(env: HashEnv = browserEnv()): string {
  try {
    const h = env.location?.hash ?? '';
    return typeof h === 'string' ? h : '';
  } catch {
    return '';
  }
}

/**
 * Set the hash without scrolling or (by default) adding a history entry. Returns false if the
 * browser refused. Writing the current value is a no-op.
 */
export function writeHash(hash: string, opts: { push?: boolean; env?: HashEnv } = {}): boolean {
  const env = opts.env ?? browserEnv();
  const target = hash === '' || hash === '#' ? '' : hash.startsWith('#') ? hash : `#${hash}`;
  try {
    const loc = env.location;
    if (!loc) return false;
    if (readHash(env) === target) return true;
    const history = env.history;
    if (history) {
      const url = `${loc.pathname ?? ''}${loc.search ?? ''}${target}`;
      if (opts.push) history.pushState(history.state ?? null, '', url);
      else history.replaceState(history.state ?? null, '', url);
      return true;
    }
    loc.hash = target;
    return true;
  } catch {
    return false;
  }
}

/** Subscribe to back/forward and manual hash edits. Returns an unsubscribe function. */
export function onHashChange(callback: (hash: string) => void, env: HashEnv = browserEnv()): () => void {
  const target = env.events;
  if (!target) return () => {};
  const listener = (): void => callback(readHash(env));
  try {
    target.addEventListener('hashchange', listener);
  } catch {
    return () => {};
  }
  return () => {
    try {
      target.removeEventListener('hashchange', listener);
    } catch {
      // Nothing to clean up if the page is already gone.
    }
  };
}
