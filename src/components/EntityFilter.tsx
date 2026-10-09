import { useEffect, useRef, useState } from 'preact/hooks';
import { createSearchIndex, type SearchIndex } from '../core/search.ts';
import type { ResolvedFacet } from './types.ts';

interface Props {
  /** id of the server-rendered EntityGrid list whose tiles this island shows/hides. */
  gridId: string;
  /** id of the search input; the header's search link targets '#search' by default. */
  inputId?: string;
  label?: string;
  placeholder?: string;
  facets?: ResolvedFacet[];
  total: number;
  /** Singular and plural noun for the result count. */
  noun?: readonly [string, string];
  /** Mirror the query and facet picks into the query string so filtered views can be shared. */
  syncUrl?: boolean;
}

type Picks = Readonly<Record<string, readonly string[]>>;

function hasPicks(picks: Picks): boolean {
  return Object.values(picks).some((v) => v.length > 0);
}

interface Grid {
  tiles: HTMLElement[];
  index: SearchIndex;
}

/** Read the server-rendered tiles once and index them with the alias-aware core search. */
function readGrid(grid: HTMLElement): Grid {
  const tiles = [...grid.querySelectorAll<HTMLElement>('[data-entity]')];
  const index = createSearchIndex(
    tiles.map((t) => ({
      id: t.dataset.entity ?? '',
      name: t.dataset.name ?? '',
      aliases: (t.dataset.aliases ?? '').split('|').filter(Boolean),
      ...(t.dataset.extra ? { extra: t.dataset.extra } : {}),
    })),
  );
  return { tiles, index };
}

/** Ids matching the query, or null for "no text filter". Loose subsequence hits only count when nothing better matches. */
function matchingIds(index: SearchIndex, query: string): Set<string> | null {
  if (query.trim() === '') return null;
  const hits = index.hits(query);
  const strong = hits.filter((h) => h.tier !== 'subsequence');
  return new Set((strong.length > 0 ? strong : hits).map((h) => h.id));
}

/**
 * Island: filters an EntityGrid in place. Tiles stay server-rendered (and fully usable without
 * JS); this only toggles their `hidden` attribute. Text matching is the alias-aware core search
 * (src/core/search.ts) over each tile's data-name/data-aliases/data-extra; facets read the
 * data-f-<facet> values, OR within a facet and AND across facets.
 */
export default function EntityFilter({
  gridId,
  inputId = 'search',
  label = 'Search',
  placeholder = 'Search by name or nickname',
  facets = [],
  total,
  noun = ['result', 'results'],
  syncUrl = true,
}: Props) {
  const [query, setQuery] = useState('');
  const [picks, setPicks] = useState<Picks>({});
  const [shown, setShown] = useState(total);
  const inputRef = useRef<HTMLInputElement>(null);
  const restored = useRef(false);
  const gridRef = useRef<Grid | null>(null);

  // Restore from the URL, or keep whatever was typed before hydration finished.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const typed = inputRef.current?.value ?? '';
    const fromUrl = syncUrl ? params.get('q') : null;
    const initial: Record<string, string[]> = {};
    if (syncUrl) {
      for (const facet of facets) {
        const raw = params.get(facet.id);
        if (!raw) continue;
        const valid = raw.split(',').filter((v) => facet.options.some((o) => o.value === v));
        if (valid.length) initial[facet.id] = valid;
      }
    }
    setQuery(typed || fromUrl || '');
    setPicks(initial);
    restored.current = true;
    // Island props never change after hydration, so this runs once.
  }, []);

  useEffect(() => {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    gridRef.current ??= readGrid(grid);
    const { tiles, index } = gridRef.current;
    const ids = matchingIds(index, query);
    let count = 0;
    for (const tile of tiles) {
      const okQuery = ids === null || ids.has(tile.dataset.entity ?? '');
      const okFacets = Object.entries(picks).every(([id, wanted]) => {
        if (wanted.length === 0) return true;
        const have = (tile.getAttribute(`data-f-${id}`) ?? '').split('|');
        return wanted.some((v) => have.includes(v));
      });
      const visible = okQuery && okFacets;
      tile.hidden = !visible;
      if (visible) count++;
    }
    setShown(count);
    grid.toggleAttribute('data-filtered', query.trim() !== '' || hasPicks(picks));

    if (syncUrl && restored.current) {
      const url = new URL(window.location.href);
      if (query.trim()) url.searchParams.set('q', query.trim());
      else url.searchParams.delete('q');
      for (const facet of facets) {
        const values = picks[facet.id] ?? [];
        if (values.length) url.searchParams.set(facet.id, values.join(','));
        else url.searchParams.delete(facet.id);
      }
      // Keep facet lists readable in the address bar (?role=Tank,Healer rather than %2C).
      url.search = url.search.replace(/%2C/gi, ',');
      if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
    }
  }, [query, picks, gridId, facets, syncUrl]);

  // "/" focuses search, as on most catalogue sites; ignored while typing elsewhere.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
      e.preventDefault();
      inputRef.current?.focus();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  function toggle(facetId: string, value: string) {
    setPicks((prev) => {
      const current = prev[facetId] ?? [];
      const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
      return { ...prev, [facetId]: next };
    });
  }

  function clearAll() {
    setQuery('');
    setPicks({});
    inputRef.current?.focus();
  }

  const active = query.trim() !== '' || hasPicks(picks);
  const plural = total === 1 ? noun[0] : noun[1];
  const status = shown === total ? `${total} ${plural}` : `Showing ${shown} of ${total} ${plural}`;

  return (
    <form class="efilter" role="search" aria-label={label} onSubmit={(e) => e.preventDefault()}>
      <div class="efilter__field">
        <label for={inputId} class="visually-hidden">
          {label}
        </label>
        <svg class="efilter__icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="11" cy="11" r="6.5" />
          <path d="M16 16l4.5 4.5" />
        </svg>
        <input
          ref={inputRef}
          id={inputId}
          class="efilter__input"
          type="search"
          value={query}
          placeholder={placeholder}
          autocomplete="off"
          spellcheck={false}
          enterKeyHint="search"
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && query) {
              e.preventDefault();
              setQuery('');
            }
          }}
        />
        <kbd class="efilter__kbd" aria-hidden="true">
          /
        </kbd>
      </div>

      {facets.map((facet) => (
        <fieldset class="efilter__facet" key={facet.id}>
          <legend class="kicker">{facet.label}</legend>
          <div class="cluster">
            {facet.options.map((option) => {
              const on = (picks[facet.id] ?? []).includes(option.value);
              return (
                <button
                  type="button"
                  class="chip"
                  aria-pressed={on}
                  key={option.value}
                  onClick={() => toggle(facet.id, option.value)}
                >
                  {option.label}
                  <span class="chip__count">
                    <span class="visually-hidden">, </span>
                    {option.count}
                  </span>
                </button>
              );
            })}
          </div>
        </fieldset>
      ))}

      <div class="efilter__status">
        <p role="status" aria-live="polite">
          {status}
        </p>
        {active ? (
          <button type="button" class="btn btn--ghost efilter__clear" onClick={clearAll}>
            Clear filters
          </button>
        ) : null}
      </div>
      {shown === 0 ? (
        <p class="efilter__empty">
          Nothing matches{query.trim() ? ` "${query.trim()}"` : ''}. Try a nickname, fewer letters, or clear the filters.
        </p>
      ) : null}
    </form>
  );
}
