/**
 * Turns protocol requests into Engine calls and engine results into protocol responses. Kept
 * apart from analyzer.worker.ts (which only wires `self`, fetch and IndexedDB) so the whole
 * message protocol is testable in Node with a fake worker.
 */
import { Engine, EngineError } from './engine.ts';
import type { InitRequest, WorkerError, WorkerMessage, WorkerRequest } from './protocol.ts';

export interface HandlerDeps {
  engine: Engine;
  post: (message: WorkerMessage) => void;
  /** Called before the engine handles an init request (the worker stores shard URLs here). */
  configure?: (req: InitRequest) => void;
  /** True when the last shard came from the IndexedDB cache (reported in InitResult). */
  cached?: () => boolean;
}

export function toWorkerError(err: unknown): WorkerError {
  if (err instanceof EngineError) return { message: err.message, code: err.code };
  if (err instanceof Error) return { message: `Something went wrong in the analyzer: ${err.message}`, code: 'internal' };
  return { message: 'Something went wrong in the analyzer.', code: 'internal' };
}

/** Request types the handler accepts; anything else is answered with an error. */
const TYPES = new Set(['init', 'analyze', 'simulate', 'hand', 'suggest', 'search', 'checkLists']);

export function createHandler(deps: HandlerDeps): (msg: WorkerRequest) => Promise<void> {
  const { engine, post } = deps;
  return async (msg) => {
    const id = typeof msg?.id === 'number' ? msg.id : -1;
    try {
      if (!msg || typeof msg !== 'object' || !TYPES.has(msg.type)) throw new EngineError('bad_request', `Unknown request ${JSON.stringify((msg as { type?: unknown })?.type)}`);
      let result: unknown;
      switch (msg.type) {
        case 'init': {
          deps.configure?.(msg);
          const r = await engine.init(msg.pool ?? 'standard');
          result = { ...r, cached: deps.cached?.() ?? false };
          break;
        }
        case 'analyze':
          result = await engine.analyze(msg);
          break;
        case 'simulate':
          result = await engine.simulate(msg);
          break;
        case 'hand':
          result = await engine.hand(msg);
          break;
        case 'suggest':
          result = await engine.suggest(msg);
          break;
        case 'search':
          result = await engine.search(msg);
          break;
        case 'checkLists':
          result = await engine.checkLists(msg);
          break;
      }
      post({ id, ok: true, result });
    } catch (err) {
      post({ id, ok: false, error: toWorkerError(err) });
    }
  };
}
