/**
 * Preact hooks shared by the Pokémon islands: the dex shard, debounced values and the calc
 * worker. Browser-only behaviour happens in effects, so server rendering stays deterministic.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DexIndex } from './lib/dex.ts';
import { loadDex } from './lib/dexclient.ts';

export type DexState = { status: 'loading' } | { status: 'ready'; dex: DexIndex } | { status: 'error'; message: string };

/** The Champions dex from the staged shard URL (loading → ready | error). */
export function useDex(url: string | null): DexState {
  const [state, setState] = useState<DexState>(url ? { status: 'loading' } : { status: 'error', message: 'No Pokédex data is published yet.' });
  useEffect(() => {
    if (!url) return;
    let live = true;
    loadDex(url).then(
      (dex) => live && setState({ status: 'ready', dex }),
      (err: unknown) => live && setState({ status: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [url]);
  return state;
}

/** `value`, updated only after it has been stable for `ms`. */
export function useDebounced<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

export type Async<T> = { status: 'idle' } | { status: 'busy' } | { status: 'done'; value: T } | { status: 'error'; message: string };

/**
 * Run `task` whenever `key` changes (skipped while `key` is null); stale results are dropped,
 * so only the latest request wins.
 */
export function useAsync<T>(key: string | null, task: () => Promise<T>): Async<T> {
  const [state, setState] = useState<Async<T>>({ status: 'idle' });
  const latest = useRef(0);
  const run = useRef(task);
  run.current = task;
  useEffect(() => {
    if (key === null) {
      setState({ status: 'idle' });
      return;
    }
    const ticket = ++latest.current;
    setState({ status: 'busy' });
    run.current().then(
      (value) => ticket === latest.current && setState({ status: 'done', value }),
      (err: unknown) => ticket === latest.current && setState({ status: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  }, [key]);
  return state;
}
