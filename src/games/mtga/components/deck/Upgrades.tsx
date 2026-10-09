/**
 * Budget upgrade planner: grindstone's suggestUpgrades with a wildcard budget, an intensity cap
 * (how much of the deck may change) and locked cards. Swaps can be applied in full or picked one
 * by one; the analyzer keeps an undo stack.
 */
import { useState } from 'preact/hooks';
import { analyzer } from '../../worker/client.ts';
import type { AnalyzeResult, CardView, Intensity, MetaSelection, Mode, Rarity, SuggestView, WildcardCounts } from '../../worker/protocol.ts';
import { CardName } from '../CardPeek.tsx';
import { Busy, Notice, RARITIES, RARITY_LABEL, RarityTag, Section, plural } from '../ui.tsx';

type Peek = (card: CardView) => void;

interface Props {
  result: AnalyzeResult;
  /** Meta lists used for the analysis (also steer card choice); null = heuristic only. */
  meta: MetaSelection | null;
  onApply: (text: string) => void;
  onPeek: Peek;
  busy: boolean;
}

const INTENSITIES: readonly { id: Intensity; label: string; note: string }[] = [
  { id: 'light', label: 'Light', note: 'about 7% of the deck' },
  { id: 'normal', label: 'Normal', note: 'about 15%' },
  { id: 'heavy', label: 'Heavy', note: 'about 30%' },
];

const MODES: readonly { id: Mode; label: string; note: string }[] = [
  { id: 'casual', label: 'Budget-minded', note: 'favours cheaper rarities' },
  { id: 'competitive', label: 'Strongest', note: 'favours meta staples' },
];

const isLandType = (c: CardView | undefined) => /\bLand\b/.test((c?.typeLine ?? '').split(' // ')[0] ?? '');

export function Upgrades({ result, meta, onApply, onPeek, busy }: Props) {
  const [mode, setMode] = useState<Mode>('casual');
  const [intensity, setIntensity] = useState<Intensity>('normal');
  const [limit, setLimit] = useState(false);
  const [budget, setBudget] = useState<WildcardCounts>({ common: 8, uncommon: 6, rare: 4, mythic: 1 });
  const [maxSwaps, setMaxSwaps] = useState(8);
  const [locked, setLocked] = useState<Set<string>>(() => new Set());
  const [view, setView] = useState<SuggestView | null>(null);
  const [picked, setPicked] = useState<Set<number>>(() => new Set());
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nonland = result.main.filter((e) => !isLandType(result.cards[e.oracleId]));
  const cardsByName = new Map(Object.values({ ...result.cards, ...(view?.cards ?? {}) }).map((c) => [c.name, c]));

  const suggest = async (e: Event) => {
    e.preventDefault();
    setWorking(true);
    setError(null);
    try {
      const v = await analyzer().request('suggest', {
        text: result.arenaText,
        format: result.format,
        mode,
        intensity,
        wildcards: limit ? budget : null,
        keepCards: [...locked],
        maxSwaps,
        meta,
      });
      setView(v);
      setPicked(new Set(v.swaps.map((_, i) => i)));
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
    const swaps = view.swaps.filter((_, i) => picked.has(i)).map((s) => ({ cut: s.cut, add: s.add, qty: s.qty }));
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

  const pickedCost = view
    ? view.swaps.reduce<WildcardCounts>(
        (acc, s, i) => {
          if (!picked.has(i)) return acc;
          for (const r of RARITIES) acc[r] += s.wildcardCost[r] ?? 0;
          return acc;
        },
        { common: 0, uncommon: 0, rare: 0, mythic: 0 },
      )
    : null;

  return (
    <Section id="deck-upgrades" title="Budget upgrades" meta={meta ? `steered by ${meta.label}` : 'card strength estimated without meta lists'}>
      <form class="upg" onSubmit={suggest}>
        <div class="upg__grid">
          <fieldset class="seg">
            <legend class="seg__legend">Priority</legend>
            <div class="seg__options">
              {MODES.map((m) => (
                <label key={m.id} class="seg__opt">
                  <input type="radio" name="upg-mode" value={m.id} checked={mode === m.id} onChange={() => setMode(m.id)} />
                  <span class="seg__label">{m.label}</span>
                  <span class="seg__note">{m.note}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset class="seg">
            <legend class="seg__legend">How much may change</legend>
            <div class="seg__options">
              {INTENSITIES.map((m) => (
                <label key={m.id} class="seg__opt">
                  <input type="radio" name="upg-intensity" value={m.id} checked={intensity === m.id} onChange={() => setIntensity(m.id)} />
                  <span class="seg__label">{m.label}</span>
                  <span class="seg__note">{m.note}</span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
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
          <p class="dsec__lead">Locked cards are never cut. Lands are never cut either.</p>
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
            <p class="muted">No upgrade clears the bar with these settings. Try a heavier change, a bigger budget, or unlock some cards.</p>
          ) : (
            <>
              <p class="upg__summary">
                {plural(view.swaps.length, 'swap')} change {view.changes.cards} of {view.changes.deckSize} cards (cap {view.changes.limit} for {view.changes.intensity}). Cost of all:{' '}
                <strong>{cost(view.totalCost)}</strong>
                {view.remaining ? ` · left over: ${cost(view.remaining)}` : ''}.
              </p>
              <ul class="swaps">
                {view.swaps.map((s, i) => (
                  <li class="swap" key={`${s.cut}-${s.add}`}>
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
                          {s.qty} <CardName card={cardsByName.get(s.cut)} name={s.cut} onOpen={onPeek} />
                        </span>
                        <span class="swap__arrow" aria-hidden="true">
                          →
                        </span>
                        <span class="swap__add">
                          <span class="swap__sign" aria-hidden="true">
                            +
                          </span>
                          <span class="visually-hidden">Add </span>
                          {s.qty} <CardName card={cardsByName.get(s.add)} name={s.add} onOpen={onPeek} />
                        </span>
                      </p>
                      <p class="swap__why">{s.reason}</p>
                      <p class="swap__cost">
                        {RARITIES.filter((r) => (s.wildcardCost[r] ?? 0) > 0).map((r: Rarity) => (
                          <span key={r} class="swap__wc">
                            {s.wildcardCost[r]}× <RarityTag rarity={r} />
                          </span>
                        ))}
                        {RARITIES.every((r) => !(s.wildcardCost[r] ?? 0)) ? <span class="muted">no wildcards</span> : null}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
              <div class="cluster upg__apply">
                <button type="button" class="btn btn--primary" onClick={() => void applyPicked()} disabled={picked.size === 0 || working || busy}>
                  {picked.size === view.swaps.length ? 'Apply all swaps' : `Apply ${plural(picked.size, 'swap')}`}
                </button>
                {pickedCost ? <span class="muted">Costs {cost(pickedCost)}. You can undo it from the summary.</span> : null}
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
