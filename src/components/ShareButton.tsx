import { useEffect, useRef, useState } from 'preact/hooks';
import { copyText } from './clipboard.ts';

interface Props {
  title?: string;
  text?: string;
  /** Defaults to the current URL at click time, so hash-encoded state (drafts, decks) is included. */
  url?: string;
  label?: string;
  class?: string;
}

type State = 'idle' | 'copied' | 'error';

/**
 * Island: share the current view. Touch devices get the native share sheet; elsewhere the link
 * is copied, because desktop share dialogs rarely beat a pasted URL.
 */
export default function ShareButton({ title, text, url, label = 'Share', class: extra }: Props) {
  const [state, setState] = useState<State>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function onClick() {
    const link = url ?? window.location.href;
    const coarse = window.matchMedia('(pointer: coarse)').matches;
    if (coarse && typeof navigator.share === 'function') {
      try {
        await navigator.share({ url: link, ...(title ? { title } : {}), ...(text ? { text } : {}) });
        return;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
      }
    }
    const ok = await copyText(link);
    setState(ok ? 'copied' : 'error');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2400);
  }

  const shown = state === 'copied' ? 'Link copied' : state === 'error' ? 'Copy failed' : label;
  return (
    <span class="share-btn-wrap">
      <button type="button" class={extra ? `btn share-btn ${extra}` : 'btn share-btn'} onClick={onClick} data-state={state}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          {state === 'copied' ? (
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          ) : (
            <>
              <path d="M10 14l10-10" />
              <path d="M14 4h6v6" />
              <path d="M19 14v4.5A1.5 1.5 0 0 1 17.5 20h-12A1.5 1.5 0 0 1 4 18.5v-12A1.5 1.5 0 0 1 5.5 5H10" />
            </>
          )}
        </svg>
        <span>{shown}</span>
      </button>
      <span class="visually-hidden" role="status" aria-live="polite">
        {state === 'copied' ? 'Link copied to clipboard' : state === 'error' ? 'Copy failed' : ''}
      </span>
    </span>
  );
}
