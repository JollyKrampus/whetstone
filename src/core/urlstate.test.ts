import { describe, expect, it } from 'vitest';
import {
  createHashCodec,
  field,
  onHashChange,
  parseHashParams,
  readHash,
  withinBudget,
  writeHash,
  type HashEnv,
  type HistoryLike,
  type LocationLike,
} from './urlstate.ts';

const HEROES = ['abathur', 'alarak', 'liming', 'muradin', 'chogall', 'thebutcher'];

const codec = createHashCodec({
  version: 1,
  fields: {
    map: field.str('m', '', { maxLength: 40, pattern: /^[a-z0-9-]*$/ }),
    firstPick: field.enum('fp', ['a', 'b'], 'a'),
    mode: field.enum('md', ['seq', 'free'], 'seq'),
    steps: field.ids('s', { universe: HEROES, maxItems: 16 }),
    sort: field.int('o', 0, { min: 0, max: 6 }),
    pool: field.bool('p'),
    picks: field.ids('k'),
  },
});

describe('createHashCodec', () => {
  it('decodes empty input to defaults', () => {
    const d = codec.defaults();
    expect(d).toEqual({ map: '', firstPick: 'a', mode: 'seq', steps: [], sort: 0, pool: false, picks: [] });
    for (const h of ['', '#', null, undefined, '   ']) expect(codec.decodeWithInfo(h)).toMatchObject({ state: d, ok: true });
  });

  it('keeps literal types for enum fields', () => {
    const fp: 'a' | 'b' = codec.decode('#v=1&fp=b').firstPick;
    expect(fp).toBe('b');
  });

  it('omits defaults and writes fields in declaration order', () => {
    expect(codec.encode(codec.defaults())).toBe('#v=1');
    expect(codec.encode({})).toBe('#v=1');
    const hash = codec.encode({
      map: 'cursed-hollow',
      firstPick: 'b',
      steps: ['abathur', 'alarak', null, 'chogall'],
      sort: 3,
      pool: true,
      picks: ['liming', null, 'the butcher'],
    });
    expect(hash).toBe('#v=1&m=cursed-hollow&fp=b&s=0001--04&o=3&p=1&k=liming,-,the%20butcher');
  });

  it('round-trips', () => {
    const state = {
      map: 'braxis-holdout',
      firstPick: 'b' as const,
      mode: 'free' as const,
      steps: ['thebutcher', null, 'liming', 'abathur'],
      sort: 6,
      pool: true,
      picks: ['a,b', 'é', null],
    };
    expect(codec.decode(codec.encode(state))).toEqual(state);
  });

  it('fits a full 16-step draft well inside the share budget', () => {
    const steps = Array.from({ length: 16 }, (_, i) => HEROES[i % HEROES.length]!);
    const info = codec.encodeWithInfo({ map: 'alterac-pass', firstPick: 'b', steps });
    expect(info.fits).toBe(true);
    expect(info.length).toBeLessThan(60);
    expect(withinBudget(info.hash)).toBe(true);
    expect(withinBudget('#'.padEnd(201, 'x'))).toBe(false);
  });

  it('reports ids it cannot pack and writes empty slots instead', () => {
    const info = codec.encodeWithInfo({ steps: ['abathur', 'newhero'] });
    expect(info.hash).toBe('#v=1&s=00--');
    expect(info.dropped).toEqual(['newhero']);
  });

  it('flags hashes over budget', () => {
    const info = codec.encodeWithInfo({ picks: Array.from({ length: 40 }, (_, i) => `hero${i}`) });
    expect(info.fits).toBe(false);
    expect(info.length).toBeGreaterThan(200);
  });

  describe('robust decoding', () => {
    const d = codec.defaults();
    it.each([
      ['#garbage', 'missing or bad version'],
      ['#v=one&m=x', 'missing or bad version'],
      ['#v=2&m=x', 'unsupported version 2'],
      ['#m=x', 'missing or bad version'],
    ])('%s → defaults', (hash, issue) => {
      const r = codec.decodeWithInfo(hash);
      expect(r.state).toEqual(d);
      expect(r.ok).toBe(false);
      expect(r.issues).toEqual([issue]);
    });

    it('replaces only the bad fields', () => {
      const r = codec.decodeWithInfo('#v=1&m=Bad%20Map&fp=c&o=99&p=maybe&s=0&k=%E0%A4%A&md=free');
      expect(r.state).toEqual({ ...d, mode: 'free' });
      expect(r.ok).toBe(false);
      expect(r.issues).toHaveLength(6);
    });

    it('rejects malformed index lists and maps unknown indices to empty slots', () => {
      expect(codec.decode('#v=1&s=0').steps).toEqual([]);
      expect(codec.decode('#v=1&s=0-').steps).toEqual([]);
      expect(codec.decode('#v=1&s=0A').steps).toEqual([]);
      const r = codec.decodeWithInfo('#v=1&s=01zz');
      expect(r.state.steps).toEqual(['alarak', null]);
      expect(r.issues).toEqual(['s: unknown index "zz"']);
      expect(codec.decode(`#v=1&s=${'00'.repeat(17)}`).steps).toEqual([]);
    });

    it('accepts the first of duplicate keys and ignores unknown ones', () => {
      const r = codec.decodeWithInfo('#v=1&fp=b&fp=a&zz=1&__proto__=x');
      expect(r.state.firstPick).toBe('b');
      expect(r.ok).toBe(true);
      expect(({} as Record<string, unknown>)['x']).toBeUndefined();
    });

    it('reads csv lists with empty and null tokens', () => {
      expect(codec.decode('#v=1&k=a,,-,b').picks).toEqual(['a', null, null, 'b']);
      expect(codec.decode('#v=1&k=').picks).toEqual([]);
    });

    it('never throws on hostile input', () => {
      for (const h of ['#v=1&m=%', '#&&&=&=', '#v=1&o=-0', '#v=1&o=1e3', '#v=99999999', `#v=1&m=${'a'.repeat(5000)}`]) {
        expect(() => codec.decode(h)).not.toThrow();
      }
      expect(codec.decode('#v=1&o=1e3').sort).toBe(0);
    });
  });

  it('migrates older versions when asked', () => {
    const v2 = createHashCodec({
      version: 2,
      fields: { map: field.str('mp'), side: field.enum('fp', ['a', 'b'], 'a') },
      migrate: (from, params) => (from === 1 ? { mp: params['m'] ?? '', fp: params['fp'] ?? 'a' } : null),
    });
    const r = v2.decodeWithInfo('#v=1&m=hanamura&fp=b');
    expect(r.state).toEqual({ map: 'hanamura', side: 'b' });
    expect(r.version).toBe(1);
    expect(r.issues).toEqual(['migrated from version 1']);
    expect(v2.decode('#v=3&mp=x')).toEqual(v2.defaults());
  });

  it('rejects bad configuration early', () => {
    expect(() => createHashCodec({ version: 1, fields: { a: field.str('v') } })).toThrow(/reserved/);
    expect(() => createHashCodec({ version: 1, fields: { a: field.str('m'), b: field.int('m') } })).toThrow(/twice/);
    expect(() => createHashCodec({ version: 1, fields: { a: field.str('Map') } })).toThrow(/lowercase/);
    expect(() => createHashCodec({ version: 0, fields: {} })).toThrow(/version/);
    const big = Array.from({ length: 40 }, (_, i) => `h${i}`);
    expect(() => createHashCodec({ version: 1, fields: { s: field.ids('s', { universe: big, width: 1 }) } })).toThrow(/fit/);
  });

  it('parses params leniently', () => {
    expect(parseHashParams('#a=1&b&c=x%20y')).toEqual({ a: '1', b: '', c: 'x%20y' });
  });
});

describe('browser helpers', () => {
  function fakeEnv(hash = '') {
    const location: LocationLike = { hash, pathname: '/whetstone/hots/draft/', search: '?x=1' };
    const calls: [string, string | null | undefined][] = [];
    const history: HistoryLike = {
      state: { keep: true },
      replaceState: (_d, _u, url) => {
        calls.push(['replace', url]);
        location.hash = url?.includes('#') ? url.slice(url.indexOf('#')) : '';
      },
      pushState: (_d, _u, url) => {
        calls.push(['push', url]);
        location.hash = url?.includes('#') ? url.slice(url.indexOf('#')) : '';
      },
    };
    const listeners = new Set<() => void>();
    const events = {
      addEventListener: (_t: 'hashchange', l: () => void) => void listeners.add(l),
      removeEventListener: (_t: 'hashchange', l: () => void) => void listeners.delete(l),
    };
    const env: HashEnv = { location, history, events };
    return { env, location, calls, listeners };
  }

  it('reads and writes through history without adding entries', () => {
    const { env, calls } = fakeEnv('#v=1');
    expect(readHash(env)).toBe('#v=1');
    expect(writeHash('#v=1&m=x', { env })).toBe(true);
    expect(calls).toEqual([['replace', '/whetstone/hots/draft/?x=1#v=1&m=x']]);
    expect(readHash(env)).toBe('#v=1&m=x');
    expect(writeHash('v=1&m=x', { env })).toBe(true);
    expect(calls).toHaveLength(1);
    writeHash('#v=1&m=y', { env, push: true });
    expect(calls.at(-1)).toEqual(['push', '/whetstone/hots/draft/?x=1#v=1&m=y']);
    writeHash('', { env });
    expect(calls.at(-1)).toEqual(['replace', '/whetstone/hots/draft/?x=1']);
  });

  it('falls back to location.hash without history', () => {
    const location: LocationLike = { hash: '' };
    expect(writeHash('#v=1', { env: { location } })).toBe(true);
    expect(location.hash).toBe('#v=1');
  });

  it('never throws when the browser objects do', () => {
    const hostile: HashEnv = {
      location: {
        get hash(): string {
          throw new Error('denied');
        },
        set hash(_v: string) {
          throw new Error('denied');
        },
      },
    };
    expect(readHash(hostile)).toBe('');
    expect(writeHash('#v=1', { env: hostile })).toBe(false);
    expect(readHash({})).toBe('');
    expect(writeHash('#v=1', { env: {} })).toBe(false);
  });

  it('subscribes to hashchange and unsubscribes', () => {
    const { env, location, listeners } = fakeEnv('#v=1');
    const seen: string[] = [];
    const off = onHashChange((h) => seen.push(h), env);
    expect(listeners.size).toBe(1);
    location.hash = '#v=1&m=z';
    for (const l of listeners) l();
    expect(seen).toEqual(['#v=1&m=z']);
    off();
    expect(listeners.size).toBe(0);
    expect(typeof onHashChange(() => {}, {})).toBe('function');
  });

  it('works under Node without a window', () => {
    expect(readHash()).toBe('');
    expect(writeHash('#v=1')).toBe(false);
    onHashChange(() => {})();
  });
});
