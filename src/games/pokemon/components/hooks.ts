/**
 * Preact hooks shared by the Pokémon islands: the dex shard, debounced values and the calc
 * worker. Browser-only behaviour happens in effects, so server rendering stays deterministic.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { DexIndex } from './lib/dex.ts';
import { loadDex } from './lib/dexclient.ts';

export type DexState = { status: 'loading' } | { status: 'ready'; dex: DexIndex } | { status: 'error'; message: string };

/**
 * The Champions dex from the staged shard URL (loading → ready | error), plus `retry` to load it
 * again after an error (a failed load is not cached, see dexclient.ts).
 */
export function useDex(url: string | null): DexState & { retry: () => void } {
  const [state, setState] = useState<DexState>(url ? { status: 'loading' } : { status: 'error', message: 'No Pokédex data is published yet.' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!url) return;
    let live = true;
    setState({ status: 'loading' });
    loadDex(url).then(
      (dex) => live && setState({ status: 'ready', dex }),
      (err: unknown) => live && setState({ status: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
    return () => {
      live = false;
    };
  }, [url, attempt]);
  return { ...state, retry: () => setAttempt((n) => n + 1) };
}

/**
 * What a visitor already typed into a server-rendered field before the island hydrated, as the
 * field's initial state: `useState(() => typedBeforeHydration('pk-paste'))`.
 *
 * Without it the island's state starts empty, and Preact writes a textarea's `value` even while
 * hydrating (inputs only on the next render), so a paste made while the scripts were still
 * loading would vanish. The initializer runs in the hydrating render before Preact touches the
 * DOM, so the field still holds the text. On the server there is no document: ''.
 */
export function typedBeforeHydration(id: string): string {
  if (typeof document === 'undefined') return '';
  const el = document.getElementById(id);
  return el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement ? el.value.replace(/\r\n?/g, '\n') : '';
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
