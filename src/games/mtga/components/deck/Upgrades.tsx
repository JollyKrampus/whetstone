/**
 * Upgrade planner: grindstone's suggestUpgrades for one of its three deck versions (profiles),
 * with an optional wildcard budget, a cap on how much of the deck may change, locked cards and
 * the "prefer premium cards" preference. Swaps can be applied in full or picked one by one; the
 * analyzer keeps an undo stack.
 *
 * "Prefer premium" follows grindstone's preferences.json semantics: a remembered default (here in
 * this browser's storage) that leans toward mythics and rares when there is a choice and never
 * spends past the wildcard budget.
 */
import { useLayoutEffect, useState } from 'preact/hooks';
import { createStore } from '../../../../core/storage.ts';
import { analyzer } from '../../worker/client.ts';
import { PROFILE_CHANGE_PERCENT, type AnalyzeResult, type CardView, type ChangeCap, type MetaSelection, type Profile, type Rarity, type SuggestView, type WildcardCounts } from '../../worker/protocol.ts';
import { CardName } from '../CardPeek.tsx';
import { Busy, Notice, RARITIES, RARITY_LABEL, RarityTag, Section, plural, usd } from '../ui.tsx';

type Peek = (card: CardView) => void;

interface Props {
  result: AnalyzeResult;
  /** Meta lists used for the analysis (also steer card choice); null = heuristic only. */
  meta: MetaSelection | null;
  onApply: (text: string) => void;
  onPeek: Peek;
  busy: boolean;
}

/** grindstone's three deck versions (VERSION_LABELS), with what each one may change. */
const PROFILES: readonly { id: Profile; label: string; note: string }[] = [
  { id: 'faithful', label: 'Same deck, best cards', note: 'same jobs and card types, same or less mana' },
  { id: 'competitive', label: 'Most competitive', note: 'as strong as possible, lands included' },
  { id: 'casual', label: 'Friendly casual', note: 'no feel-bad cards, no rarer wildcards' },
];

/** "about 25% of the deck" or "no limit" for a change cap in percent. */
const capNote = (percent: number, suffix = '') => (percent >= 100 ? 'no limit' : `about ${percent}%${suffix}`);

/** The visitor's change caps; 'version' (the default) uses the chosen version's own cap. */
const CAPS: readonly { id: Exclude<ChangeCap, 'version'>; label: string; note: string }[] = [
  { id: 'light', label: 'Light', note: 'about 7% of the deck' },
  { id: 'normal', label: 'Normal', note: capNote(15) },
  { id: 'heavy', label: 'Heavy', note: capNote(30) },
  { id: 'any', label: 'Any', note: capNote(100) },
];

const store = createStore('mtga');
/** The visitor's default for "prefer premium" (grindstone keeps it in preferences.json). */
const PREMIUM_KEY = 'preferPremium';
const validBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);

const isLandType = (c: CardView | undefined) => /\bLand\b/.test((c?.typeLine ?? '').split(' // ')[0] ?? '');

export function Upgrades({ result, meta, onApply, onPeek, busy }: Props) {
  const [profile, setProfile] = useState<Profile>('faithful');
  const [intensity, setIntensity] = useState<ChangeCap>('version');
  const [premium, setPremium] = useState(false);
  const [limit, setLimit] = useState(false);
  const [budget, setBudget] = useState<WildcardCounts>({ common: 8, uncommon: 6, rare: 4, mythic: 1 });
  const [maxSwaps, setMaxSwaps] = useState(8);
  const [locked, setLocked] = useState<Set<string>>(() => new Set());
  const [view, setView] = useState<SuggestView | null>(null);
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useLayoutEffect(() => setPremium(store.get(PREMIUM_KEY, false, validBool)), []);

  const nonland = result.main.filter((e) => !isLandType(result.cards[e.oracleId]));
  const cards = { ...result.cards, ...(view?.cards ?? {}) };

  const suggest = async (e: Event) => {
    e.preventDefault();
    setWorking(true);
    setError(null);
    try {
      const v = await analyzer().request('suggest', {
        text: result.arenaText,
        format: result.format,
        profile,
        preferPremium: premium,
        intensity,
        wildcards: limit ? budget : null,
        keepCards: [...locked],
        maxSwaps,
        meta,
      });
      setView(v);
      // Required swaps (banned, off-Arena, feel-bad in the casual version) are always ticked; the
      // others only when meta lists steered them. Estimates are left for the visitor to choose.
      setPicked(new Set(v.swaps.flatMap((s, i) => (s.required || !v.estimateOnly ? [i] : []))));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const applyPicked = async () => {
    if (!view) return;
    if (picked.size === view.swaps.length) {
      onApply(view.appliedText);
      return;
    }
    const swaps = view.swaps.filter((_, i) => picked.has(i));
    if (swaps.length === 0) return;
    setWorking(true);
    try {
      const r = await analyzer().request('apply', { text: result.arenaText, swaps });
      onApply(r.text);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  };

  const toggleLock = (name: string) => {
    setLocked((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const cost = (w: Partial<WildcardCounts>) =>
    RARITIES.filter((r) => (w[r] ?? 0) > 0)
      .map((r) => `${w[r]} ${RARITY_LABEL[r].toLowerCase()}`)
      .join(', ') || 'free';

  /** Paper price of a swap's added copies, or null when the card data has no price. */
  const paper = (s: SuggestView['swaps'][number]): number | null => {
    const p = cards[s.addOracleId]?.priceUsd;
    return p === undefined ? null : p * s.qty;
  };
  const paperOf = (list: SuggestView['swaps']) => {
    const known = list.map(paper).filter((p): p is number => p !== null);
    return known.length ? known.reduce((a, b) => a + b, 0) : null;
  };

  const chosen = view ? view.swaps.filter((_, i) => picked.has(i)) : [];
  const pickedCost = view
    ? chosen.reduce<WildcardCounts>(
        (acc, s) => {
          for (const r of RARITIES) acc[r] += s.wildcardCost[r] ?? 0;
          return acc;
        },
        { common: 0, uncommon: 0, rare: 0, mythic: 0 },
      )
    : null;
  const optional = view ? view.swaps.filter((s) => !s.required).length : 0;
  const allPaper = view ? paperOf(view.swaps) : null;
  const pickedPaper = paperOf(chosen);

  return (
    <Section id="deck-upgrades" title="Upgrades" meta={meta ? `steered by ${meta.label}` : 'card strength estimated without meta lists'}>
      <form class="upg" onSubmit={suggest}>
        <div class="upg__grid">
          <fieldset class="seg">
            <legend class="seg__legend">Version</legend>
            <div class="seg__options">
              {PROFILES.map((m) => (
                <label key={m.id} class="seg__opt">
                  <input type="radio" name="upg-profile" value={m.id} checked={profile === m.id} onChange={() => setProfile(m.id)} />
                  <span class="seg__label">{m.label}</span>
                  <span class="seg__note">{m.note}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset class="seg">
            <legend class="seg__legend">How much may change</legend>
            <div class="seg__options">
              <label class="seg__opt">
                <input type="radio" name="upg-intensity" value="version" checked={intensity === 'version'} onChange={() => setIntensity('version')} />
                <span class="seg__label">Version's own</span>
                <span class="seg__note">{capNote(PROFILE_CHANGE_PERCENT[profile], ' of the deck')}</span>
              </label>
              {CAPS.map((m) => (
                <label key={m.id} class="seg__opt">
                  <input type="radio" name="upg-intensity" value={m.id} checked={intensity === m.id} onChange={() => setIntensity(m.id)} />
                  <span class="seg__label">{m.label}</span>
                  <span class="seg__note">{m.note}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <label class="check">
          <input
            type="checkbox"
            checked={premium}
            onChange={(e) => {
              const v = (e.target as HTMLInputElement).checked;
              setPremium(v);
              store.set(PREMIUM_KEY, v);
            }}
          />
          <span>
            Prefer mythics and rares
            <span class="check__hint">
              Leans toward mythics and rares (and pricier cards among equals) whenever there is a choice, and lifts the friendly casual version's
              no-rarer-wildcards rule. Never goes past your wildcard budget. Remembered in this browser.
            </span>
          </span>
        </label>
        <fieldset class="upg__budget">
          <legend>Wildcard budget</legend>
          <label class="check">
            <input type="checkbox" checked={limit} onChange={(e) => setLimit((e.target as HTMLInputElement).checked)} />
            <span>Only suggest what these wildcards can craft</span>
          </label>
          <div class="wc__inputs" aria-disabled={limit ? undefined : 'true'}>
            {RARITIES.map((r) => (
              <label key={r} class="field field--inline">
                <span class="field__label">{RARITY_LABEL[r]}</span>
                <input
                  class="input input--num"
                  type="number"
                  min={0}
                  max={999}
                  inputMode="numeric"
                  disabled={!limit}
                  value={budget[r]}
                  onInput={(e) => setBudget({ ...budget, [r]: Math.max(0, Math.min(999, Math.floor(Number((e.target as HTMLInputElement).value) || 0))) })}
                />
              </label>
            ))}
          </div>
        </fieldset>
        <details class="disclosure upg__locks">
          <summary>
            Lock cards you want to keep{locked.size ? ` (${locked.size} locked)` : ''}
          </summary>
          <p class="dsec__lead">Locked cards are never cut. Only the land fixes of a version touch lands.</p>
          <ul class="locks">
            {nonland.map((e) => (
              <li key={e.oracleId}>
                <button type="button" class="chip chip--small" aria-pressed={locked.has(e.name)} onClick={() => toggleLock(e.name)}>
                  <span class="visually-hidden">Lock </span>
                  {e.qty} {e.name.split(' // ')[0]}
                </button>
              </li>
            ))}
          </ul>
        </details>
        <div class="upg__run">
          <label class="field field--inline" for="upg-max">
            <span class="field__label">At most</span>
            <select id="upg-max" class="input select" value={String(maxSwaps)} onChange={(e) => setMaxSwaps(Number((e.target as HTMLSelectElement).value))}>
              {[3, 5, 8, 12, 20].map((n) => (
                <option key={n} value={String(n)}>
                  {n} swaps
                </option>
              ))}
            </select>
          </label>
          <button type="submit" class="btn btn--primary" disabled={working || busy}>
            Suggest upgrades
          </button>
        </div>
      </form>

      {working ? <Busy>Looking for upgrades…</Busy> : null}
      {error ? (
        <Notice tone="error">
          <p>{error}</p>
        </Notice>
      ) : null}
      {view ? (
        <div class="upg__out" aria-live="polite">
          {view.swaps.length === 0 ? (
            <p class="muted">No upgrade clears the bar with these settings. Try another version, allow more change, a bigger budget, or unlock some cards.</p>
          ) : (
            <>
              <p class="upg__summary">
                {plural(view.swaps.length, 'swap')} change {view.changes.cards} of {view.changes.deckSize} cards (at most {view.changes.limit}). Cost of all:{' '}
                <strong>{cost(view.totalCost)}</strong>
                {allPaper !== null ? ` (paper price about ${usd(allPaper)})` : ''}
                {view.remaining ? ` · left over: ${cost(view.remaining)}` : ''}.
              </p>
              {view.estimateOnly && optional > 0 ? (
                <p class="upg__estimate muted">
                  No meta lists steered these swaps, so they rest on an estimate from popularity, rarity and age. Only the swaps that have to happen are
                  ticked; tick the others you agree with, or choose meta lists below for firmer suggestions.
                </p>
              ) : null}
              <ul class="swaps">
                {view.swaps.map((s, i) => {
                  const price = paper(s);
                  return (
                    <li class={`swap${s.required ? ' swap--required' : ''}`} key={`${s.cutOracleId}-${s.addOracleId}`}>
                      <label class="swap__pick">
                        <input
                          type="checkbox"
                          checked={picked.has(i)}
                          onChange={() =>
                            setPicked((p) => {
                              const n = new Set(p);
                              if (n.has(i)) n.delete(i);
                              else n.add(i);
                              return n;
                            })
                          }
                        />
                        <span class="visually-hidden">
                          Include: cut {s.qty} {s.cut}, add {s.add}
                        </span>
                      </label>
                      <div class="swap__body">
                        <p class="swap__line">
                          <span class="swap__cut">
                            <span class="swap__sign" aria-hidden="true">
                              −
                            </span>
                            <span class="visually-hidden">Cut </span>
                            {s.qty} <CardName card={cards[s.cutOracleId]} name={s.cut} onOpen={onPeek} />
                          </span>
                          <span class="swap__arrow" aria-hidden="true">
                            →
                          </span>
                          <span class="swap__add">
                            <span class="swap__sign" aria-hidden="true">
                              +
                            </span>
                            <span class="visually-hidden">Add </span>
                            {s.qty} <CardName card={cards[s.addOracleId]} name={s.add} onOpen={onPeek} />
                          </span>
                          {s.required ? <span class="badge badge--warning">has to go</span> : null}
                          {s.kind === 'land' ? <span class="badge">land fix</span> : null}
                        </p>
                        <p class="swap__why">{s.reason}</p>
                        <p class="swap__cost">
                          {RARITIES.filter((r) => (s.wildcardCost[r] ?? 0) > 0).map((r: Rarity) => (
                            <span key={r} class="swap__wc">
                              {s.wildcardCost[r]}× <RarityTag rarity={r} />
                            </span>
                          ))}
                          {RARITIES.every((r) => !(s.wildcardCost[r] ?? 0)) ? <span class="muted">no wildcards</span> : null}
                          {price !== null ? <span class="swap__usd">paper about {usd(price)}</span> : null}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              <div class="cluster upg__apply">
                <button type="button" class="btn btn--primary" onClick={() => void applyPicked()} disabled={picked.size === 0 || working || busy}>
                  {picked.size === view.swaps.length ? 'Apply all swaps' : `Apply ${plural(picked.size, 'swap')}`}
                </button>
                {pickedCost ? (
                  <span class="muted">
                    Costs {cost(pickedCost)}
                    {pickedPaper !== null && chosen.length > 0 ? ` (paper about ${usd(pickedPaper)})` : ''}. You can undo it from the summary.
                  </span>
                ) : null}
              </div>
            </>
          )}
          {view.notes.length > 0 ? (
            <ul class="dsec__notes">
              {view.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Section>
  );
}
