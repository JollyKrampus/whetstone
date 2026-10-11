import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import ScoreRing from '../../../../components/ScoreRing.tsx';
import type { PresetId, Weights } from '../../../../core/draft.ts';
import { fixed, int, pp, signed } from '../../../../core/format.ts';
import type { Reason } from '../../../../core/game.ts';
import { breakdown, conditionsText, disabledNote, isFlatTop, reasonLabel, type PresetInfo, type Suggestion } from '../../draft/suggest.ts';
import { creditParts, portraitUrl, roleText, sourceName, type CreditProp } from './props.ts';

interface Props {
  idPrefix: string;
  suggestions: readonly Suggestion[];
  weights: Weights;
  /** Sort modes; omit to hide the mode switch (ARAM). */
  presets?: readonly PresetInfo[];
  preset?: PresetId;
  onPreset?: (id: PresetId) => void;
  /** Visible action label ("Pick", "Ban"); omit for no action button. */
  action?: string;
  /** Accessible action phrase, e.g. "Pick {name} for you". */
  actionLabel?: (name: string) => string;
  onChoose?: (id: string) => void;
  /** Inline credits for the sources behind these suggestions (statistics, pro ban rates). */
  credits: readonly CreditProp[];
  /** "Storm League · 2.57 …" when match statistics are in use. */
  statsLabel: string | null;
  /** Initially visible rows (default 6). */
  limit?: number;
  /** Label of the #1 entry (ARAM: "Best pick"). */
  topLabel?: string;
  empty?: ComponentChildren;
  /** Source names by SourceRef id, for the reason meta ("n = 120 · Liquipedia"). */
  sourceNames?: Readonly<Record<string, string>>;
}

/** "Only when …": the talents or situations a reason depends on, as its own visible line. */
export function Conditions({ reason }: { reason: Reason }) {
  const text = conditionsText(reason);
  if (!text) return null;
  return (
    <span class="sg-reason__cond">
      <span class="sg-reason__cond-label">Only when</span> {text}
    </span>
  );
}

function ReasonLine({ reason, label, tone, names }: { reason: Reason; label: string; tone?: 'warn'; names?: Readonly<Record<string, string>> | undefined }) {
  const meta: string[] = [];
  if (reason.delta !== undefined) meta.push(pp(reason.delta));
  if (reason.n !== undefined) meta.push(`n = ${int(reason.n)}`);
  const source = sourceName(names, reason.source);
  if (source) meta.push(source);
  return (
    <li class={`sg-reason sg-reason--${reason.kind}${tone ? ' sg-reason--warn' : ''}`}>
      <span class="sg-reason__kind">{tone ? 'Watch out' : label}</span>
      <span class="sg-reason__body">
        <span class="sg-reason__text">{reason.text}</span>
        <Conditions reason={reason} />
        {meta.length > 0 ? <span class="sg-reason__meta">{tone ? `${label} · ` : ''}{meta.join(' · ')}</span> : tone ? <span class="sg-reason__meta">{label}</span> : null}
      </span>
    </li>
  );
}

/** A source's required credit: same screen as its numbers, body-size text, a working link (and the licence for share-alike data). */
export function InlineCredit({ credit }: { credit: CreditProp }) {
  const { before, after } = creditParts(credit);
  const license = credit.licenseUrl ? (
    <>
      {' '}
      (
      <a href={credit.licenseUrl} rel="license noopener">
        licence
      </a>
      )
    </>
  ) : null;
  return (
    <p class="sg-credit" data-attribution="inline" data-source={credit.id}>
      {before}
      <a href={credit.url} rel="noopener">
        {credit.name}
      </a>
      {license ? after.replace(/\.$/, '') : after}
      {license}
      {license ? '.' : null}
    </p>
  );
}

function Breakdown({ s, weights, id, names }: { s: Suggestion; weights: Weights; id: string; names?: Readonly<Record<string, string>> | undefined }) {
  const rows = breakdown(s, weights);
  return (
    <div class="sg-break" id={id}>
      <table class="sg-break__table">
        <caption class="visually-hidden">Score breakdown for {s.hero.name}</caption>
        <thead>
          <tr>
            <th scope="col">Signal</th>
            <th scope="col" class="num">Value</th>
            <th scope="col" class="num">Weight</th>
            <th scope="col" class="num">Adds</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key} data-zero={r.weight === 0 ? 'true' : undefined}>
              <th scope="row">{r.label}</th>
              <td class="num">{signed(r.value, 2)}</td>
              <td class="num">{fixed(r.weight, 1)}</td>
              <td class="num">
                <span class={r.contribution > 0.005 ? 'delta--up' : r.contribution < -0.005 ? 'delta--down' : 'delta--flat'}>{signed(r.contribution, 2)}</span>
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">Total</th>
            <td colSpan={2} />
            <td class="num">{signed(s.raw, 2)}</td>
          </tr>
        </tfoot>
      </table>
      <p class="sg-break__formula">
        Score {s.score} = 50 + 50 × tanh({fixed(s.raw, 2)}). A value of 1.0 is about a 4 pp edge. Signals with weight 0 are shown but not counted in
        this sort mode.
      </p>
      {rows.some((r) => r.reasons.length > 0) ? (
        <ul class="sg-break__reasons">
          {rows.flatMap((r) =>
            r.reasons.map(({ reason, value }, i) => {
              const cond = conditionsText(reason);
              const source = sourceName(names, reason.source);
              return (
                <li key={`${r.key}-${i}`}>
                  <span class="sg-break__val">{signed(value, 2)}</span>
                  <span>
                    <span class="sg-break__key">{reasonLabel(reason, r.key)}</span> {reason.text}
                    {cond ? <span class="sg-break__cond"> Only when {cond}</span> : null}
                    {reason.n !== undefined ? (
                      <span class="sg-break__n">
                        {' '}
                        (n = {int(reason.n)}
                        {source ? `, ${source}` : ''})
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            }),
          )}
        </ul>
      ) : (
        <p class="sg-break__formula">No signals: nothing in the data speaks for or against this hero here.</p>
      )}
    </div>
  );
}

/**
 * Ranked suggestions with up to three reasons and one warning each, a sort-mode switch and a
 * tap-to-open breakdown (no hover-only information). Credits each source inline whenever its
 * numbers are part of what is shown; otherwise labels the list as theory. Says so when the top of
 * the list is too close to call.
 */
export default function SuggestionList(props: Props) {
  const { idPrefix, suggestions, weights, presets, preset, onPreset, action, actionLabel, onChoose, credits, statsLabel, limit = 6, topLabel, empty, sourceNames } = props;
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  const shown = all ? suggestions : suggestions.slice(0, limit);
  const disabledWhy = presets ? disabledNote(presets) : '';
  const flat = isFlatTop(suggestions, limit);

  return (
    <div class="sg">
      {presets && preset && onPreset ? (
        <div class="sg-modes">
          <div class="sg-modes__list" role="group" aria-label="Sort suggestions by">
            {presets
              .filter((p) => p.visible)
              .map((p) => (
                <button
                  type="button"
                  key={p.id}
                  class="chip sg-modes__chip"
                  aria-pressed={p.id === preset}
                  aria-disabled={p.enabled ? undefined : 'true'}
                  aria-describedby={p.enabled ? undefined : `${idPrefix}-modes-why`}
                  onClick={() => p.enabled && onPreset(p.id)}
                >
                  {p.label}
                </button>
              ))}
          </div>
          {disabledWhy ? (
            <p class="sg-modes__why" id={`${idPrefix}-modes-why`}>
              {disabledWhy}
            </p>
          ) : null}
        </div>
      ) : null}

      <p class="sg-basis">
        {statsLabel ? (
          <>
            <span class="badge badge--stats">Stats</span> <span>Match statistics ({statsLabel}), with theory where data is thin.</span>
          </>
        ) : (
          <>
            <span class="badge badge--theory">Theory</span> <span>Rule-based from hero kits and roles, not win rates.</span>
          </>
        )}
      </p>
      {credits.map((c) => (
        <InlineCredit key={c.id} credit={c} />
      ))}
      {flat && shown.length > 0 ? (
        <p class="sg-flat" role="note">
          No clear favourite: the top {Math.min(limit, suggestions.length)} are within a couple of points of each other, so treat them as a shortlist
          and go with the one you play best.
        </p>
      ) : null}

      {shown.length === 0 ? (
        <div class="sg-empty">{empty ?? 'No suggestions for this step.'}</div>
      ) : (
        <ol class="sg-list">
          {shown.map((s, i) => {
            const panelId = `${idPrefix}-why-${s.id}`;
            const isOpen = open === s.id;
            return (
              <li class="sg-item" key={s.id} data-hero={s.id}>
                <div class="sg-item__top">
                  <span class="sg-item__rank" aria-hidden="true">
                    {i + 1}
                  </span>
                  <img class="sg-item__img" src={portraitUrl(s.hero)} alt="" width="44" height="44" loading="lazy" decoding="async" />
                  <span class="sg-item__who">
                    <span class="sg-item__name">
                      <span class="visually-hidden">Rank {i + 1}: </span>
                      {s.hero.name}
                      {i === 0 && topLabel ? <span class="badge badge--accent sg-item__top-label">{topLabel}</span> : null}
                    </span>
                    <span class="sg-item__role">{roleText(s.hero)}</span>
                  </span>
                  <ScoreRing score={Math.max(1, s.score)} size={44} label={`Suggestion score ${s.score} out of 100`} />
                </div>
                {s.reasons.length > 0 || s.warning ? (
                  <ul class="sg-reasons">
                    {s.reasons.map((r, j) => (
                      <ReasonLine key={j} reason={r} label={reasonLabel(r, s.keyOf.get(r))} names={sourceNames} />
                    ))}
                    {s.warning ? <ReasonLine reason={s.warning} label={reasonLabel(s.warning, s.keyOf.get(s.warning))} tone="warn" names={sourceNames} /> : null}
                  </ul>
                ) : (
                  <p class="sg-item__none">No strong signal either way.</p>
                )}
                <div class="sg-item__actions">
                  {action && onChoose ? (
                    <button type="button" class="btn btn--primary sg-item__go" onClick={() => onChoose(s.id)} aria-label={actionLabel ? actionLabel(s.hero.name) : `${action} ${s.hero.name}`}>
                      {action}
                    </button>
                  ) : null}
                  <button type="button" class="btn btn--ghost sg-item__why" aria-expanded={isOpen} aria-controls={panelId} onClick={() => setOpen(isOpen ? null : s.id)}>
                    {isOpen ? 'Hide breakdown' : 'Why this score?'}
                  </button>
                </div>
                {isOpen ? <Breakdown s={s} weights={weights} id={panelId} names={sourceNames} /> : null}
              </li>
            );
          })}
        </ol>
      )}

      {suggestions.length > limit ? (
        <button type="button" class="btn btn--ghost sg-more" aria-expanded={all} onClick={() => setAll(!all)}>
          {all ? 'Show fewer' : `Show all ${suggestions.length}`}
        </button>
      ) : null}
    </div>
  );
}
