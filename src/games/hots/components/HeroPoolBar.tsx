import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { normalize } from '../../../core/search.ts';
import { createStore } from '../../../core/storage.ts';
import './hots.css';
import { EMPTY_POOL, hasOwnedList, readPool, setFavorite, setOwned, subscribePool, withOwned, writePool, type HeroPool } from '../pool.ts';

export interface PoolHero {
  id: string;
  name: string;
  /** Portrait URL, or null when there is none. */
  portrait: string | null;
  role: string;
}

interface Props {
  /** id of the EntityGrid list whose tiles get dimmed / starred. */
  gridId: string;
  heroes: PoolHero[];
}

type Editing = 'owned' | 'favorites';

/** Separate preference: whether the grid dims heroes outside the owned list. */
const DIM_KEY = 'grid-dim';

/**
 * Island on the hero grid: the visitor's hero pool (owned heroes and favourites), stored in this
 * browser under the shared pool contract (./pool.ts) that the draft tool reads too. It edits the
 * pool in a dialog and marks grid tiles in place (data-unowned, data-favorite); filtering and
 * counting stay with EntityFilter, so the two never disagree.
 */
export default function HeroPoolBar({ gridId, heroes }: Props) {
  const [pool, setPool] = useState<HeroPool>({ ...EMPTY_POOL, owned: [], favorites: [] });
  const [dim, setDim] = useState(false);
  const [ready, setReady] = useState(false);
  const [editing, setEditing] = useState<Editing>('owned');
  const [filter, setFilter] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const store = useMemo(() => createStore('hots'), []);

  useEffect(() => {
    setPool(readPool(store));
    setDim(store.get<boolean>(DIM_KEY, false, (v) => (typeof v === 'boolean' ? v : undefined)));
    setReady(true);
    return subscribePool((next) => setPool(next), store);
  }, [store]);

  // Reflect the pool on the server-rendered tiles.
  useEffect(() => {
    const grid = document.getElementById(gridId);
    if (!grid) return;
    const owned = new Set(pool.owned);
    const favorites = new Set(pool.favorites);
    const dimming = dim && hasOwnedList(pool);
    for (const tile of grid.querySelectorAll<HTMLElement>('[data-entity]')) {
      const id = tile.dataset.entity ?? '';
      tile.toggleAttribute('data-unowned', dimming && !owned.has(id));
      tile.toggleAttribute('data-favorite', favorites.has(id));
    }
  }, [pool, dim, gridId]);

  function save(next: HeroPool) {
    setPool(next);
    writePool(next, store);
  }

  function toggleDim() {
    const next = !dim;
    setDim(next);
    store.set(DIM_KEY, next);
  }

  function toggle(id: string) {
    if (editing === 'owned') save(setOwned(pool, id, !pool.owned.includes(id)));
    else save(setFavorite(pool, id, !pool.favorites.includes(id)));
  }

  const q = normalize(filter);
  const listed = q ? heroes.filter((h) => normalize(h.name).includes(q) || normalize(h.role).includes(q)) : heroes;
  const ownedCount = heroes.filter((h) => pool.owned.includes(h.id)).length;
  const favoriteCount = heroes.filter((h) => pool.favorites.includes(h.id)).length;
  const setUp = hasOwnedList(pool);

  let status = 'Mark the heroes you own to dim the rest of the grid.';
  if (!ready) status = 'Saved in this browser only.';
  else if (setUp) status = `You own ${ownedCount} of ${heroes.length}${favoriteCount ? ` · ${favoriteCount} favourite${favoriteCount === 1 ? '' : 's'}` : ''}.`;
  else if (favoriteCount) status = `${favoriteCount} favourite${favoriteCount === 1 ? '' : 's'}. Mark the heroes you own to dim the rest.`;

  return (
    <div class="hx-pool" role="group" aria-label="My heroes" data-pool-bar>
      <span class="hx-pool__label">My heroes</span>
      <span class="hx-pool__status" role="status" aria-live="polite">
        {status}
      </span>
      <span class="hx-pool__spacer" />
      {setUp ? (
        <button type="button" class="chip" aria-pressed={dim} onClick={toggleDim} data-pool-dim>
          Dim heroes I don't own
        </button>
      ) : null}
      <button
        type="button"
        class="btn btn--ghost"
        onClick={() => {
          setFilter('');
          dialog.current?.showModal();
        }}
        data-pool-edit
      >
        Edit my heroes
      </button>

      <dialog ref={dialog} class="hx-pool-dialog" aria-labelledby="pool-dialog-title" data-pool-dialog>
        <div class="hx-pool-dialog__inner">
          <div class="hx-pool-dialog__head">
            <div>
              <h2 id="pool-dialog-title">My heroes</h2>
              <p class="hx-pool__status">Stored in this browser only; the draft tool uses the same list.</p>
            </div>
            <button type="button" class="btn btn--ghost btn--icon" onClick={() => dialog.current?.close()}>
              <span class="visually-hidden">Close</span>
              <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6 6l12 12M18 6 6 18" />
              </svg>
            </button>
          </div>

          <div class="hx-pool-dialog__tools">
            <div class="cluster" role="group" aria-label="What to mark">
              <button type="button" class="chip" aria-pressed={editing === 'owned'} onClick={() => setEditing('owned')}>
                Owned <span class="chip__count">{ownedCount}</span>
              </button>
              <button type="button" class="chip" aria-pressed={editing === 'favorites'} onClick={() => setEditing('favorites')}>
                Favourites <span class="chip__count">{favoriteCount}</span>
              </button>
            </div>
            <label class="visually-hidden" for="pool-filter">
              Filter heroes
            </label>
            <input
              id="pool-filter"
              class="hx-pool-dialog__search"
              type="search"
              placeholder="Filter by name or role"
              autocomplete="off"
              value={filter}
              onInput={(e) => setFilter(e.currentTarget.value)}
            />
          </div>

          <ul class="hx-pool-dialog__list" aria-label={editing === 'owned' ? 'Mark owned heroes' : 'Mark favourite heroes'}>
            {listed.map((h) => {
              const on = editing === 'owned' ? pool.owned.includes(h.id) : pool.favorites.includes(h.id);
              return (
                <li key={h.id}>
                  <button type="button" class="hx-pool-pick" aria-pressed={on} onClick={() => toggle(h.id)} data-pool-pick={h.id}>
                    {h.portrait ? (
                      <img src={h.portrait} alt="" width={32} height={32} loading="lazy" />
                    ) : (
                      <span class="hx-hero__img hx-hero__img--blank" aria-hidden="true">
                        {h.name.slice(0, 1)}
                      </span>
                    )}
                    <span>{h.name}</span>
                    <span class="hx-pool-pick__mark" aria-hidden="true">
                      {on ? (editing === 'owned' ? '✓' : '★') : ''}
                    </span>
                  </button>
                </li>
              );
            })}
            {listed.length === 0 ? <li class="hx-pool__status">No hero matches "{filter}".</li> : null}
          </ul>

          <div class="hx-pool-dialog__foot">
            {editing === 'owned' ? (
              <div class="cluster">
                <button type="button" class="btn btn--ghost" onClick={() => save(withOwned(pool, heroes.map((h) => h.id)))}>
                  Mark all
                </button>
                <button type="button" class="btn btn--ghost" onClick={() => save(withOwned(pool, []))}>
                  Clear
                </button>
              </div>
            ) : (
              <span>Favourites get a star on the grid.</span>
            )}
            <button type="button" class="btn btn--primary" onClick={() => dialog.current?.close()}>
              Done
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
