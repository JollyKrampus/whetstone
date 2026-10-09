import { useEffect, useRef, useState } from 'preact/hooks';
import { copyText } from './clipboard.ts';

interface Props {
  /** Literal text to copy. */
  text?: string;
  /** CSS selector of an element whose value (inputs) or text content is copied at click time. */
  from?: string;
  label?: string;
  copiedLabel?: string;
  class?: string;
}

type State = 'idle' | 'copied' | 'error';

/** Island: copy a string (e.g. a Showdown paste or talent build) with an announced result. */
export default function CopyButton({ text, from, label = 'Copy', copiedLabel = 'Copied', class: extra }: Props) {
  const [state, setState] = useState<State>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  async function onClick() {
    let value = text ?? '';
    if (from) {
      const el = document.querySelector(from);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) value = el.value;
      else if (el) value = el.textContent ?? '';
    }
    const ok = value !== '' && (await copyText(value));
    setState(ok ? 'copied' : 'error');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), 2000);
  }

  const shown = state === 'copied' ? copiedLabel : state === 'error' ? 'Copy failed' : label;
  return (
    <span class="copy-btn-wrap">
      <button type="button" class={extra ? `btn copy-btn ${extra}` : 'btn copy-btn'} onClick={onClick} data-state={state}>
        <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          {state === 'copied' ? (
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          ) : (
            <>
              <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
              <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
            </>
          )}
        </svg>
        <span>{shown}</span>
      </button>
      <span class="visually-hidden" role="status" aria-live="polite">
        {state === 'copied' ? 'Copied to clipboard' : state === 'error' ? 'Copy failed' : ''}
      </span>
    </span>
  );
}
