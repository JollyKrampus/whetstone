import { useEffect, useMemo, useState } from 'preact/hooks';
import { toId } from './lib/dex.ts';

export interface ComboOption {
  id: string;
  label: string;
}

interface Props {
  /** Element id of the input (its label points here). */
  id: string;
  label: string;
  /** Selected option id, or undefined for empty. */
  value: string | undefined;
  options: readonly ComboOption[];
  onCommit: (id: string | undefined) => void;
  /** id of a <datalist> rendered elsewhere (shared lists); otherwise one is rendered here. */
  listId?: string;
  placeholder?: string;
  /** Visually hide the label (it stays the accessible name). */
  hideLabel?: boolean;
  /** Extra visible hint under the input. */
  hint?: string;
  disabled?: boolean;
  /** Empty the field after each commit (an "add" box rather than a value field). */
  clearOnCommit?: boolean;
}

/** Map of every way to name an option (id, toId(label)) to its id. */
export function optionIndex(options: readonly ComboOption[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const o of options) {
    map.set(o.id, o.id);
    const k = toId(o.label);
    if (!map.has(k)) map.set(k, o.id);
  }
  return map;
}

/**
 * Text input with suggestions (native <datalist>, so it works with keyboards, screen readers and
 * phone keyboards). Typing never changes the value; a value is committed when a suggestion is
 * picked, on Enter or when the field loses focus. Unknown text is flagged, not guessed.
 */
export default function ComboInput({ id, label, value, options, onCommit, listId, placeholder, hideLabel = false, hint, disabled = false, clearOnCommit = false }: Props) {
  const index = useMemo(() => optionIndex(options), [options]);
  const labelOf = (v: string | undefined) => (v ? (options.find((o) => o.id === v)?.label ?? v) : '');
  const [text, setText] = useState(labelOf(value));
  const [bad, setBad] = useState(false);

  useEffect(() => {
    setText(labelOf(value));
    setBad(false);
  }, [value, options]);

  const commit = (raw: string) => {
    const t = raw.trim();
    if (t === '') {
      setBad(false);
      if (value !== undefined) onCommit(undefined);
      return;
    }
    const hit = index.get(toId(t));
    if (hit) {
      setBad(false);
      setText(clearOnCommit ? '' : labelOf(hit));
      if (hit !== value || clearOnCommit) onCommit(hit);
    } else setBad(true);
  };

  const own = listId === undefined;
  const list = listId ?? `${id}-list`;
  const hintId = `${id}-hint`;
  return (
    <div class="pk-field">
      <label for={id} class={hideLabel ? 'visually-hidden' : undefined}>
        {label}
      </label>
      <input
        id={id}
        class="pk-input"
        list={list}
        value={text}
        placeholder={placeholder}
        disabled={disabled}
        autocomplete="off"
        spellcheck={false}
        aria-invalid={bad ? 'true' : undefined}
        aria-describedby={bad || hint ? hintId : undefined}
        onInput={(e) => {
          const el = e.currentTarget as HTMLInputElement;
          setText(el.value);
          // A pick from the suggestion list arrives without a typing inputType.
          const kind = (e as InputEvent).inputType;
          if ((kind === undefined || kind === 'insertReplacementText') && index.has(toId(el.value))) commit(el.value);
        }}
        onChange={(e) => commit((e.currentTarget as HTMLInputElement).value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit((e.currentTarget as HTMLInputElement).value);
          }
        }}
      />
      {(bad || hint) && (
        <small id={hintId} class={bad ? 'pk-field__error' : 'pk-subtle'}>
          {bad ? `Not found: pick one of the suggestions.` : hint}
        </small>
      )}
      {own && (
        <datalist id={list}>
          {options.map((o) => (
            <option value={o.label} key={o.id} />
          ))}
        </datalist>
      )}
    </div>
  );
}

/** A shared <datalist> for ComboInputs that pass `listId`. */
export function OptionList({ id, options }: { id: string; options: readonly ComboOption[] }) {
  return (
    <datalist id={id}>
      {options.map((o) => (
        <option value={o.label} key={o.id} />
      ))}
    </datalist>
  );
}
