/**
 * Page-side client for the analyzer worker: one worker per page, promise-based requests,
 * progress events. Only imported by islands, and only used inside effects/handlers (never
 * during server rendering).
 */
import type { InitRequest, ResultMap, WorkerMessage, WorkerProgress, WorkerRequest, WorkerRequestBody } from './protocol.ts';
import { isProgress } from './protocol.ts';

/** The slice of the Worker API the client needs (a fake one in tests). */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  onmessage: ((event: { data: WorkerMessage }) => void) | null;
  onerror: ((event: { message?: string }) => void) | null;
  terminate(): void;
}

export class AnalyzerError extends Error {
  readonly code: string;
  constructor(message: string, code = 'internal') {
    super(message);
    this.name = 'AnalyzerError';
    this.code = code;
  }
}

type Body<T extends WorkerRequestBody['type']> = Omit<Extract<WorkerRequestBody, { type: T }>, 'type'>;

export class AnalyzerClient {
  private readonly worker: WorkerLike;
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private readonly listeners = new Set<(p: WorkerProgress) => void>();
  private ready: Promise<ResultMap['init']> | null = null;
  private initBody: Omit<InitRequest, 'type'> | null = null;

  constructor(worker: WorkerLike) {
    this.worker = worker;
    worker.onmessage = (event) => {
      const m = event.data;
      if (isProgress(m)) {
        for (const l of this.listeners) l(m);
        return;
      }
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.ok) p.resolve(m.result);
      else p.reject(new AnalyzerError(m.error.message, m.error.code));
    };
    worker.onerror = (event) => {
      const err = new AnalyzerError(`The analyzer stopped unexpectedly${event.message ? `: ${event.message}` : ''}. Reload the page to try again.`, 'worker_error');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
      this.ready = null;
    };
  }

  /** Subscribe to download/cache/index progress. Returns an unsubscribe function. */
  onProgress(listener: (p: WorkerProgress) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  request<T extends WorkerRequestBody['type']>(type: T, body: Body<T>): Promise<ResultMap[T]> {
    const id = ++this.seq;
    return new Promise<ResultMap[T]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      try {
        this.worker.postMessage({ ...body, type, id } as unknown as WorkerRequest);
      } catch (err) {
        this.pending.delete(id);
        reject(err instanceof Error ? err : new AnalyzerError(String(err)));
      }
    });
  }

  /** Initialise once (later calls share the first promise; a failed init can be retried). */
  init(body: Omit<InitRequest, 'type'>): Promise<ResultMap['init']> {
    if (this.ready && this.initBody && this.initBody.snapshot === body.snapshot) return this.ready;
    this.initBody = body;
    const p = this.request('init', body);
    this.ready = p;
    p.catch(() => {
      if (this.ready === p) this.ready = null;
    });
    return p;
  }

  terminate(): void {
    this.worker.terminate();
    const err = new AnalyzerError('The analyzer was closed.', 'closed');
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}

let shared: AnalyzerClient | null = null;

/** The page's analyzer (created on first use). */
export function analyzer(): AnalyzerClient {
  if (!shared) {
    const worker = new Worker(new URL('./analyzer.worker.ts', import.meta.url), { type: 'module', name: 'mtga-analyzer' });
    shared = new AnalyzerClient(worker as unknown as WorkerLike);
  }
  return shared;
}
