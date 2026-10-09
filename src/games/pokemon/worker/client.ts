/**
 * Page-side handle to the damage-calc worker. The worker (and @smogon/calc with it) is only
 * downloaded the first time a page asks for a calculation. Where module workers are unavailable
 * the same code is imported on the main thread instead, so results never depend on the browser.
 */
import type { CalcRequest, CalcResponse, MatrixRequest, MatrixResponse, WorkerRequest, WorkerResponse } from './protocol.ts';

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void };

export interface CalcClient {
  calc(req: CalcRequest): Promise<CalcResponse>;
  matrix(req: MatrixRequest): Promise<MatrixResponse>;
}

let client: CalcClient | null = null;

function inlineClient(): CalcClient {
  const core = import('./calc-core.ts');
  return {
    calc: async (req) => (await core).runCalc(req),
    matrix: async (req) => (await core).runMatrix(req),
  };
}

function workerClient(worker: Worker): CalcClient {
  let next = 1;
  const pending = new Map<number, Pending>();
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const res = event.data;
    const p = pending.get(res.id);
    if (!p) return;
    pending.delete(res.id);
    if (res.ok) p.resolve(res.result);
    else p.reject(new Error(res.error));
  };
  worker.onerror = (event) => {
    event.preventDefault();
    const err = new Error(event.message || 'The calculator stopped unexpectedly.');
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    // Fall back to the main thread for the rest of the session.
    client = inlineClient();
  };
  const send = <T>(msg: { type: 'calc'; payload: CalcRequest } | { type: 'matrix'; payload: MatrixRequest }): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      worker.postMessage({ ...msg, id } as WorkerRequest);
    });
  return {
    calc: (payload) => send<CalcResponse>({ type: 'calc', payload }),
    matrix: (payload) => send<MatrixResponse>({ type: 'matrix', payload }),
  };
}

/** The shared calc client (creates the worker on first use). */
export function calcClient(): CalcClient {
  if (client) return client;
  try {
    if (typeof Worker === 'function') {
      const worker = new Worker(new URL('./calc.worker.ts', import.meta.url), { type: 'module', name: 'whetstone-calc' });
      client = workerClient(worker);
      return client;
    }
  } catch {
    // Fall through to the inline client.
  }
  client = inlineClient();
  return client;
}
