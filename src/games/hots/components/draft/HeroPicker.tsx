import type { ComponentChildren } from 'preact';
import { useMemo, useRef, useState } from 'preact/hooks';
import { createSearchIndex, normalize } from '../../../../core/search.ts';
import type { HeroRole } from '../../schema.ts';
import { ROLE_SHORT, portraitUrl, roleText, type RosterHero } from './props.ts';

export interface TileStatus {
  ok: boolean;
  /** Short visible status for unavailable heroes ("Banned by you"). */
  label: string;
  /** Sentence shown when an unavailable hero is chosen. */
  why: string;
}

interface Props {
  heroes: readonly RosterHero[];
  /** Availability per hero id at the current step (missing = available). */
  status: (id: string) => TileStatus | undefined;
  onChoose: (id: string) => void;
  /** Prefix for element ids (two pickers never share a page, but keep ids unique anyway). */
  idPrefix: string;
  /** Visible heading, e.g. "Choose Your pick (step 5)". */
  heading: string;
  /** Verb for the tile's accessible name: "Pick", "Ban", "Add". */
  verb: string;
  /** Badges per hero id ("Free", "New", "Favourite"). */
  badges?: (id: string) => string[];
  /** Controls rendered next to the search (e.g. "Skip this ban"). */
  actions?: ComponentChildren;
  disabled?: boolean;
}

const ROLES: readonly HeroRole[] = ['Tank', 'Bruiser', 'Healer', 'Support', 'Ranged Assassin', 'Melee Assassin'];

function columnsOf(grid: HTMLElement | null): number {
  if (!grid) return 1;
  const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').filter(Boolean).length;
  return Math.max(1, cols);
}

/**
 * Hero grid with alias-aware search and a role filter. Tiles stay focusable when unavailable
 * (aria-disabled) so keyboard and screen-reader users can learn *why*; choosing one shows the
 * explanation instead of acting. Arrow keys move between tiles (one tab stop for the grid);
 * Enter in the search box chooses the first available match.
 */
export default function HeroPicker({ heroes, status, onChoose, idPrefix, heading, verb, badges, actions, disabled = false }: Props) {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState<HeroRole | null>(null);
  const [focus, setFocus] = useState(0);
  const [message, setMessage] = useState('');
  const gridRef = useRef<HTMLUListElement>(null);

  // Deterministic (no locale collation) so server HTML and hydration agree.
  const byName = useMemo(() => {
    const key = (h: RosterHero) => normalize(h.name);
    return [...heroes].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : a.id < b.id ? -1 : 1));
  }, [heroes]);
  const index = useMemo(
    () => createSearchIndex(byName.map((h) => ({ id: h.id, name: h.name, aliases: h.aliases, extra: [h.slug, h.role] }))),
    [byName],
  );
  const shown = useMemo(() => {
    const ids = query.trim() ? index.search(query) : null;
    const byId = new Map(byName.map((h) => [h.id, h]));
    const list = ids ? ids.map((id) => byId.get(id)).filter((h): h is RosterHero => h !== undefined) : byName;
    return role ? list.filter((h) => h.role === role || h.roleAlt === role) : list;
  }, [query, role, index, byName]);
  const active = Math.min(focus, Math.max(0, shown.length - 1));

  function choose(h: RosterHero) {
    if (disabled) return;
    const s = status(h.id);
    if (s && !s.ok) {
      setMessage(s.why);
      return;
    }
    setMessage('');
    onChoose(h.id);
  }

  function moveFocus(next: number) {
    const clamped = Math.max(0, Math.min(shown.length - 1, next));
    setFocus(clamped);
    const el = gridRef.current?.querySelectorAll<HTMLButtonElement>('button[data-hero]')[clamped];
    el?.focus();
  }

  function onGridKey(e: KeyboardEvent) {
    const cols = columnsOf(gridRef.current);
    const map: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols };
    if (e.key in map) {
      e.preventDefault();
      moveFocus(active + map[e.key]!);
    } else if (e.key === 'Home') {
      e.preventDefault();
      moveFocus(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      moveFocus(shown.length - 1);
    }
  }

  function onSearchKey(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const first = shown.find((h) => status(h.id)?.ok !== false);
      if (first) {
        choose(first);
        setQuery('');
      } else if (shown[0]) {
        choose(shown[0]);
      }
    } else if (e.key === 'ArrowDown' && shown.length > 0) {
      e.preventDefault();
      moveFocus(0);
    } else if (e.key === 'Escape' && query) {
      e.preventDefault();
      setQuery('');
    }
  }

  const searchId = `${idPrefix}-search`;
  const msgId = `${idPrefix}-msg`;
  return (
    <section class="hp" aria-labelledby={`${idPrefix}-title`}>
      <div class="hp__head">
        <h2 class="hp__title" id={`${idPrefix}-title`}>
          {heading}
        </h2>
        {actions ? <div class="hp__actions">{actions}</div> : null}
      </div>
      <div class="hp__tools">
        <div class="hp__field">
          <label class="visually-hidden" for={searchId}>
            Find a hero by name or nickname
          </label>
          <svg class="hp__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="11" cy="11" r="6.5" />
            <path d="m16 16 4.5 4.5" />
          </svg>
          <input
            id={searchId}
            class="hp__input"
            type="search"
            placeholder="Find a hero (name or nickname)"
            autocomplete="off"
            spellcheck={false}
            enterKeyHint="go"
            value={query}
            onInput={(e) => {
              setQuery((e.target as HTMLInputElement).value);
              setFocus(0);
            }}
            onKeyDown={onSearchKey}
            aria-describedby={`${idPrefix}-hint`}
          />
        </div>
        <p class="hp__hint" id={`${idPrefix}-hint`}>
          <kbd>Enter</kbd> chooses the first available match. Arrow keys move between heroes.
        </p>
        <div class="hp__roles" role="group" aria-label="Filter by role">
          <button type="button" class="chip" aria-pressed={role === null} onClick={() => setRole(null)}>
            All
          </button>
          {ROLES.map((r) => (
            <button type="button" class="chip" key={r} aria-pressed={role === r} onClick={() => setRole(role === r ? null : r)}>
              {ROLE_SHORT[r]}
            </button>
          ))}
        </div>
      </div>
      <p class="hp__msg" id={msgId} role="status" aria-live="polite">
        {message}
      </p>
      {shown.length === 0 ? (
        <p class="hp__empty">No hero matches “{query}”{role ? ` in ${ROLE_SHORT[role]}` : ''}.</p>
      ) : (
        <ul class="hp__grid" ref={gridRef} onKeyDown={onGridKey} aria-label="Heroes">
          {shown.map((h, i) => {
            const s = status(h.id);
            const off = disabled || (s !== undefined && !s.ok);
            const tags = badges?.(h.id) ?? [];
            const name = off ? `${h.name}, ${s?.label || 'unavailable'}` : `${verb} ${h.name}`;
            return (
              <li key={h.id}>
                <button
                  type="button"
                  class="hp__tile"
                  data-hero={h.id}
                  aria-disabled={off ? 'true' : undefined}
                  aria-label={`${name}, ${roleText(h)}${tags.length ? `, ${tags.join(', ')}` : ''}`}
                  tabIndex={i === active ? 0 : -1}
                  onClick={() => {
                    setFocus(i);
                    choose(h);
                  }}
                  onFocus={() => setFocus(i)}
                >
                  <span class="hp__portrait">
                    <img src={portraitUrl(h)} alt="" width="56" height="56" loading="lazy" decoding="async" />
                    {tags.length > 0 ? (
                      <span class="hp__badges" aria-hidden="true">
                        {tags.map((t) => (
                          <span class={`hp__badge hp__badge--${t.toLowerCase()}`} key={t}>
                            {t === 'Favourite' ? '★' : t}
                          </span>
                        ))}
                      </span>
                    ) : null}
                  </span>
                  <span class="hp__name">{h.name}</span>
                  <span class="hp__sub" aria-hidden="true">
                    {off && s?.label ? s.label : roleText(h)}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
