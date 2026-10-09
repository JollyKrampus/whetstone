/// <reference lib="webworker" />
/**
 * Damage-calc worker: keeps @smogon/calc (about 120 kB gzipped) off the main thread and
 * out of every page that doesn't need it. Loaded lazily by ./client.ts.
 */
import { runCalc, runMatrix } from './calc-core.ts';
import type { WorkerRequest, WorkerResponse } from './protocol.ts';

const scope = self as unknown as DedicatedWorkerGlobalScope;

scope.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const req = event.data;
  let res: WorkerResponse;
  try {
    if (req.type === 'calc') res = { id: req.id, ok: true, type: 'calc', result: runCalc(req.payload) };
    else if (req.type === 'matrix') res = { id: req.id, ok: true, type: 'matrix', result: runMatrix(req.payload) };
    else res = { id: req.id, ok: true, type: 'ping', result: { ready: true } };
  } catch (err) {
    res = { id: req.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  scope.postMessage(res);
};
