/**
 * Sample hands ("keep or mulligan?" practice with a shareable seed) and the seeded mulligan
 * simulation. Both run in the analyzer worker; the same seed always deals the same cards.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { int } from '../../../../core/format.ts';
import { IMAGE_SIZES, cardImageUrl } from '../../lib/images.ts';
import { analyzer } from '../../worker/client.ts';
import type { AnalyzeResult, CardView, HandResult, Role, SimCheck, SimReport } from '../../worker/protocol.ts';
import { Busy, Notice, Section, pct01 } from '../ui.tsx';
import { roleLabel } from './sections.tsx';

type Peek = (card: CardView) => void;

interface Props {
  result: AnalyzeResult;
  /** Seed of the shared hand; 0 = none dealt yet. */
  seed: number;
  onSeed: (seed: number) => void;
  newSeed: () => number;
  onPeek: Peek;
}

const ROLES: readonly Role[] = ['removal', 'counterspell', 'sweeper', 'card_draw', 'ramp', 'tutor', 'threat', 'protection', 'lifegain'];
const ITERATIONS = [1_000, 10_000, 50_000] as const;

type Call = 'keep' | 'mulligan';

export function Hands({ result, seed, onSeed, newSeed, onPeek }: Props) {
  const [hand, setHand] = useState<HandResult | null>(null);
  const [handError, setHandError] = useState<string | null>(null);
  const [dealing, setDealing] = useState(false);
  const [call, setCall] = useState<Call | null>(null);
  const [score, setScore] = useState({ agree: 0, total: 0 });
  const byId = result.cards;
  const text = result.arenaText;
  const canDeal = result.counts.main >= 7;

  const deal = async (s: number) => {
    setDealing(true);
    setHandError(null);
    try {
      const h = await analyzer().request('hand', { text, seed: s });
      setHand(h);
      setCall(null);
    } catch (err) {
      setHandError(err instanceof Error ? err.message : String(err));
    } finally {
      setDealing(false);
    }
  };

  // A shared link with a seed deals that exact hand.
  useEffect(() => {
    if (seed > 0 && canDeal) void deal(seed);
    // Only for the seed the section was opened with.
  }, []);

  const dealNew = () => {
    const s = newSeed();
    onSeed(s);
    void deal(s);
  };

  const decide = (c: Call) => {
    if (!hand || call) return;
    setCall(c);
    const agree = (c === 'keep') === hand.keepable;
    setScore((sc) => ({ agree: sc.agree + (agree ? 1 : 0), total: sc.total + 1 }));
  };

  return (
    <Section id="deck-hands" title="Opening hands" meta="seeded, so a link replays the same cards">
      <div class="hands">
        <div class="hands__deal">
          <h3 class="sub">Keep or mulligan?</h3>
          <p class="dsec__lead">Deal a seven, make your call, then compare it with a simple rule of thumb and see the next three draws.</p>
          {!canDeal ? <p class="muted">A sample hand needs at least 7 cards in the main deck.</p> : null}
          <div class="cluster">
            <button type="button" class="btn btn--primary" onClick={dealNew} disabled={!canDeal || dealing}>
              {hand ? 'Deal another hand' : 'Deal a hand'}
            </button>
            {hand ? <span class="mono muted">seed {hand.seed}</span> : null}
          </div>
          {dealing ? <Busy>Shuffling…</Busy> : null}
          {handError ? (
            <Notice tone="error">
              <p>{handError}</p>
            </Notice>
          ) : null}
          {hand ? (
            <div class="hand" aria-live="polite">
              <HandCards names={hand.hand} ids={hand.ids} cards={byId} onPeek={onPeek} label="Opening hand" />
              <p class="hand__facts">
                {hand.landsInHand} {hand.landsInHand === 1 ? 'land' : 'lands'}, {7 - hand.landsInHand} spells
              </p>
              {call === null ? (
                <div class="cluster hand__calls" role="group" aria-label="Your call">
                  <button type="button" class="btn" onClick={() => decide('keep')}>
                    Keep
                  </button>
                  <button type="button" class="btn" onClick={() => decide('mulligan')}>
                    Mulligan
                  </button>
                </div>
              ) : (
                <div class="hand__verdict">
                  <p>
                    You chose <strong>{call === 'keep' ? 'keep' : 'mulligan'}</strong>. The rule of thumb says{' '}
                    <strong>{hand.keepable ? 'keep' : 'mulligan'}</strong>
                    {hand.keepable
                      ? ': two to five lands and a spell of mana value 3 or less those lands can cast.'
                      : hand.landsInHand < 2
                        ? ': fewer than two lands.'
                        : hand.landsInHand > 5
                          ? ': more than five lands.'
                          : ': no spell of mana value 3 or less that these lands can cast.'}{' '}
                    {(call === 'keep') === hand.keepable ? 'You agree.' : 'You disagree, which can be right: the rule ignores your matchup and play or draw.'}
                  </p>
                  <h4 class="hand__next-title">Next three draws</h4>
                  <HandCards names={hand.nextDraws} ids={hand.ids} cards={byId} onPeek={onPeek} label="Next three draws" small />
                </div>
              )}
              {score.total > 0 ? (
                <p class="muted hand__score" role="status">
                  Agreed with the rule of thumb on {score.agree} of {score.total} {score.total === 1 ? 'hand' : 'hands'}.
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        <Simulation key={text} result={result} />
      </div>
    </Section>
  );
}

function HandCards({ names, ids, cards, onPeek, label, small = false }: { names: string[]; ids: Record<string, string>; cards: Record<string, CardView>; onPeek: Peek; label: string; small?: boolean }) {
  return (
    <ol class={`handcards${small ? ' handcards--small' : ''}`} aria-label={label}>
      {names.map((name, i) => {
        const card = ids[name] ? cards[ids[name]!] : undefined;
        const src = cardImageUrl(card?.scryfallId, 'small');
        return (
          <li class="handcards__card" key={`${name}-${i}`}>
            {card ? (
              <button type="button" class="handcards__btn" onClick={() => onPeek(card)} aria-haspopup="dialog">
                {src ? <img src={src} alt="" width={IMAGE_SIZES.small.width} height={IMAGE_SIZES.small.height} loading="lazy" decoding="async" referrerpolicy="no-referrer" /> : <span class="handcards__noimg" aria-hidden="true" />}
                <span class="handcards__name">{name.split(' // ')[0]}</span>
              </button>
            ) : (
              <span class="handcards__btn">
                <span class="handcards__noimg" aria-hidden="true" />
                <span class="handcards__name">{name}</span>
              </span>
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---- mulligan simulation -----------------------------------------------------------------------

function Simulation({ result }: { result: AnalyzeResult }) {
  const [report, setReport] = useState<SimReport>(result.simulation);
  const [playDraw, setPlayDraw] = useState<'play' | 'draw'>(result.simulation.playDraw);
  const [smoothing, setSmoothing] = useState(result.simulation.bo1Smoothing);
  const [iterations, setIterations] = useState<number>(10_000);
  const [simSeed, setSimSeed] = useState(1);
  const [checks, setChecks] = useState<SimCheck[]>([]);
  const [checkWhat, setCheckWhat] = useState('');
  const [checkTurn, setCheckTurn] = useState(3);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const first = useRef(true);
  const spells = [...new Set(result.main.filter((e) => !/\bLand\b/.test((result.cards[e.oracleId]?.typeLine ?? '').split(' // ')[0] ?? '')).map((e) => e.name))].sort();
  const roles = ROLES.filter((r) => (result.analysis.roles.counts[r] ?? 0) > 0);

  const run = async (next: { checks?: SimCheck[] } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const r = await analyzer().request('simulate', {
        text: result.arenaText,
        options: { iterations, seed: simSeed, playDraw, bo1Smoothing: smoothing, checks: next.checks ?? checks },
      });
      setReport(r);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    void run();
  }, [playDraw, smoothing, iterations]);

  const addCheck = () => {
    if (!checkWhat) return;
    const [kind, value] = checkWhat.split(':', 2) as ['card' | 'role', string];
    const c: SimCheck = kind === 'role' ? { role: value as Role, byTurn: checkTurn } : { card: value, byTurn: checkTurn };
    if (checks.some((x) => x.card === c.card && x.role === c.role && x.byTurn === c.byTurn)) return;
    const next = [...checks, c].slice(-6);
    setChecks(next);
    void run({ checks: next });
  };
  const removeCheck = (i: number) => {
    const next = checks.filter((_, k) => k !== i);
    setChecks(next);
    void run({ checks: next });
  };

  const maxOpen = Math.max(0.0001, ...report.openingLands.map((o) => Math.max(o.simulated, o.exact)));
  const worstColors = [...report.colors].sort((a, b) => a.probability - b.probability).slice(0, 6);

  return (
    <div class="sim">
      <h3 class="sub">Mulligan simulation</h3>
      <p class="dsec__lead">
        {int(report.iterations)} shuffled games, London mulligan down to five, seed {report.seed}. Change a setting to run it again.
      </p>
      <form
        class="sim__controls"
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
      >
        <fieldset class="seg seg--compact">
          <legend class="seg__legend">Turn order</legend>
          <div class="seg__options">
            {(['play', 'draw'] as const).map((p) => (
              <label key={p} class="seg__opt">
                <input type="radio" name="sim-pd" value={p} checked={playDraw === p} onChange={() => setPlayDraw(p)} />
                <span class="seg__label">On the {p}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <label class="check">
          <input type="checkbox" checked={smoothing} onChange={(e) => setSmoothing((e.target as HTMLInputElement).checked)} />
          <span>
            Best-of-one hand smoothing
            <span class="check__hint">An approximation: the better of two opening hands by land count.</span>
          </span>
        </label>
        <div class="sim__row">
          <label class="field field--inline" for="sim-iter">
            <span class="field__label">Games</span>
            <select id="sim-iter" class="input select" value={String(iterations)} onChange={(e) => setIterations(Number((e.target as HTMLSelectElement).value))}>
              {ITERATIONS.map((n) => (
                <option key={n} value={String(n)}>
                  {int(n)}
                </option>
              ))}
            </select>
          </label>
          <label class="field field--inline" for="sim-seed">
            <span class="field__label">Seed</span>
            <input
              id="sim-seed"
              class="input input--num"
              type="number"
              min={1}
              max={4294967295}
              inputMode="numeric"
              value={simSeed}
              onChange={(e) => setSimSeed(Math.max(1, Math.min(4294967295, Math.floor(Number((e.target as HTMLInputElement).value) || 1))))}
            />
          </label>
          <button type="submit" class="btn" disabled={busy}>
            Run again
          </button>
        </div>
      </form>
      {busy ? <Busy>Simulating…</Busy> : null}
      {error ? (
        <Notice tone="error">
          <p>{error}</p>
        </Notice>
      ) : null}
      <dl class="stats" aria-busy={busy ? 'true' : 'false'}>
        <div>
          <dt>Keepable seven</dt>
          <dd>{pct01(report.keepable7)}</dd>
        </div>
        <div>
          <dt>Mulligan rate</dt>
          <dd>{pct01(report.mulliganRate)}</dd>
        </div>
        <div>
          <dt>Kept at 7 · 6 · 5 cards</dt>
          <dd class="stats__multi">
            {pct01(report.keptAt['7'], 0)} · {pct01(report.keptAt['6'], 0)} · {pct01(report.keptAt['5'], 0)}
          </dd>
        </div>
        <div>
          <dt>Colours on curve</dt>
          <dd>{pct01(report.colorAvailability)}</dd>
        </div>
      </dl>
      <div class="cols">
        <div>
          <h4 class="sub sub--sm">Land drops on curve</h4>
          <table class="mtable mtable--compact">
            <caption class="visually-hidden">Chance to have hit every land drop by each turn</caption>
            <thead>
              <tr>
                <th scope="col">By turn</th>
                <th scope="col" class="num">
                  Chance
                </th>
              </tr>
            </thead>
            <tbody>
              {(
                [
                  ['2', report.landDrops.turn2],
                  ['3', report.landDrops.turn3],
                  ['4', report.landDrops.turn4],
                  ['5', report.landDrops.turn5],
                ] as const
              ).map(([t, p]) => (
                <tr key={t}>
                  <th scope="row">Turn {t}</th>
                  <td class="num">{pct01(p)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <h4 class="sub sub--sm">Lands in the opening seven</h4>
          <table class="mtable mtable--compact olands">
            <caption class="visually-hidden">Lands in the first seven cards: simulated and exact hypergeometric probability</caption>
            <thead>
              <tr>
                <th scope="col">Lands</th>
                <th scope="col" class="num">
                  Simulated
                </th>
                <th scope="col" class="num">
                  Exact
                </th>
              </tr>
            </thead>
            <tbody>
              {report.openingLands.map((o) => (
                <tr key={o.lands}>
                  <th scope="row">{o.lands}</th>
                  <td class="num">
                    <span class="olands__cell">
                      <span class="olands__track" aria-hidden="true">
                        <span class="olands__bar" style={{ width: `${(o.simulated / maxOpen) * 100}%` }} />
                      </span>
                      {pct01(o.simulated)}
                    </span>
                  </td>
                  <td class="num">{pct01(o.exact)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {worstColors.length > 0 ? (
        <>
          <h4 class="sub sub--sm">Hardest cards to cast on curve</h4>
          <ul class="plain colorav">
            {worstColors.map((c) => (
              <li key={c.card}>
                <span class="colorav__p">{pct01(c.probability, 0)}</span> {c.card} <span class="muted">by turn {c.turn}</span>
              </li>
            ))}
          </ul>
        </>
      ) : null}
      <div class="checks">
        <h4 class="sub sub--sm">Will I have it by turn…?</h4>
        <div class="checks__form">
          <label class="field field--inline" for="check-what">
            <span class="field__label">Card or role</span>
            <select id="check-what" class="input select" value={checkWhat} onChange={(e) => setCheckWhat((e.target as HTMLSelectElement).value)}>
              <option value="">Choose…</option>
              {roles.length > 0 ? (
                <optgroup label="Any card with a role">
                  {roles.map((r) => (
                    <option key={r} value={`role:${r}`}>
                      {roleLabel(r)}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              <optgroup label="A specific card">
                {spells.map((n) => (
                  <option key={n} value={`card:${n}`}>
                    {n}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
          <label class="field field--inline" for="check-turn">
            <span class="field__label">By turn</span>
            <select id="check-turn" class="input select" value={String(checkTurn)} onChange={(e) => setCheckTurn(Number((e.target as HTMLSelectElement).value))}>
              {[1, 2, 3, 4, 5, 6, 7, 8].map((t) => (
                <option key={t} value={String(t)}>
                  {t}
                </option>
              ))}
            </select>
          </label>
          <button type="button" class="btn" onClick={addCheck} disabled={!checkWhat || busy}>
            Add check
          </button>
        </div>
        {report.checks.length > 0 ? (
          <ul class="plain checks__list">
            {report.checks.map((c, i) => (
              <li key={`${c.card ?? c.role}-${c.byTurn}`}>
                <span class="colorav__p">{pct01(c.probability, 0)}</span> {c.card ? c.card : `any ${roleLabel(c.role ?? '').toLowerCase()} card`} by turn {c.byTurn}{' '}
                <button type="button" class="btn btn--ghost btn--tiny" onClick={() => removeCheck(i)} aria-label={`Remove check for ${c.card ?? roleLabel(c.role ?? '')} by turn ${c.byTurn}`}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {report.notes.length > 0 ? (
        <ul class="dsec__notes">
          {report.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
