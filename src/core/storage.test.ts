import { describe, expect, it } from 'vitest';
import {
  createStore,
  memoryStorage,
  storageKey,
  type StorageEventLike,
  type StorageEventSource,
  type StorageLike,
} from './storage.ts';

function fakeEvents() {
  const listeners = new Set<(e: StorageEventLike) => void>();
  const source: StorageEventSource = {
    addEventListener: (_t, l) => void listeners.add(l),
    removeEventListener: (_t, l) => void listeners.delete(l),
  };
  const fire = (e: StorageEventLike): void => {
    for (const l of [...listeners]) l(e);
  };
  return { source, listeners, fire };
}

const throwing = (what: 'all' | 'write'): StorageLike => ({
  getItem: () => {
    if (what === 'all') throw new Error('SecurityError');
    return null;
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
  removeItem: () => {
    if (what === 'all') throw new Error('SecurityError');
  },
});

const isStringArray = (v: unknown): string[] | undefined =>
  Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;

describe('createStore', () => {
  it('namespaces keys and wraps values with a schema version', () => {
    const storage = memoryStorage();
    const store = createStore('hots', { storage, events: null });
    expect(store.prefix).toBe('whetstone:hots:');
    expect(storageKey('site', 'theme')).toBe('whetstone:site:theme');
    expect(store.set('pool', ['abathur', 'liming'])).toBe(true);
    expect(storage.getItem('whetstone:hots:pool')).toBe('{"v":1,"d":["abathur","liming"]}');
    expect(store.get('pool', [] as string[])).toEqual(['abathur', 'liming']);
    expect(store.persistent).toBe(true);
  });

  it('exposes the raw stored string, including values only held in memory', () => {
    const storage = memoryStorage({ 'whetstone:hots:bare': '{"owned":["Abat"]}' });
    const store = createStore('hots', { storage, events: null });
    expect(store.raw('bare')).toBe('{"owned":["Abat"]}');
    expect(store.raw('missing')).toBeNull();
    const memoryOnly = createStore('hots', { storage: throwing('write'), events: null });
    memoryOnly.set('k', 1);
    expect(memoryOnly.raw('k')).toBe('{"v":1,"d":1}');
  });

  it('returns the fallback for missing, corrupt, foreign or old-version values', () => {
    const storage = memoryStorage({
      'whetstone:hots:corrupt': '{nope',
      'whetstone:hots:bare': '"just a string"',
      'whetstone:hots:old': '{"v":0,"d":5}',
      'whetstone:hots:nulled': 'null',
    });
    const store = createStore('hots', { storage, events: null });
    expect(store.get('missing', 7)).toBe(7);
    expect(store.get('corrupt', 7)).toBe(7);
    expect(store.get('bare', 7)).toBe(7);
    expect(store.get('old', 7)).toBe(7);
    expect(store.get('nulled', 7)).toBe(7);
    const v2 = createStore('hots', { storage, events: null, version: 2 });
    store.set('x', 1);
    expect(v2.get('x', 0)).toBe(0);
  });

  it('validates values when asked', () => {
    const store = createStore('hots', { storage: memoryStorage(), events: null });
    store.set('pool', ['a', 'b']);
    expect(store.get('pool', [], isStringArray)).toEqual(['a', 'b']);
    store.set('pool', [1, 2]);
    expect(store.get('pool', ['fallback'], isStringArray)).toEqual(['fallback']);
    const explode = (): string[] => {
      throw new Error('bad validator');
    };
    expect(store.get('pool', ['safe'], explode)).toEqual(['safe']);
  });

  it('keeps games apart and lists its own keys', () => {
    const storage = memoryStorage({ 'other:app': 'x' });
    const hots = createStore('hots', { storage, events: null });
    const mtga = createStore('mtga', { storage, events: null });
    hots.set('b', 1);
    hots.set('a', 2);
    mtga.set('a', 3);
    expect(hots.get('a', 0)).toBe(2);
    expect(mtga.get('a', 0)).toBe(3);
    expect(hots.keys()).toEqual(['a', 'b']);
    hots.remove('a');
    expect(hots.keys()).toEqual(['b']);
    expect(hots.get('a', 0)).toBe(0);
  });

  it('falls back to memory when storage is unusable', () => {
    const store = createStore('pokemon', { storage: throwing('all'), events: null });
    expect(store.set('team', { mons: 6 })).toBe(false);
    expect(store.get('team', null)).toEqual({ mons: 6 });
    expect(store.persistent).toBe(false);
    expect(store.keys()).toEqual(['team']);
    store.remove('team');
    expect(store.get('team', null)).toBeNull();
  });

  it('keeps unsaved writes in memory when the quota is full', () => {
    const store = createStore('mtga', { storage: throwing('write'), events: null });
    expect(store.persistent).toBe(true);
    expect(store.set('deck', 'x'.repeat(10))).toBe(false);
    expect(store.persistent).toBe(false);
    expect(store.get('deck', '')).toBe('x'.repeat(10));
  });

  it('works memory-only when told to, and refuses unserialisable values', () => {
    const store = createStore('site', { storage: null, events: null });
    expect(store.persistent).toBe(false);
    expect(store.set('theme', 'dark')).toBe(false);
    expect(store.get('theme', 'light')).toBe('dark');
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(store.set('cyclic', cyclic)).toBe(false);
    expect(store.get('cyclic', 'none')).toBe('none');
  });

  it('notifies same-page subscribers and unsubscribes', () => {
    const store = createStore('hots', { storage: memoryStorage(), events: null });
    const seen: unknown[] = [];
    const off = store.subscribe('sort', (v) => seen.push(v));
    store.set('sort', 'counters');
    store.set('other', 'ignored');
    store.remove('sort');
    off();
    store.set('sort', 'map');
    expect(seen).toEqual(['counters', undefined]);
  });

  it('isolates a throwing subscriber', () => {
    const store = createStore('hots', { storage: memoryStorage(), events: null });
    const seen: unknown[] = [];
    store.subscribe('k', () => {
      throw new Error('boom');
    });
    store.subscribe('k', (v) => seen.push(v));
    store.set('k', 1);
    expect(seen).toEqual([1]);
  });

  it('follows other tabs through the storage event', () => {
    const storage = memoryStorage();
    const ev = fakeEvents();
    const store = createStore('hots', { storage, events: ev.source });
    const seen: unknown[] = [];
    expect(ev.listeners.size).toBe(0);
    const off = store.subscribe('pool', (v) => seen.push(v));
    expect(ev.listeners.size).toBe(1);
    ev.fire({ key: 'whetstone:hots:pool', newValue: '{"v":1,"d":["muradin"]}', storageArea: storage });
    ev.fire({ key: 'whetstone:mtga:pool', newValue: '{"v":1,"d":["x"]}', storageArea: storage });
    ev.fire({ key: 'whetstone:hots:pool', newValue: '{"v":1,"d":["y"]}', storageArea: memoryStorage() });
    ev.fire({ key: 'whetstone:hots:pool', newValue: null, storageArea: storage });
    ev.fire({ key: 'whetstone:hots:pool', newValue: 'garbage', storageArea: storage });
    ev.fire({ key: null, newValue: null, storageArea: storage });
    expect(seen).toEqual([['muradin'], undefined, undefined, undefined]);
    off();
    expect(ev.listeners.size).toBe(0);
  });

  it('does not break when the global storage is missing (Node)', () => {
    const store = createStore('hots');
    store.set('k', 1);
    expect(store.get('k', 0)).toBe(1);
  });
});

describe('memoryStorage', () => {
  it('behaves like a Storage', () => {
    const s = memoryStorage({ a: '1' });
    s.setItem('b', '2');
    expect(s.length).toBe(2);
    expect(s.key(1)).toBe('b');
    expect(s.key(5)).toBeNull();
    s.removeItem('a');
    expect(s.getItem('a')).toBeNull();
  });
});
