import { describe, expect, it } from 'vitest';
import type { Edge } from './game.ts';
import { createLookup, decodeEdges, encodeEdges, isEdgeMatrix, MATRIX_VERSION, type EdgeMatrix } from './matrix.ts';

const blind = { kind: 'theory' as const, text: 'Blinds an auto-attack reliant hero', evidence: ['Blinding Wind'], source: 'whetstone' };

const EDGES: Edge[] = [
  {
    a: 'muradin',
    b: 'illidan',
    score: 72,
    delta: 2.37,
    n: 812,
    z: 2.11,
    source: 'stats',
    reasons: [{ kind: 'stat', text: 'Wins 54.1% vs Illidan (expected 50.9%), n=812', n: 812, delta: 2.37, source: 'hp' }],
  },
  { a: 'illidan', b: 'muradin', score: 28, delta: -2.37, n: 812, z: -2.11, source: 'stats', reasons: [] },
  { a: 'johanna', b: 'illidan', score: 64, source: 'theory', reasons: [blind] },
  { a: 'falstad', b: 'valla', score: 61, source: 'theory', reasons: [{ ...blind }] },
  { a: 'abathur', b: 'zeratul', score: 55, n: 20, source: 'curated', reasons: [{ kind: 'curated', text: 'Reveal with Symbiote' }] },
];

describe('encodeEdges / decodeEdges', () => {
  it('round-trips losslessly by default', () => {
    const m = encodeEdges(EDGES);
    expect(decodeEdges(m)).toEqual(EDGES);
    // JSON round-trip too: the payload is what the browser fetches.
    expect(decodeEdges(JSON.parse(JSON.stringify(m)) as EdgeMatrix)).toEqual(EDGES);
  });

  it('stores ids once, sorted, and refers to them by index', () => {
    const m = encodeEdges(EDGES);
    expect(m.v).toBe(MATRIX_VERSION);
    expect(m.ids).toEqual(['abathur', 'falstad', 'illidan', 'johanna', 'muradin', 'valla', 'zeratul']);
    expect(m.srcs).toEqual(['curated', 'stats', 'theory']);
    expect(m.a[0]).toBe(m.ids.indexOf('muradin'));
    expect(m.delta).toEqual([2.37, -2.37, null, null, null]);
    expect(m.n).toEqual([812, 812, null, null, 20]);
    expect(m.z).toEqual([2.11, -2.11, null, null, null]);
  });

  it('deduplicates reasons into a table', () => {
    const m = encodeEdges(EDGES);
    expect(m.reasons!.table).toHaveLength(3);
    expect(m.reasons!.rows).toEqual([[0], [], [1], [1], [2]]);
  });

  it('can drop reasons and round numbers', () => {
    const m = encodeEdges(
      [{ a: 'x', b: 'y', score: 51, delta: 0.123456, z: -1.98765, source: 'stats', reasons: [blind] }],
      { reasons: false, digits: 2 },
    );
    expect(m.reasons).toBeUndefined();
    expect(decodeEdges(m)).toEqual([{ a: 'x', b: 'y', score: 51, delta: 0.12, z: -1.99, source: 'stats', reasons: [] }]);
  });

  it('omits the z column when no edge has z', () => {
    const m = encodeEdges([{ a: 'x', b: 'y', score: 50, source: 'theory', reasons: [] }]);
    expect('z' in m).toBe(false);
  });

  it('is deterministic and handles empty input', () => {
    expect(JSON.stringify(encodeEdges(EDGES))).toBe(JSON.stringify(encodeEdges(EDGES.map((e) => ({ ...e })))));
    const empty = encodeEdges([]);
    expect(decodeEdges(empty)).toEqual([]);
    expect(isEdgeMatrix(empty)).toBe(true);
  });
});

describe('isEdgeMatrix', () => {
  const good = encodeEdges(EDGES);
  const mutate = (patch: Record<string, unknown>): unknown => ({ ...JSON.parse(JSON.stringify(good)), ...patch });

  it('accepts encoder output and rejects malformed payloads', () => {
    expect(isEdgeMatrix(good)).toBe(true);
    expect(isEdgeMatrix(null)).toBe(false);
    expect(isEdgeMatrix('x')).toBe(false);
    expect(isEdgeMatrix(mutate({ v: 2 }))).toBe(false);
    expect(isEdgeMatrix(mutate({ a: [0, 1] }))).toBe(false);
    expect(isEdgeMatrix(mutate({ b: [0, 1, 2, 3, 99] }))).toBe(false);
    expect(isEdgeMatrix(mutate({ score: [1, 2, 3, 4, 'x'] }))).toBe(false);
    expect(isEdgeMatrix(mutate({ srcs: ['curated', 'stats', 'rumours'] }))).toBe(false);
    expect(isEdgeMatrix(mutate({ reasons: { table: [], rows: [[0], [], [], [], []] } }))).toBe(false);
    expect(() => decodeEdges(mutate({ n: [1] }) as EdgeMatrix)).toThrow(/Malformed/);
  });
});

describe('createLookup', () => {
  it('looks up directed edges', () => {
    const l = createLookup(encodeEdges(EDGES));
    expect(l.size).toBe(5);
    expect(l.get('muradin', 'illidan')?.delta).toBe(2.37);
    expect(l.has('illidan', 'johanna')).toBe(false);
    expect(l.score('illidan', 'muradin')).toBe(28);
    expect(l.score('valla', 'falstad')).toBe(50);
    expect(l.score('valla', 'falstad', 0)).toBe(0);
    expect(l.from('illidan').map((e) => e.b)).toEqual(['muradin']);
    expect(l.to('illidan').map((e) => e.a)).toEqual(['muradin', 'johanna']);
    expect(l.ids).toContain('zeratul');
  });

  it('looks up undirected edges in either orientation', () => {
    const syn: Edge[] = [
      { a: 'abathur', b: 'zeratul', score: 60, source: 'stats', reasons: [] },
      { a: 'tyrael', b: 'zeratul', score: 58, source: 'stats', reasons: [] },
    ];
    const l = createLookup(syn, { undirected: true });
    expect(l.get('zeratul', 'abathur')).toMatchObject({ a: 'zeratul', b: 'abathur', score: 60 });
    expect(l.get('abathur', 'zeratul')).toBe(syn[0]);
    expect(l.from('zeratul').map((e) => [e.a, e.b])).toEqual([
      ['zeratul', 'abathur'],
      ['zeratul', 'tyrael'],
    ]);
    expect(l.to('zeratul')).toHaveLength(2);
    expect(syn[0]!.a).toBe('abathur');
  });

  it('returns copies of lists so callers cannot corrupt the index', () => {
    const l = createLookup(EDGES);
    l.from('muradin').pop();
    expect(l.from('muradin')).toHaveLength(1);
  });
});
