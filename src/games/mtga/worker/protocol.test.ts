/**
 * The worker message protocol end to end, without a real Worker: the page-side client talks to
 * the worker-side handler through a fake that structured-clones every message both ways (so a
 * non-cloneable result would fail here exactly as it would in the browser).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../../lib/datadir.ts';
import { AnalyzerClient, AnalyzerError, type WorkerLike } from './client.ts';
import { Engine, type ShardData } from './engine.ts';
import { createHandler, toWorkerError } from './handler.ts';
import { FORMAT_IDS, isFormatId, isProgress, type Pool, type WorkerMessage, type WorkerRequest } from './protocol.ts';

const FIXTURES = path.join(repoRoot(), 'fixtures', 'mtga', 'public');
const shard = (pool: Pool): ShardData => JSON.parse(fs.readFileSync(path.join(FIXTURES, `_cards.${pool}.json`), 'utf8')) as ShardData;
const DECK = 'Deck\n4 Shock\n4 Lightning Strike\n4 Burst Lightning\n4 Hired Claw\n4 Emberheart Challenger\n4 Slickshot Show-Off\n4 Razorkin Needlehead\n4 Sunspine Lynx\n4 Boltwave\n24 Mountain';

function fakeWorker(opts: { loads?: Pool[]; crash?: boolean } = {}) {
  const sent: WorkerRequest[] = [];
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      sent.push(structuredClone(message));
      if (opts.crash) {
        queueMicrotask(() => worker.onerror?.({ message: 'boom' }));
        return;
      }
      void handle(structuredClone(message));
    },
    terminate() {},
  };
  const post = (m: WorkerMessage) => queueMicrotask(() => worker.onmessage?.({ data: structuredClone(m) }));
  const engine = new Engine(async (pool) => {
    opts.loads?.push(pool);
    post({ type: 'progress', stage: 'index', pool });
    return shard(pool);
  });
  const handle = createHandler({ engine, post, cached: () => false });
  return { worker, sent };
}

describe('analyzer protocol', () => {
  it('initialises once and answers typed requests with cloneable results', async () => {
    const loads: Pool[] = [];
    const { worker, sent } = fakeWorker({ loads });
    const client = new AnalyzerClient(worker);
    const progress: string[] = [];
    client.onProgress((p) => progress.push(`${p.stage}:${p.pool}`));
    const shards = { standard: '/s.json', arena: '/a.json' };
    const [a, b] = await Promise.all([client.init({ shards, snapshot: 'snap' }), client.init({ shards, snapshot: 'snap' })]);
    expect(a).toEqual(b);
    expect(a).toMatchObject({ pool: 'standard', snapshot: expect.any(String), cached: false });
    expect(sent.filter((m) => m.type === 'init')).toHaveLength(1);

    const r = await client.request('analyze', { text: DECK, format: null, meta: null });
    expect(r.format).toBe('standard');
    expect(r.legality.map((l) => l.format)).toEqual([...FORMAT_IDS]);
    expect(r.counts.main).toBe(60);
    const hand = await client.request('hand', { text: DECK, seed: 9 });
    expect(hand.hand).toHaveLength(7);
    const search = await client.request('search', { query: 'o:damage', format: 'standard', order: 'mv', limit: 3 });
    expect(search.cards.length).toBeLessThanOrEqual(3);
    expect(progress).toContain('index:standard');
    expect(loads).toEqual(['standard']);
    // Ids are unique and increasing; every request got exactly one answer.
    expect(sent.map((m) => m.id)).toEqual([1, 2, 3, 4]);
  });

  it('suggests and applies upgrades through the protocol', async () => {
    const client = new AnalyzerClient(fakeWorker().worker);
    await client.init({ shards: { standard: '/s', arena: '/a' }, snapshot: 'x' });
    const s = await client.request('suggest', { text: DECK, format: 'standard', mode: 'casual', intensity: 'normal', wildcards: null, keepCards: [], maxSwaps: 3, meta: null });
    expect(s.changes.deckSize).toBe(60);
    const applied = await client.request('apply', { text: DECK, swaps: s.swaps.slice(0, 1).map((w) => ({ cut: w.cut, add: w.add, qty: w.qty })) });
    expect(applied.text.startsWith('Deck\n')).toBe(true);
    if (s.swaps[0]) expect(applied.text).toContain(s.swaps[0].add);
    const checks = await client.request('checkLists', { lists: [{ list: DECK, format: 'standard' }, { list: 'Deck\n4 Not A Card', format: 'standard' }] });
    expect(checks[0]).toMatchObject({ main: 60, legal: true, colors: ['R'] });
    expect(checks[1]?.legal).toBe(false);
  });

  it('turns engine errors into rejected promises with codes', async () => {
    const client = new AnalyzerClient(fakeWorker().worker);
    await client.init({ shards: { standard: '/s', arena: '/a' }, snapshot: 'x' });
    await expect(client.request('analyze', { text: '', format: null, meta: null })).rejects.toMatchObject({ name: 'AnalyzerError', code: 'empty_deck' });
    await expect(client.request('hand', { text: 'Deck\n4 Shock', seed: 1 })).rejects.toMatchObject({ code: 'small_deck' });
  });

  it('rejects unknown request types and pending requests when the worker crashes', async () => {
    const { worker } = fakeWorker();
    const client = new AnalyzerClient(worker);
    await expect(client.request('nope' as 'init', {} as never)).rejects.toMatchObject({ code: 'bad_request' });

    const crashing = new AnalyzerClient(fakeWorker({ crash: true }).worker);
    const p = crashing.init({ shards: { standard: '/s', arena: '/a' }, snapshot: 'x' });
    await expect(p).rejects.toBeInstanceOf(AnalyzerError);
    await expect(p).rejects.toThrow(/stopped unexpectedly: boom/);
  });

  it('labels and recognizes messages', () => {
    expect(isProgress({ type: 'progress', stage: 'cache', pool: 'arena' })).toBe(true);
    expect(isProgress({ id: 1, ok: true, result: null })).toBe(false);
    expect(isFormatId('standardbrawl')).toBe(true);
    expect(isFormatId('explorer')).toBe(false);
    expect(toWorkerError(new Error('x'))).toEqual({ message: 'Something went wrong in the analyzer: x', code: 'internal' });
    expect(toWorkerError('weird')).toMatchObject({ code: 'internal' });
  });
});
