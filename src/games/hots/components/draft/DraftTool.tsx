import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import ShareButton from '../../../../components/ShareButton.tsx';
import {
  applyFree,
  checkFree,
  chooseSequential,
  currentStep,
  freeContext,
  freeTeam,
  legalCandidates,
  remainingSteps,
  removeFree,
  sequentialContext,
  startFree,
  startSequential,
  undoFree,
  undoSequential,
  type DraftAction,
  type DraftContext,
  type FreeState,
  type Illegal,
  type PresetId,
  type SequentialState,
  type Team,
} from '../../../../core/draft.ts';
import { createStore } from '../../../../core/storage.ts';
import { onHashChange, readHash, writeHash } from '../../../../core/urlstate.ts';
import type { DraftHero } from '../../draft/data.ts';
import { EMPTY_POOL, SUGGEST_FROM_LABEL, allowedFor, mentions, readPool, watchPool, type HeroPool, type SuggestFrom } from '../../draft/pool.ts';
import { teamSummary, type RoleHero, type TeamSummary } from '../../draft/roles.ts';
import {
  FREE_MAX_BANS,
  FREE_TEAM_SIZE,
  OUR_TEAM,
  availabilityInFree,
  availabilityInSequential,
  entityRules,
  freeConfig,
  slConfig,
  stepTitle,
  type FirstPick,
} from '../../draft/rules.ts';
import { createDraftCodec, freeHash, restoreFree, restoreSequential, slHash, type DraftMode } from '../../draft/state.ts';
import { banWeights, pickWeights, presetInfo, suggest, type Suggestion } from '../../draft/suggest.ts';
import HeroPicker, { type TileStatus } from './HeroPicker.tsx';
import SuggestionList from './SuggestionList.tsx';
import TeamPanel, { type BoardSlot } from './TeamPanel.tsx';
import { NARROW_QUERY, useMediaQuery, useShard, type CreditProp, type MapOption, type RosterHero } from './props.ts';
import './draft.css';

interface Props {
  /** Staged draft shard (stagedUrl('hots', 'draft')). */
  shardUrl: string;
  /** Draftable entities in universe order (release date, id): the hash index order. */
  roster: RosterHero[];
  /** Standard maps, Storm League pool first (ARAM and brawls excluded). */
  maps: MapOption[];
  /** Entity ids in this week's free rotation. */
  free: string[];
  /** "Free this week (8–15 Oct)", or null without rotation data. */
  freeLabel: string | null;
  /** Heroes Profile credit, shown inline whenever its numbers are in the suggestions. */
  credit: CreditProp;
  /** Where visitors mark owned heroes and favourites (the hero grid). */
  poolHref: string;
}

interface Target {
  team: Team;
  action: DraftAction;
}

const TARGETS: readonly Target[] = [
  { team: 'A', action: 'pick' },
  { team: 'B', action: 'pick' },
  { team: 'A', action: 'ban' },
  { team: 'B', action: 'ban' },
];
const TARGET_LABEL = (t: Target) => (t.team === OUR_TEAM ? (t.action === 'pick' ? 'Your picks' : 'Your bans') : t.action === 'pick' ? 'Enemy picks' : 'Enemy bans');

const PRESET_STORE = 'draftSort';
const FROM_STORE = 'draftFrom';
const EMPTY_TAGS: ReadonlySet<string> = new Set();

function illegalText(e: Illegal): string {
  switch (e.reason) {
    case 'taken':
      return 'a hero that was already picked or banned';
    case 'step':
    case 'slots':
      return "Cho'gall at a step without two picks in a row";
    case 'skip':
      return 'an empty or unknown pick';
    case 'complete':
      return 'more steps than a draft has';
    default:
      return 'a move that is not allowed';
  }
}

function suggestionsTitle(t: Target): string {
  if (t.team === OUR_TEAM) return t.action === 'ban' ? 'Suggested bans' : 'Suggested picks';
  return t.action === 'ban' ? 'Likely enemy bans' : 'Likely enemy picks';
}

function stepHint(t: Target): string {
  if (t.team === OUR_TEAM) {
    return t.action === 'ban'
      ? 'Ban a hero that would hurt you most. Missed the ban? Skip it.'
      : 'Lock in your pick, or tap a suggestion. The list adapts to every hero on the board.';
  }
  return t.action === 'ban'
    ? 'Enter the enemy ban. The list shows what they would most want to remove.'
    : 'Enter the hero the enemy picked. The list shows what would suit them best.';
}

/**
 * Island: the Storm League draft board (true 16-step order, first-pick toggle, Cho'gall rules)
 * plus heroescounters-style free mode, with step-aware explained suggestions, role guardrails,
 * a personal pool filter and a shareable URL hash. Board, map list and picker render on the
 * server; suggestions appear once the draft shard has loaded.
 */
export default function DraftTool({ shardUrl, roster, maps, free, freeLabel, credit, poolHref }: Props) {
  const { shard, retry } = useShard(shardUrl);
  const data = shard.status === 'ready' ? shard.data : null;
  const narrow = useMediaQuery(NARROW_QUERY);

  const rules = useMemo(() => entityRules(roster), [roster]);
  const codec = useMemo(() => createDraftCodec(roster.map((h) => h.id)), [roster]);
  const byId = useMemo(() => new Map(roster.map((h) => [h.id, h])), [roster]);
  const freeIds = useMemo(() => new Set(free), [free]);
  const store = useMemo(() => createStore('hots'), []);

  const [mode, setMode] = useState<DraftMode>('sl');
  const [map, setMap] = useState('');
  const [fp, setFp] = useState<FirstPick>('a');
  const [sl, setSl] = useState<SequentialState>(() => startSequential(slConfig('a', rules)));
  const [freeState, setFreeState] = useState<FreeState>(() => startFree(freeConfig(rules)));
  const [target, setTarget] = useState<Target>(TARGETS[0]!);
  const [preset, setPreset] = useState<PresetId>('composite');
  const [from, setFrom] = useState<SuggestFrom>('all');
  const [pool, setPool] = useState<HeroPool>(EMPTY_POOL);
  const [notice, setNotice] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  /** False until the link has been read, so the empty initial draft never overwrites it. */
  const [ready, setReady] = useState(false);
  const lastHash = useRef<string>('');
  const nowTitle = useRef<HTMLHeadingElement>(null);

  const name = (id: string | null) => (id === null ? 'No ban' : (byId.get(id)?.name ?? id));

  function restore(hash: string) {
    const info = codec.decodeWithInfo(hash);
    const s = info.state;
    const problems: string[] = [];
    const mapOk = s.map === '' || maps.some((m) => m.id === s.map);
    if (!mapOk) problems.push('The map in this link is not one you can draft on, so no map is selected.');
    if (info.issues.some((i) => i.includes('unknown index'))) problems.push('The link mentions a hero this version of the site does not know.');
    setMap(mapOk ? s.map : '');
    setMode(s.mode);
    setFp(s.firstPick);
    if (s.mode === 'sl') {
      const r = restoreSequential(slConfig(s.firstPick, rules), s.steps);
      setSl(r.state);
      setFreeState(startFree(freeConfig(rules)));
      if (r.error) problems.push(`Restored ${r.applied} of ${r.requested} steps: the next one is ${illegalText(r.error)}.`);
    } else {
      const r = restoreFree(freeConfig(rules), s);
      setFreeState(r.state);
      setSl(startSequential(slConfig(s.firstPick, rules)));
      if (r.error) problems.push(`Left out ${r.requested - r.applied} hero${r.requested - r.applied === 1 ? '' : 'es'} from the link: ${illegalText(r.error)}.`);
    }
    setNotice(problems.length ? problems.join(' ') : null);
    lastHash.current = hash;
  }

  // Restore from the link, the stored sort mode and the visitor's pool after hydration.
  useEffect(() => {
    restore(readHash());
    setReady(true);
    setPool(readPool());
    setPreset(store.get<PresetId>(PRESET_STORE, 'composite', (v) => (typeof v === 'string' && ['composite', 'winrate', 'counters', 'synergy', 'map', 'tier'].includes(v) ? (v as PresetId) : undefined)));
    setFrom(store.get<SuggestFrom>(FROM_STORE, 'all', (v) => (v === 'all' || v === 'pool' || v === 'free' ? v : undefined)));
    const offHash = onHashChange((h) => {
      if (h !== lastHash.current) restore(h);
    });
    const offPool = watchPool(setPool);
    return () => {
      offHash();
      offPool();
    };
    // Props never change after hydration: run once.
  }, []);

  // Mirror the draft into the URL hash (replace, not push: Back leaves the page).
  useEffect(() => {
    if (!ready) return;
    const encoded = codec.encode(mode === 'sl' ? slHash(map, fp, sl) : freeHash(map, freeState));
    const hash = encoded === `#v=1` ? '' : encoded;
    if (hash === lastHash.current) return;
    lastHash.current = hash;
    writeHash(hash);
  }, [ready, codec, mode, map, fp, sl, freeState]);

  // ---- derived state --------------------------------------------------------------------

  const step = mode === 'sl' ? currentStep(sl) : null;
  const turn: Target | null = mode === 'sl' ? (step ? { team: step.team, action: step.action } : null) : target;
  const extra = map ? { map } : {};
  const ctx: DraftContext | null = mode === 'sl' ? sequentialContext(sl, extra) : freeContext(freeState, target.team, target.action, extra);
  const taken = mode === 'sl' ? sl.taken : freeState.taken;

  const allowed = useMemo(() => allowedFor(from, roster, pool, freeIds), [from, roster, pool, freeIds]);
  const favorites = useMemo(() => new Set(pool.favorites), [pool]);
  const useStats = !!data?.stats && (data.stats.mode === 'sl' || data.stats.mode === 'qm');
  const presets = presetInfo({ stats: useStats, map });
  const activePreset = presets.find((p) => p.id === preset && p.enabled && p.visible) ? preset : 'composite';

  const { list, poolNote } = useMemo((): { list: Suggestion[]; poolNote: string | null } => {
    if (!data || !ctx || !turn) return { list: [], poolNote: null };
    const ids = roster.filter((h) => data.byId.has(h.id)).map((h) => h.id);
    const legal = mode === 'sl' ? legalCandidates(sl, ids) : ids.filter((id) => checkFree(freeState, { team: target.team, action: target.action, id }).ok);
    let candidates = legal;
    let note: string | null = null;
    if (allowed && turn.team === OUR_TEAM && turn.action === 'pick') {
      candidates = legal.filter((id) => allowed.has(id));
      if (candidates.length === 0 && legal.length > 0) {
        candidates = legal;
        note = 'None of the heroes you chose to suggest from is available here, so every hero is ranked.';
      }
    }
    const out = suggest({ data, ctx, candidates, preset: activePreset, favorites, ourPool: allowed, useStats });
    return { list: out, poolNote: note };
    // ctx is rebuilt each render from the listed state.
  }, [data, mode, sl, freeState, target, map, activePreset, allowed, favorites, useStats, roster]);

  const weights = turn?.action === 'ban' ? banWeights(activePreset) : pickWeights(activePreset);

  // ---- actions ---------------------------------------------------------------------------

  function after(text: string, fromSuggestion: boolean) {
    setAnnounce(text);
    setNotice(null);
    if (fromSuggestion) requestAnimationFrame(() => nowTitle.current?.focus());
  }

  function choose(id: string | null, fromSuggestion = false) {
    if (mode === 'sl') {
      const s = currentStep(sl);
      const r = chooseSequential(sl, id);
      if (!s || !r.ok) {
        setAnnounce(r.ok ? '' : r.message);
        return;
      }
      setSl(r.state);
      const next = currentStep(r.state);
      after(
        `${name(id)}: ${stepTitle(s.team, s.action)}, step ${s.index + 1}. ${next ? `Next: ${stepTitle(next.team, next.action)}, step ${next.index + 1}.` : 'Draft complete.'}`,
        fromSuggestion,
      );
      return;
    }
    if (id === null) return;
    const r = applyFree(freeState, { team: target.team, action: target.action, id });
    if (!r.ok) {
      setAnnounce(r.message);
      return;
    }
    setFreeState(r.state);
    // Move on when the current list is full.
    const full = (t: Target) => {
      const ft = freeTeam(r.state, t.team);
      return t.action === 'pick' ? ft.slotsUsed >= FREE_TEAM_SIZE : ft.bans.length >= FREE_MAX_BANS;
    };
    let nextTarget = target;
    if (full(target)) nextTarget = TARGETS.find((t) => !full(t)) ?? target;
    setTarget(nextTarget);
    after(`${name(id)} added to ${TARGET_LABEL(target).toLowerCase()}.${nextTarget !== target ? ` Now adding to ${TARGET_LABEL(nextTarget).toLowerCase()}.` : ''}`, fromSuggestion);
  }

  function undo() {
    if (mode === 'sl') {
      const last = sl.choices.at(-1);
      setSl(undoSequential(sl));
      setAnnounce(sl.choices.length ? `Undid ${name(last ?? null)}.` : '');
    } else {
      const last = freeState.moves.at(-1);
      setFreeState(undoFree(freeState));
      if (last) setAnnounce(`Removed ${name(last.id)}.`);
    }
    setNotice(null);
  }

  function reset() {
    if (mode === 'sl') setSl(startSequential(slConfig(fp, rules)));
    else {
      setFreeState(startFree(freeConfig(rules)));
      setTarget(TARGETS[0]!);
    }
    setNotice(null);
    setAnnounce('New draft started.');
  }

  function changeFirstPick(next: FirstPick) {
    if (next === fp) return;
    // Same heroes in the same order; only who made each choice flips.
    const r = restoreSequential(slConfig(next, rules), sl.choices);
    setSl(r.state);
    setFp(next);
    setAnnounce(next === 'a' ? 'You pick first.' : 'The enemy picks first.');
  }

  function changeMode(next: DraftMode) {
    if (next === mode) return;
    setMode(next);
    setNotice(null);
    setAnnounce(next === 'sl' ? 'Storm League order.' : 'Free mode: add heroes to either team in any order.');
  }

  function changePreset(id: PresetId) {
    setPreset(id);
    store.set(PRESET_STORE, id);
  }

  function changeFrom(v: SuggestFrom) {
    setFrom(v);
    store.set(FROM_STORE, v);
  }

  // ---- board -----------------------------------------------------------------------------

  const roleHero = (h: RosterHero): RoleHero => ({ ...h, tags: (data?.byId.get(h.id) as DraftHero | undefined)?.tags ?? EMPTY_TAGS });
  const available = roster.filter((h) => !taken.has(h.id)).map(roleHero);

  function slotsSl(team: Team): { bans: BoardSlot[]; picks: BoardSlot[] } {
    const bans: BoardSlot[] = [];
    const picks: BoardSlot[] = [];
    sl.config.steps.forEach((st, i) => {
      if (st.team !== team) return;
      const f = sl.filled.find((x) => x.step === i);
      const hero = f?.id ? (byId.get(f.id) ?? null) : null;
      let part: 1 | 2 | undefined;
      if (hero && hero.slots === 2 && f) part = sl.filled.find((x) => x.choice === f.choice)?.step === i ? 1 : 2;
      const slot: BoardSlot = { key: `s${i}`, kind: st.action, step: i, hero, current: i === sl.step && !sl.complete };
      if (part) slot.part = part;
      if (f && f.id === null) slot.skipped = true;
      (st.action === 'ban' ? bans : picks).push(slot);
    });
    return { bans, picks };
  }

  function slotsFree(team: Team): { bans: BoardSlot[]; picks: BoardSlot[] } {
    const t = freeTeam(freeState, team);
    const picks: BoardSlot[] = [];
    for (const id of t.picks) {
      const hero = byId.get(id) ?? null;
      const n = hero?.slots ?? 1;
      for (let p = 1; p <= n; p++) {
        const slot: BoardSlot = { key: `p${picks.length}`, kind: 'pick', hero, current: false };
        if (n === 2) slot.part = p as 1 | 2;
        picks.push(slot);
      }
    }
    while (picks.length < FREE_TEAM_SIZE) picks.push({ key: `p${picks.length}`, kind: 'pick', hero: null, current: false });
    const bans: BoardSlot[] = t.bans.map((id, i) => ({ key: `b${i}`, kind: 'ban', hero: byId.get(id) ?? null, current: false }));
    while (bans.length < FREE_MAX_BANS) bans.push({ key: `b${bans.length}`, kind: 'ban', hero: null, current: false });
    if (target.team === team) {
      const list = target.action === 'pick' ? picks : bans;
      const first = list.find((s) => !s.hero);
      if (first) first.current = true;
    }
    return { bans, picks };
  }

  function summaryFor(team: Team): TeamSummary {
    const ids = mode === 'sl' ? sl.filled.filter((f) => f.team === team && f.action === 'pick' && f.id !== null).map((f) => f.id!) : freeTeam(freeState, team).picks;
    const heroes = [...new Set(ids)].map((id) => byId.get(id)).filter((h): h is RosterHero => !!h).map(roleHero);
    const left = mode === 'sl' ? remainingSteps(sl, team, 'pick') : FREE_TEAM_SIZE - freeTeam(freeState, team).slotsUsed;
    return teamSummary(heroes, available, left);
  }

  // ---- picker status ---------------------------------------------------------------------

  function status(id: string): TileStatus | undefined {
    const hero = byId.get(id);
    if (!hero) return undefined;
    const a = mode === 'sl' ? availabilityInSequential(sl, hero) : availabilityInFree(freeState, hero, target.team, target.action);
    return a.ok ? undefined : a;
  }

  function badges(id: string): string[] {
    const h = byId.get(id);
    if (!h) return [];
    const out: string[] = [];
    if (mentions(favorites, h)) out.push('Favourite');
    if (mentions(freeIds, h)) out.push('Free');
    if (h.isNew) out.push('New');
    return out;
  }

  // ---- render ----------------------------------------------------------------------------

  const total = sl.config.steps.length;
  const panels = (['A', 'B'] as const).map((team) => {
    const slots = mode === 'sl' ? slotsSl(team) : slotsFree(team);
    return (
      <TeamPanel
        key={team}
        team={team}
        title={team === OUR_TEAM ? 'You' : 'Enemy'}
        firstPick={mode === 'sl' && (fp === 'a') === (team === 'A')}
        bans={slots.bans}
        picks={slots.picks}
        summary={summaryFor(team)}
        {...(mode === 'free'
          ? {
              onTarget: (kind: DraftAction) => setTarget({ team, action: kind }),
              onRemove: (hero: RosterHero) => {
                setFreeState(removeFree(freeState, hero.id));
                setAnnounce(`Removed ${hero.name}.`);
              },
            }
          : {})}
      />
    );
  });

  const verb = !turn ? 'Choose' : turn.action === 'ban' ? 'Ban' : mode === 'free' ? 'Add' : 'Pick';
  const pickerHeading =
    mode === 'sl'
      ? step
        ? `Choose · ${stepTitle(step.team, step.action)} (step ${step.index + 1})`
        : 'Draft complete'
      : `Add to · ${TARGET_LABEL(target)}`;
  const canUndo = mode === 'sl' ? sl.choices.length > 0 : freeState.moves.length > 0;
  const fromNote =
    from === 'pool' && pool.owned.length === 0
      ? 'No owned heroes saved yet, so your pool is your favourites plus the free rotation.'
      : from === 'free' && free.length === 0
        ? 'No free rotation data right now.'
        : null;

  return (
    <div class="dt" data-mode={mode} data-ready={data ? 'true' : 'false'}>
      <div class="dt-bar card">
        <div class="dt-field dt-field--wide">
          <span class="dt-field__label" id="dt-mode-label">
            Mode
          </span>
          <div class="dt-seg" role="group" aria-labelledby="dt-mode-label">
            <button type="button" class="dt-seg__btn" aria-pressed={mode === 'sl'} onClick={() => changeMode('sl')}>
              Storm League
            </button>
            <button type="button" class="dt-seg__btn" aria-pressed={mode === 'free'} onClick={() => changeMode('free')}>
              Free
            </button>
          </div>
        </div>
        <div class={mode === 'free' ? 'dt-field dt-field--wide' : 'dt-field'}>
          <label class="dt-field__label" for="dt-map">
            Map
          </label>
          <select id="dt-map" class="dt-select" value={map} onChange={(e) => setMap((e.target as HTMLSelectElement).value)}>
            <option value="">No map</option>
            {maps.some((m) => m.ranked) ? (
              <optgroup label="Storm League pool">
                {maps
                  .filter((m) => m.ranked)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </optgroup>
            ) : null}
            {maps.some((m) => !m.ranked) ? (
              <optgroup label="Other maps">
                {maps
                  .filter((m) => !m.ranked)
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
              </optgroup>
            ) : null}
          </select>
        </div>
        {mode === 'sl' ? (
          <div class="dt-field">
            <span class="dt-field__label" id="dt-fp-label">
              First pick
            </span>
            <div class="dt-seg" role="group" aria-labelledby="dt-fp-label">
              <button type="button" class="dt-seg__btn" aria-pressed={fp === 'a'} onClick={() => changeFirstPick('a')}>
                You
              </button>
              <button type="button" class="dt-seg__btn" aria-pressed={fp === 'b'} onClick={() => changeFirstPick('b')}>
                Enemy
              </button>
            </div>
          </div>
        ) : null}
        <div class="dt-field dt-field--wide">
          <label class="dt-field__label" for="dt-from">
            Suggest from
          </label>
          <select id="dt-from" class="dt-select" value={from} onChange={(e) => changeFrom((e.target as HTMLSelectElement).value as SuggestFrom)}>
            {(['all', 'pool', 'free'] as const).map((v) => (
              <option key={v} value={v}>
                {SUGGEST_FROM_LABEL[v]}
              </option>
            ))}
          </select>
        </div>
        <div class="dt-bar__actions">
          <button type="button" class="btn" onClick={undo} disabled={!canUndo}>
            <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
            </svg>
            Undo
          </button>
          <button type="button" class="btn" onClick={reset} disabled={!canUndo}>
            New draft
          </button>
          <ShareButton title="Whetstone draft" label="Share" />
        </div>
        {fromNote || (from !== 'all' && freeLabel) ? (
          <p class="dt-bar__note">
            {fromNote ? `${fromNote} ` : ''}
            {from !== 'all' && freeLabel ? `${freeLabel}. ` : ''}
            {from === 'pool' ? (
              <>
                Mark owned heroes and favourites on the <a href={poolHref}>Heroes page</a>.
              </>
            ) : null}
          </p>
        ) : null}
      </div>

      {notice ? (
        <div class="dt-notice" role="status">
          <p>{notice}</p>
          <button type="button" class="btn btn--ghost" onClick={() => setNotice(null)}>
            Dismiss
          </button>
        </div>
      ) : null}
      <p class="visually-hidden" role="status" aria-live="polite">
        {announce}
      </p>

      <div class="dt-layout">
        <section class="dt-now" aria-labelledby="dt-now-title">
          <div class="dt-step">
            <p class="kicker dt-step__count">{mode === 'sl' ? (step ? `Step ${step.index + 1} of ${total}` : `All ${total} steps done`) : 'Free mode'}</p>
            <h2 class="dt-step__title" id="dt-now-title" tabIndex={-1} ref={nowTitle}>
              {mode === 'sl' ? (step ? stepTitle(step.team, step.action) : 'Draft complete') : TARGET_LABEL(target)}
            </h2>
            {mode === 'sl' ? (
              <ol class="dt-progress" aria-hidden="true">
                {sl.config.steps.map((st, i) => (
                  <li key={i} class={`dt-progress__seg dt-progress__seg--${st.team.toLowerCase()} dt-progress__seg--${st.action}${i < sl.step ? ' is-done' : ''}${i === sl.step ? ' is-now' : ''}`} />
                ))}
              </ol>
            ) : (
              <div class="dt-seg dt-seg--wrap dt-targets" role="group" aria-label="Add heroes to">
                {TARGETS.map((t) => (
                  <button type="button" key={`${t.team}${t.action}`} class="dt-seg__btn" aria-pressed={t.team === target.team && t.action === target.action} onClick={() => setTarget(t)}>
                    {TARGET_LABEL(t)}
                  </button>
                ))}
              </div>
            )}
            {turn ? <p class="dt-step__hint">{stepHint(turn)}</p> : null}
            {mode === 'sl' && step?.action === 'ban' ? (
              <button type="button" class="btn btn--ghost dt-skip" onClick={() => choose(null, true)}>
                Skip this ban
              </button>
            ) : null}
          </div>

          {turn ? (
            <div class="dt-suggest">
              <h3 class="dt-suggest__title">{suggestionsTitle(turn)}</h3>
              {shard.status === 'loading' ? (
                <p class="dt-loading" role="status">
                  Loading hero data…
                </p>
              ) : shard.status === 'error' ? (
                <div class="dt-error" role="alert">
                  <p>Suggestions could not load ({shard.message}). The board still works.</p>
                  <button type="button" class="btn" onClick={retry}>
                    Try again
                  </button>
                </div>
              ) : (
                <SuggestionList
                  idPrefix="dt-sg"
                  suggestions={list}
                  weights={weights}
                  limit={narrow ? 3 : 6}
                  presets={presets}
                  preset={activePreset}
                  onPreset={changePreset}
                  action={turn.action === 'ban' ? 'Ban' : mode === 'free' ? 'Add' : 'Pick'}
                  actionLabel={(n) =>
                    turn.team === OUR_TEAM ? `${turn.action === 'ban' ? 'Ban' : 'Pick'} ${n}` : `Enter ${n} as the enemy's ${turn.action}`
                  }
                  onChoose={(id) => choose(id, true)}
                  credit={useStats ? credit : null}
                  statsLabel={useStats && data?.stats ? data.stats.label : null}
                  empty={poolNote ?? 'No legal heroes left for this step.'}
                />
              )}
              {poolNote ? <p class="dt-note">{poolNote}</p> : null}
            </div>
          ) : (
            <div class="dt-done">
              <p>Both teams are locked in. Share the link, undo a step to explore alternatives, or start a new draft.</p>
            </div>
          )}
        </section>

        <section class="dt-board" aria-label="Draft board">
          {panels}
        </section>

        <div class="dt-picker">
          <HeroPicker
            heroes={roster}
            status={status}
            onChoose={(id) => choose(id)}
            idPrefix="dt-pick"
            heading={pickerHeading}
            verb={verb}
            badges={badges}
          />
        </div>
      </div>
    </div>
  );
}
