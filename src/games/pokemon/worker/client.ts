/**
 * Page-side handle to the damage-calc worker. The worker (and @smogon/calc, about 120 kB
 * gzipped) is only downloaded the first time a page asks for a calculation, and it is the only
 * copy of the calc in the site: there is no main-thread fallback, so pages stay light. If the
 * worker can't start or crashes, pending and later requests reject with a readable error and the
 * islands say the calculator is unavailable.
 */
import type { CalcRequest, CalcResponse, MatrixRequest, MatrixResponse, WorkerRequest, WorkerResponse } from './protocol.ts';

type Pending = { resolve: (value: unknown) => void; reject: (err: Error) => void };

export interface CalcClient {
  calc(req: CalcRequest): Promise<CalcResponse>;
  matrix(req: MatrixRequest): Promise<MatrixResponse>;
}

let client: CalcClient | null = null;

function failingClient(message: string): CalcClient {
  const fail = () => Promise.reject(new Error(message));
  return { calc: fail, matrix: fail };
}

function workerClient(worker: Worker): CalcClient {
  let next = 1;
  let broken: string | null = null;
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
    broken = event.message || 'The calculator stopped unexpectedly.';
    const err = new Error(broken);
    for (const p of pending.values()) p.reject(err);
    pending.clear();
    worker.terminate();
    // Start a fresh worker on the next request.
    client = null;
  };
  const send = <T>(msg: { type: 'calc'; payload: CalcRequest } | { type: 'matrix'; payload: MatrixRequest }): Promise<T> =>
    broken
      ? Promise.reject(new Error(broken))
      : new Promise<T>((resolve, reject) => {
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
  if (typeof Worker !== 'function') return failingClient('This browser cannot run the damage calculator (no Web Worker support).');
  try {
    const worker = new Worker(new URL('./calc.worker.ts', import.meta.url), { type: 'module', name: 'whetstone-calc' });
    client = workerClient(worker);
  } catch (err) {
    return failingClient(`The damage calculator could not start: ${err instanceof Error ? err.message : String(err)}`);
  }
  return client;
}
