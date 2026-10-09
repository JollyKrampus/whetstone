import { describe, expect, it } from 'vitest';
import { compareStrings, hashTree, jsonBytes, sha256, shortHash, stableStringify } from './hash.ts';

describe('stableStringify', () => {
  it('sorts object keys recursively and keeps array order', () => {
    const a = stableStringify({ b: 1, a: { d: [3, 1, 2], c: null } });
    const b = stableStringify({ a: { c: null, d: [3, 1, 2] }, b: 1 });
    expect(a).toBe('{"a":{"c":null,"d":[3,1,2]},"b":1}');
    expect(b).toBe(a);
  });

  it('follows JSON semantics for undefined, functions, dates and non-finite numbers', () => {
    const out = stableStringify({ u: undefined, f: () => 1, d: new Date('2026-10-08T00:00:00Z'), n: Number.NaN, arr: [undefined, 1] });
    expect(out).toBe('{"arr":[null,1],"d":"2026-10-08T00:00:00.000Z","n":null}');
  });

  it('rejects circular structures and BigInt', () => {
    const o: Record<string, unknown> = {};
    o.self = o;
    expect(() => stableStringify(o)).toThrow(/circular/i);
    expect(() => stableStringify({ n: 1n })).toThrow(/BigInt/);
  });

  it('allows the same object twice when it is not circular', () => {
    const shared = { x: 1 };
    expect(stableStringify({ a: shared, b: shared })).toBe('{"a":{"x":1},"b":{"x":1}}');
  });

  it('uses code-unit order, not locale order', () => {
    expect(['b', 'B', 'a', 'é', 'Z'].sort(compareStrings)).toEqual(['B', 'Z', 'a', 'b', 'é']);
  });
});

describe('jsonBytes', () => {
  it('ends with exactly one newline in both modes', () => {
    const compact = new TextDecoder().decode(jsonBytes({ b: 1, a: [1] }, false));
    const pretty = new TextDecoder().decode(jsonBytes({ b: 1, a: [1] }, true));
    expect(compact).toBe('{"a":[1],"b":1}\n');
    expect(pretty).toBe('{\n  "a": [\n    1\n  ],\n  "b": 1\n}\n');
  });
});

describe('hashing', () => {
  it('computes standard sha256', () => {
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(shortHash('abc')).toBe('ba7816bf');
  });

  it('hashTree ignores entry order but not paths, content or extra', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const base = hashTree([
      { path: 'b.json', bytes: enc('2') },
      { path: 'a.json', bytes: enc('1') },
    ]);
    expect(hashTree([
      { path: 'a.json', bytes: enc('1') },
      { path: 'b.json', bytes: enc('2') },
    ])).toBe(base);
    expect(hashTree([
      { path: 'a.json', bytes: enc('1') },
      { path: 'c.json', bytes: enc('2') },
    ])).not.toBe(base);
    expect(hashTree([
      { path: 'a.json', bytes: enc('1') },
      { path: 'b.json', bytes: enc('3') },
    ])).not.toBe(base);
    expect(hashTree([{ path: 'a.json', bytes: enc('1') }, { path: 'b.json', bytes: enc('2') }], { v: 1 })).not.toBe(base);
    expect(hashTree([], { b: 1, a: 2 })).toBe(hashTree([], { a: 2, b: 1 }));
  });
});
