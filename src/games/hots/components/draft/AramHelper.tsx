import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import ShareButton from '../../../../components/ShareButton.tsx';
import { onHashChange, readHash, writeHash } from '../../../../core/urlstate.ts';
import { ARAM_TEAM_SIZE, ARAM_WEIGHTS, rankAram } from '../../draft/aram.ts';
import { EMPTY_POOL, mentions, readPool, watchPool, type HeroPool } from '../../draft/pool.ts';
import { ARAM_ALLIES, ARAM_ENEMIES, ARAM_OPTIONS, createAramCodec } from '../../draft/state.ts';
import HeroPicker, { type TileStatus } from './HeroPicker.tsx';
import SuggestionList from './SuggestionList.tsx';
import { joinNames, portraitUrl, roleText, useShard, type CreditProp, type MapOption, type RosterHero } from './props.ts';
import './draft.css';

interface Props {
  shardUrl: string;
  /** Draftable entities in universe order (release date, id). */
  roster: RosterHero[];
  /** ARAM maps only. */
  maps: MapOption[];
  credit: CreditProp;
}

type ListId = 'options' | 'allies' | 'enemies';

const LISTS: readonly { id: ListId; label: string; short: string; max: number }[] = [
  { id: 'options', label: 'Your three options', short: 'Options', max: ARAM_OPTIONS },
  { id: 'allies', label: 'Your teammates', short: 'Teammates', max: ARAM_ALLIES },
  { id: 'enemies', label: 'Enemy team', short: 'Enemies', max: ARAM_ENEMIES },
];

type Lists = Record<ListId, string[]>;
const EMPTY: Lists = { options: [], allies: [], enemies: [] };

/**
 * Island: ARAM "pick 1 of 3" helper. Enter the offered heroes (plus any teammates and enemies
 * you can see) and get them ranked for your team with reasons: role needs, theory or ARAM
 * statistics against the enemies and with your teammates.
 */
export default function AramHelper({ shardUrl, roster, maps, credit }: Props) {
  const { shard, retry } = useShard(shardUrl);
  const data = shard.status === 'ready' ? shard.data : null;
  const codec = useMemo(() => createAramCodec(roster.map((h) => h.id)), [roster]);
  const byId = useMemo(() => new Map(roster.map((h) => [h.id, h])), [roster]);

  const [lists, setLists] = useState<Lists>(EMPTY);
  const [map, setMap] = useState('');
  const [target, setTarget] = useState<ListId>('options');
  const [pool, setPool] = useState<HeroPool>(EMPTY_POOL);
  const [announce, setAnnounce] = useState('');
  const [ready, setReady] = useState(false);
  const lastHash = useRef('');

  const slots = (ids: readonly string[]) => ids.reduce((n, id) => n + (byId.get(id)?.slots ?? 1), 0);
  const capacity: Record<ListId, number> = { options: ARAM_OPTIONS, allies: ARAM_ALLIES, enemies: ARAM_ENEMIES };
  const used = (id: ListId, l: Lists = lists) => (id === 'options' ? l.options.length : slots(l[id]));

  function restore(hash: string) {
    const s = codec.decode(hash);
    const clean = (ids: (string | null)[]) => [...new Set(ids.filter((x): x is string => x !== null && byId.has(x)))];
    const next: Lists = { options: clean(s.options).slice(0, ARAM_OPTIONS), allies: clean(s.allies), enemies: clean(s.enemies) };
    next.allies = next.allies.filter((id) => !next.options.includes(id));
    setLists(next);
    setMap(maps.some((m) => m.id === s.map) ? s.map : '');
    lastHash.current = hash;
  }

  useEffect(() => {
    restore(readHash());
    setReady(true);
    setPool(readPool());
    const offHash = onHashChange((h) => {
      if (h !== lastHash.current) restore(h);
    });
    const offPool = watchPool(setPool);
    return () => {
      offHash();
      offPool();
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    const encoded = codec.encode({ map, options: lists.options, allies: lists.allies, enemies: lists.enemies });
    const hash = encoded === '#v=1' ? '' : encoded;
    if (hash === lastHash.current) return;
    lastHash.current = hash;
    writeHash(hash);
  }, [ready, codec, lists, map]);

  const favorites = useMemo(() => new Set(pool.favorites), [pool]);
  const ranking = useMemo(
    () => (data ? rankAram(data, { ...lists, map }, { favorites }) : null),
    [data, lists, map, favorites],
  );

  function add(id: string) {
    const hero = byId.get(id);
    if (!hero) return;
    const next: Lists = { ...lists, [target]: [...lists[target], id] };
    setLists(next);
    const left = capacity[target] - used(target, next);
    let nextTarget = target;
    if (left <= 0) nextTarget = LISTS.find((l) => capacity[l.id] - used(l.id, next) > 0)?.id ?? target;
    setTarget(nextTarget);
    const label = LISTS.find((l) => l.id === target)!.label.toLowerCase();
    setAnnounce(`${hero.name} added to ${label}.`);
  }

  function remove(list: ListId, id: string) {
    setLists({ ...lists, [list]: lists[list].filter((x) => x !== id) });
    setAnnounce(`Removed ${byId.get(id)?.name ?? id}.`);
  }

  function status(id: string): TileStatus | undefined {
    const hero = byId.get(id);
    if (!hero) return undefined;
    const label = LISTS.find((l) => l.id === target)!.label.toLowerCase();
    if (lists[target].includes(id)) return { ok: false, label: 'Already added', why: `${hero.name} is already in ${label}.` };
    if (target !== 'enemies') {
      const other = target === 'options' ? 'allies' : 'options';
      if (lists[other].includes(id)) {
        return { ok: false, label: other === 'allies' ? 'Teammate' : 'Your option', why: `${hero.name} is already ${other === 'allies' ? 'on your team' : 'one of your options'}.` };
      }
    }
    const left = capacity[target] - used(target);
    const need = target === 'options' ? 1 : hero.slots;
    if (need > left) {
      return {
        ok: false,
        label: left <= 0 ? 'List full' : 'Needs 2 slots',
        why: left <= 0 ? `${LISTS.find((l) => l.id === target)!.label} is full. Remove a hero or switch lists.` : `${hero.name} needs two free slots.`,
      };
    }
    return undefined;
  }

  const teamSlots = slots(lists.allies);
  const intro =
    lists.options.length === 0
      ? 'Add the three heroes you were offered to see them ranked for your team.'
      : `Ranking ${joinNames(lists.options.map((id) => byId.get(id)?.name ?? id))} for a team of ${teamSlots === 0 ? 'unknown teammates' : `${teamSlots} known teammate${teamSlots === 1 ? '' : 's'}`}${lists.enemies.length ? ` against ${lists.enemies.length} known enem${lists.enemies.length === 1 ? 'y' : 'ies'}` : ''}.`;

  return (
    <div class="dt ar" data-ready={data ? 'true' : 'false'}>
      <div class="dt-bar card">
        <div class="dt-field dt-field--wide">
          <label class="dt-field__label" for="ar-map">
            Map (optional)
          </label>
          <select id="ar-map" class="dt-select" value={map} onChange={(e) => setMap((e.target as HTMLSelectElement).value)}>
            <option value="">Any ARAM map</option>
            {maps.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </div>
        <div class="dt-bar__actions">
          <button
            type="button"
            class="btn"
            disabled={lists.options.length + lists.allies.length + lists.enemies.length === 0}
            onClick={() => {
              setLists(EMPTY);
              setTarget('options');
              setAnnounce('Cleared.');
            }}
          >
            Clear
          </button>
          <ShareButton title="Whetstone ARAM pick" label="Share" />
        </div>
      </div>
      <p class="visually-hidden" role="status" aria-live="polite">
        {announce}
      </p>

      <div class="dt-layout ar-layout">
        <section class="dt-now ar-now" aria-labelledby="ar-result-title">
          <div class="dt-step">
            <p class="kicker dt-step__count">ARAM</p>
            <h2 class="dt-step__title" id="ar-result-title">
              Which option to take
            </h2>
            <p class="dt-step__hint">{intro}</p>
          </div>
          {shard.status === 'loading' ? (
            <p class="dt-loading" role="status">
              Loading hero data…
            </p>
          ) : shard.status === 'error' ? (
            <div class="dt-error" role="alert">
              <p>Rankings could not load ({shard.message}).</p>
              <button type="button" class="btn" onClick={retry}>
                Try again
              </button>
            </div>
          ) : ranking ? (
            <>
              {ranking.issues.length > 0 ? (
                <ul class="dt-note ar-issues">
                  {ranking.issues.map((i) => (
                    <li key={i.id}>{i.text}</li>
                  ))}
                </ul>
              ) : null}
              <SuggestionList
                idPrefix="ar-sg"
                suggestions={ranking.ranked}
                weights={ARAM_WEIGHTS}
                credit={ranking.usesStats ? credit : null}
                statsLabel={ranking.usesStats && data?.stats ? data.stats.label : null}
                limit={ARAM_OPTIONS}
                {...(ranking.ranked.length > 1 ? { topLabel: 'Best pick' } : {})}
                empty="No options yet."
              />
            </>
          ) : null}
        </section>

        <section class="ar-inputs" aria-label="Heroes in this game">
          <div class="seg seg--wrap dt-targets" role="group" aria-label="Add heroes to">
            {LISTS.map((l) => (
              <button type="button" key={l.id} class="seg__btn" aria-pressed={target === l.id} onClick={() => setTarget(l.id)}>
                {l.short} <span class="seg__count">{used(l.id)}/{capacity[l.id]}</span>
              </button>
            ))}
          </div>
          {LISTS.map((l) => (
            <div class={`ar-list ar-list--${l.id}${target === l.id ? ' is-target' : ''}`} key={l.id}>
              <h3 class="ar-list__title">{l.label}</h3>
              <ol class="ar-list__slots">
                {lists[l.id].map((id) => {
                  const h = byId.get(id);
                  if (!h) return null;
                  return (
                    <li key={id}>
                      <button type="button" class="ar-chip" onClick={() => remove(l.id, id)} aria-label={`Remove ${h.name} from ${l.label.toLowerCase()}`}>
                        <img src={portraitUrl(h)} alt="" width="32" height="32" loading="lazy" decoding="async" />
                        <span class="ar-chip__name">{h.name}</span>
                        <span class="ar-chip__role">{roleText(h)}</span>
                        <span class="ar-chip__x" aria-hidden="true">
                          ×
                        </span>
                      </button>
                    </li>
                  );
                })}
                {used(l.id) < capacity[l.id] ? (
                  <li>
                    <button type="button" class="ar-chip ar-chip--empty" aria-pressed={target === l.id} onClick={() => setTarget(l.id)}>
                      {target === l.id ? 'Adding here: choose below' : `Add to ${l.short.toLowerCase()}`}
                    </button>
                  </li>
                ) : null}
              </ol>
            </div>
          ))}
          <p class="ar-note">
            Teams have {ARAM_TEAM_SIZE} players. Mirror matches happen in ARAM, so an enemy can hold one of your options. {pool.favorites.length > 0 ? 'Favourites get a small bonus.' : ''}
          </p>
        </section>

        <div class="dt-picker">
          <HeroPicker
            heroes={roster}
            status={status}
            onChoose={add}
            idPrefix="ar-pick"
            heading={`Add to · ${LISTS.find((l) => l.id === target)!.label}`}
            verb="Add"
            badges={(id) => {
              const h = byId.get(id);
              return h && mentions(favorites, h) ? ['Favourite'] : [];
            }}
          />
        </div>
      </div>
    </div>
  );
}
