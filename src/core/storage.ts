/**
 * Small, failure-proof localStorage wrapper for per-visitor preferences (hero pool, owned
 * heroes, sort mode, saved teams). Keys are namespaced "whetstone:<scope>:<key>" and values are
 * wrapped with a schema version so a format change can never crash an old visitor's page.
 *
 * Storage can throw on access (Safari private mode, blocked site data) or on write (quota). Every
 * call is guarded; when storage is unusable the store keeps values in memory for the session.
 * Nothing here touches the DOM directly, so it is testable with an injected Storage-like object.
 */
import type { GameId } from './game.ts';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  readonly length?: number;
  key?(index: number): string | null;
}

export interface StorageEventLike {
  key: string | null;
  newValue: string | null;
  storageArea?: unknown;
}

export interface StorageEventSource {
  addEventListener(type: 'storage', listener: (event: StorageEventLike) => void): void;
  removeEventListener(type: 'storage', listener: (event: StorageEventLike) => void): void;
}

/** Site-wide preferences (theme, …) use 'site'. */
export type StoreScope = GameId | 'site';

export interface StoreOptions {
  /** Defaults to globalThis.localStorage when usable; null forces memory-only. */
  storage?: StorageLike | null;
  /** Defaults to globalThis when it can add listeners; null disables cross-tab updates. */
  events?: StorageEventSource | null;
  /** Schema version stored with each value (default 1). Other versions read as missing. */
  version?: number;
}

/** Return the value if valid, or undefined to fall back. */
export type Validator<T> = (value: unknown) => T | undefined;

export interface Store {
  readonly scope: StoreScope;
  /** "whetstone:<scope>:" */
  readonly prefix: string;
  /** False when values only live in memory for this page view. */
  readonly persistent: boolean;
  get<T>(key: string, fallback: T, validate?: Validator<T>): T;
  /**
   * The stored string as written (null when absent), without unwrapping the version envelope:
   * for readers that must also accept a value some other writer stored bare.
   */
  raw(key: string): string | null;
  /** Returns true when the value reached persistent storage. */
  set<T>(key: string, value: T): boolean;
  remove(key: string): void;
  /** Keys (without prefix) currently stored for this scope, sorted. */
  keys(): string[];
  /** Called on changes from this page and from other tabs; undefined = removed. */
  subscribe(key: string, listener: (value: unknown) => void): () => void;
}

export const STORAGE_ROOT = 'whetstone';

export function storageKey(scope: StoreScope, key: string): string {
  return `${STORAGE_ROOT}:${scope}:${key}`;
}

const PROBE = `${STORAGE_ROOT}:__probe__`;

function detectStorage(): StorageLike | null {
  try {
    // Only browsers (window) have a usable localStorage; Node 25+ warns on a bare access.
    if (typeof (globalThis as { window?: unknown }).window === 'undefined') return null;
    const s = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!s) return null;
    s.setItem(PROBE, '1');
    s.removeItem(PROBE);
    return s;
  } catch {
    return null;
  }
}

function detectEvents(): StorageEventSource | null {
  try {
    const g = globalThis as { addEventListener?: unknown; removeEventListener?: unknown };
    return typeof g.addEventListener === 'function' && typeof g.removeEventListener === 'function'
      ? (globalThis as unknown as StorageEventSource)
      : null;
  } catch {
    return null;
  }
}

interface Envelope {
  v: number;
  d: unknown;
}

function unwrap(raw: string | null | undefined, version: number): { found: boolean; value: unknown } {
  if (raw === null || raw === undefined) return { found: false, value: undefined };
  try {
    const parsed = JSON.parse(raw) as Partial<Envelope> | null;
    if (!parsed || typeof parsed !== 'object' || parsed.v !== version || !('d' in parsed)) return { found: false, value: undefined };
    return { found: true, value: parsed.d };
  } catch {
    return { found: false, value: undefined };
  }
}

export function createStore(scope: StoreScope, opts: StoreOptions = {}): Store {
  const version = opts.version ?? 1;
  const storage = opts.storage === undefined ? detectStorage() : opts.storage;
  const events = opts.events === undefined ? detectEvents() : opts.events;
  const prefix = `${STORAGE_ROOT}:${scope}:`;
  // Values that could not be persisted (no storage, quota): newest wins over storage.
  const memory = new Map<string, string>();
  const listeners = new Map<string, Set<(value: unknown) => void>>();
  let persistent = storage !== null;

  const readRaw = (full: string): string | null => {
    if (memory.has(full)) return memory.get(full)!;
    if (!storage) return null;
    try {
      return storage.getItem(full);
    } catch {
      return null;
    }
  };

  const notify = (key: string, value: unknown): void => {
    const set = listeners.get(key);
    if (!set) return;
    for (const l of [...set]) {
      try {
        l(value);
      } catch {
        // A broken subscriber must not stop the others.
      }
    }
  };

  let onStorage: ((e: StorageEventLike) => void) | null = null;
  const ensureCrossTab = (): void => {
    if (onStorage || !events) return;
    onStorage = (e) => {
      if (e.storageArea !== undefined && storage && e.storageArea !== storage) return;
      if (e.key === null) {
        // storage.clear() in another tab.
        for (const key of listeners.keys()) notify(key, undefined);
        return;
      }
      if (!e.key.startsWith(prefix)) return;
      const key = e.key.slice(prefix.length);
      memory.delete(e.key);
      const { found, value } = unwrap(e.newValue, version);
      notify(key, found ? value : undefined);
    };
    try {
      events.addEventListener('storage', onStorage);
    } catch {
      onStorage = null;
    }
  };

  return {
    scope,
    prefix,
    get persistent() {
      return persistent;
    },
    get<T>(key: string, fallback: T, validate?: Validator<T>): T {
      const { found, value } = unwrap(readRaw(prefix + key), version);
      if (!found) return fallback;
      if (!validate) return value as T;
      try {
        const checked = validate(value);
        return checked === undefined ? fallback : checked;
      } catch {
        return fallback;
      }
    },
    raw(key: string): string | null {
      return readRaw(prefix + key);
    },
    set<T>(key: string, value: T): boolean {
      const full = prefix + key;
      let raw: string;
      try {
        raw = JSON.stringify({ v: version, d: value } satisfies Envelope);
      } catch {
        return false;
      }
      let saved = false;
      if (storage) {
        try {
          storage.setItem(full, raw);
          saved = true;
        } catch {
          persistent = false;
        }
      }
      if (saved) memory.delete(full);
      else memory.set(full, raw);
      notify(key, unwrap(raw, version).value);
      return saved;
    },
    remove(key: string): void {
      const full = prefix + key;
      memory.delete(full);
      if (storage) {
        try {
          storage.removeItem(full);
        } catch {
          // Removal failing leaves the old value; nothing more we can do.
        }
      }
      notify(key, undefined);
    },
    keys(): string[] {
      const out = new Set<string>();
      for (const full of memory.keys()) if (full.startsWith(prefix)) out.add(full.slice(prefix.length));
      if (storage && typeof storage.key === 'function') {
        try {
          const len = storage.length ?? 0;
          for (let i = 0; i < len; i++) {
            const full = storage.key(i);
            if (full?.startsWith(prefix)) out.add(full.slice(prefix.length));
          }
        } catch {
          // Enumeration is best-effort.
        }
      }
      return [...out].sort();
    },
    subscribe(key: string, listener: (value: unknown) => void): () => void {
      ensureCrossTab();
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(listener);
      return () => {
        const s = listeners.get(key);
        s?.delete(listener);
        if (s && s.size === 0) listeners.delete(key);
        if (listeners.size === 0 && onStorage && events) {
          try {
            events.removeEventListener('storage', onStorage);
          } catch {
            // Already detached.
          }
          onStorage = null;
        }
      };
    },
  };
}

/** In-memory Storage implementation (tests, SSR, or an explicit no-persistence mode). */
export function memoryStorage(initial: Record<string, string> = {}): StorageLike & { readonly length: number; key(i: number): string | null } {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, String(v)),
    removeItem: (k) => void data.delete(k),
    get length() {
      return data.size;
    },
    key: (i) => [...data.keys()][i] ?? null,
  };
}
