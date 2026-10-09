/**
 * Read-only result sections of the deck analyzer. Every number shows its basis in text (no
 * colour-only cues, no hover-only details); card names open the card dialog.
 */
import { useEffect, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { createStore } from '../../../../core/storage.ts';
import { CardName } from '../CardPeek.tsx';
import ManaCost from '../ManaCost.tsx';
import { COLOR_NAME, Meter, RARITIES, RARITY_LABEL, RarityTag, Section, ColorPip, pct01, plural, toneFor } from '../ui.tsx';
import type { AnalyzeResult, CardView, Color, EntryView, Rarity, WildcardCounts } from '../../worker/protocol.ts';

type Peek = (card: CardView) => void;

const ROLE_LABEL: Readonly<Record<string, string>> = {
  removal: 'Removal',
  counterspell: 'Counterspell',
  sweeper: 'Sweeper',
  card_draw: 'Card draw',
  ramp: 'Ramp',
  tutor: 'Tutor',
  threat: 'Threat',
  protection: 'Protection',
  lifegain: 'Lifegain',
};

export function roleLabel(role: string): string {
  return ROLE_LABEL[role] ?? role.replace(/_/g, ' ');
}

const frontType = (c: CardView | undefined) => (c?.typeLine ?? '').split(' // ')[0] ?? '';

// ---- deck list with roles -------------------------------------------------------------------

function groupOf(card: CardView | undefined): 'Creatures' | 'Lands' | 'Spells' {
  const t = frontType(card);
  if (/\bCreature\b/.test(t)) return 'Creatures';
  if (/\bLand\b/.test(t)) return 'Lands';
  return 'Spells';
}

export function DeckList({ result, onPeek }: { result: AnalyzeResult; onPeek: Peek }) {
  const roles = new Map(result.analysis.roles.cards.map((c) => [c.name, c.roles]));
  const groups = new Map<string, EntryView[]>();
  for (const e of result.main) {
    const g = groupOf(result.cards[e.oracleId]);
    groups.set(g, [...(groups.get(g) ?? []), e]);
  }
  const order = ['Creatures', 'Spells', 'Lands'].filter((g) => groups.has(g));
  const row = (e: EntryView) => {
    const card = result.cards[e.oracleId];
    const tags = roles.get(e.name) ?? [];
    return (
      <li class="dl__row" key={e.oracleId}>
        <span class="dl__qty">{e.qty}</span>
        <span class="dl__name">
          <CardName card={card} name={e.name} onOpen={onPeek} />
          {tags.length > 0 ? (
            <span class="dl__roles">
              {tags.map((t) => (
                <span class="role" key={t.rule}>
                  {roleLabel(t.role)}
                  <span class="role__rule">{t.rule}</span>
                </span>
              ))}
            </span>
          ) : null}
        </span>
        <span class="dl__cost">{card?.manaCost ? <ManaCost cost={card.manaCost} /> : null}</span>
      </li>
    );
  };
  const counts = (list: EntryView[]) => list.reduce((n, e) => n + e.qty, 0);
  return (
    <Section id="deck-list" title="Deck and card roles" meta={`${plural(result.counts.main, 'card')} main · ${result.counts.side} sideboard`}>
      <p class="dsec__lead">
        Each tag names the rule that matched the card's rules text, so you can see why it was tagged (and disagree). Select a
        card name for its text and image.
      </p>
      <div class="dl">
        {result.commander ? (
          <div class="dl__group">
            <h3 class="dl__title">Commander</h3>
            <ul class="dl__list">{row(result.commander)}</ul>
          </div>
        ) : null}
        {result.companion ? (
          <div class="dl__group">
            <h3 class="dl__title">Companion</h3>
            <ul class="dl__list">{row(result.companion)}</ul>
          </div>
        ) : null}
        {order.map((g) => (
          <div class="dl__group" key={g}>
            <h3 class="dl__title">
              {g} <span class="dl__count">{counts(groups.get(g)!)}</span>
            </h3>
            <ul class="dl__list">{groups.get(g)!.map(row)}</ul>
          </div>
        ))}
        {result.side.length > 0 ? (
          <div class="dl__group">
            <h3 class="dl__title">
              Sideboard <span class="dl__count">{result.counts.side}</span>
            </h3>
            <ul class="dl__list">{result.side.map(row)}</ul>
          </div>
        ) : null}
      </div>
    </Section>
  );
}

// ---- legality ---------------------------------------------------------------------------------

export function Legality({ result }: { result: AnalyzeResult }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Section id="deck-legality" title="Legality on Arena" meta={`Card data of ${result.asOf}`}>
      <ul class="legal">
        {result.legality.map((l) => {
          const errors = l.issues.filter((i) => i.severity === 'error');
          const warnings = l.issues.filter((i) => i.severity === 'warning');
          const id = `legal-${l.format}`;
          const expanded = open === l.format;
          return (
            <li class={`legal__item legal__item--${l.legal ? 'ok' : 'no'}`} key={l.format}>
              <button
                type="button"
                class="legal__btn"
                aria-expanded={l.issues.length > 0 ? expanded : undefined}
                aria-controls={l.issues.length > 0 ? id : undefined}
                disabled={l.issues.length === 0}
                onClick={() => setOpen(expanded ? null : l.format)}
              >
                <span class="legal__mark" aria-hidden="true">
                  {l.legal ? '✓' : '✕'}
                </span>
                <span class="legal__name">{l.label}</span>
                <span class="legal__state">
                  {l.legal ? 'Legal' : `Not legal${errors.length ? ` · ${plural(errors.length, 'issue')}` : ''}`}
                  {l.legal && warnings.length ? ` · ${plural(warnings.length, 'note')}` : ''}
                </span>
                {result.format === l.format ? <span class="legal__current">analyzed</span> : null}
              </button>
              {l.issues.length > 0 && expanded ? (
                <ul class="legal__issues" id={id}>
                  {l.issues.map((i, k) => (
                    <li key={k} class={`legal__issue legal__issue--${i.severity}`}>
                      <span class="visually-hidden">{i.severity === 'error' ? 'Error: ' : 'Note: '}</span>
                      {i.message}
                    </li>
                  ))}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ---- power ------------------------------------------------------------------------------------

const TIER_LABELS = ['Jank', 'Casual', 'Focused', 'Optimized', 'Competitive'];

export function Power({ result, onAddMeta }: { result: AnalyzeResult; onAddMeta: () => void }) {
  const p = result.power;
  return (
    <Section id="deck-power" title="Power tier" meta={`${p.rubric} rubric · ${p.archetype} plan`}>
      <div class="power">
        <div class="power__tier" data-tier={p.tier}>
          <span class="power__label">Tier</span>
          <span class="power__num">{p.tier}</span>
          <span class="power__name">{p.label}</span>
          <span class="power__score">
            {p.score.toFixed(1)}
            <span class="power__of"> / 100</span>
          </span>
        </div>
        <ol class="power__scale" aria-label="Tier scale">
          {TIER_LABELS.map((label, i) => (
            <li key={label} class={i + 1 === p.tier ? 'is-current' : undefined}>
              <span class="visually-hidden">{i + 1 === p.tier ? 'Current: ' : ''}</span>
              {i + 1} {label}
            </li>
          ))}
        </ol>
      </div>
      {p.lowConfidence ? (
        <div class="notice notice--warning power__low" role="note">
          <p>
            <strong>Low confidence.</strong> Without meta lists, card quality is estimated from popularity, rarity and age only.
            Add decklists from the current meta for a fair rating.
          </p>
          <p>
            <button type="button" class="btn" onClick={onAddMeta}>
              Choose meta lists
            </button>
          </p>
        </div>
      ) : null}
      <ul class="dims">
        {p.dimensions.map((d) => (
          <li class="dim" key={d.name}>
            <div class="dim__head">
              <span class="dim__name">{d.name}</span>
              <span class="dim__weight">weight {Math.round(d.weight * 100)}%</span>
              {d.confidence === 'low' ? <span class="badge badge--warning">low confidence</span> : null}
              <span class="dim__score">{Math.round(d.score)}</span>
            </div>
            <Meter value={d.score} label={`${d.name}: ${Math.round(d.score)} out of 100`} tone={toneFor(d.score)} />
            <ul class="dim__reasons">
              {d.reasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---- curve and types --------------------------------------------------------------------------

export function Curve({ result }: { result: AnalyzeResult }) {
  const a = result.analysis;
  const buckets = Object.entries(a.curve) as [string, number][];
  const max = Math.max(1, ...buckets.map(([, n]) => n));
  const types = Object.entries(a.types).filter(([, n]) => n > 0).sort((x, y) => y[1] - x[1]);
  return (
    <Section id="deck-curve" title="Curve and card types" meta={`average mana value ${a.averageManaValue.toFixed(2)}`}>
      <figure class="curve">
        <figcaption class="visually-hidden">Nonland cards by mana value</figcaption>
        <ol class="curve__bars">
          {buckets.map(([mv, n]) => (
            <li class="curve__col" key={mv}>
              <span class="curve__n">{n}</span>
              <span class="curve__bar" style={{ height: `${(n / max) * 100}%` }} aria-hidden="true" />
              <span class="curve__mv">
                <span class="visually-hidden">mana value </span>
                {mv}
              </span>
            </li>
          ))}
        </ol>
      </figure>
      <dl class="facts">
        <div>
          <dt>Lands</dt>
          <dd>
            {a.landCount}
            {a.mdfcLandCount ? ` + ${a.mdfcLandCount} spell/land` : ''}
          </dd>
        </div>
        <div>
          <dt>Nonland</dt>
          <dd>{a.nonlandCount}</dd>
        </div>
        <div>
          <dt>Interaction</dt>
          <dd>
            {a.interaction.total} ({a.interaction.cheap} at ≤{a.interaction.cheapMaxMv})
          </dd>
        </div>
        {types.map(([t, n]) => (
          <div key={t}>
            <dt>{t}</dt>
            <dd>{n}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

// ---- mana -------------------------------------------------------------------------------------

export function Mana({ result }: { result: AnalyzeResult }) {
  const c = result.analysis.colors;
  const t = result.analysis.tappedLands;
  return (
    <Section id="deck-mana" title="Mana and colour sources" meta={c.deckColors.length ? c.deckColors.map((x) => COLOR_NAME[x]).join(', ') : 'Colorless'}>
      <p class="dsec__lead">
        Coloured sources against Frank Karsten's targets: how many sources you need to cast each card on curve about 90% of the
        time.
      </p>
      <ul class="sources">
        {(['W', 'U', 'B', 'R', 'G'] as Color[])
          .filter((x) => c.pips[x] > 0 || c.sources[x] > 0)
          .map((x) => (
            <li key={x} class="sources__item">
              <ColorPip color={x} />
              <span class="sources__name">{COLOR_NAME[x]}</span>
              <span class="sources__n">
                {c.sources[x]} {c.sources[x] === 1 ? 'source' : 'sources'} · {c.pips[x]} {c.pips[x] === 1 ? 'pip' : 'pips'}
              </span>
            </li>
          ))}
      </ul>
      {c.requirements.length > 0 ? (
        <div class="tablewrap">
          <table class="mtable">
            <caption class="visually-hidden">Colour requirements by card</caption>
            <thead>
              <tr>
                <th scope="col">Need</th>
                <th scope="col">Cards</th>
                <th scope="col" class="num">
                  Sources
                </th>
                <th scope="col">Check</th>
              </tr>
            </thead>
            <tbody>
              {c.requirements.map((r, i) => (
                <tr key={i}>
                  <td>
                    <span class="nowrap">
                      <ColorPip color={r.color} /> {r.pips}× {COLOR_NAME[r.color].toLowerCase()} by turn {r.mv}
                    </span>
                  </td>
                  <td class="mtable__cards">{r.cards.join(', ')}</td>
                  <td class="num">
                    {r.sources} / {r.sourcesNeeded}
                  </td>
                  <td>
                    <span class={`badge badge--${r.ok ? 'positive' : 'negative'}`}>{r.ok ? 'OK' : `${r.sourcesNeeded - r.sources} short`}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p class="muted">No coloured mana requirements.</p>
      )}
      <p class="dsec__foot">
        {t.unconditional + t.conditional === 0
          ? 'No lands enter tapped.'
          : `${plural(t.unconditional, 'land')} always enter tapped${t.conditional ? `, ${t.conditional} sometimes` : ''}: ${t.cards.map((x) => `${x.qty} ${x.name}`).join(', ')}.`}
      </p>
    </Section>
  );
}

// ---- wildcards --------------------------------------------------------------------------------

const store = createStore('mtga');
const OWNED_KEY = 'wildcardsOwned';
const validOwned = (v: unknown): WildcardCounts | undefined => {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out = { common: 0, uncommon: 0, rare: 0, mythic: 0 };
  for (const r of RARITIES) {
    const n = Number(o[r]);
    out[r] = Number.isFinite(n) && n >= 0 ? Math.min(9999, Math.floor(n)) : 0;
  }
  return out;
};

export function Wildcards({ result, onPeek }: { result: AnalyzeResult; onPeek: Peek }) {
  const w = result.wildcards;
  const [owned, setOwned] = useState<WildcardCounts>({ common: 0, uncommon: 0, rare: 0, mythic: 0 });
  useEffect(() => setOwned(store.get(OWNED_KEY, { common: 0, uncommon: 0, rare: 0, mythic: 0 }, validOwned)), []);
  const update = (r: Rarity, value: string) => {
    const next = { ...owned, [r]: Math.max(0, Math.min(9999, Math.floor(Number(value) || 0))) };
    setOwned(next);
    store.set(OWNED_KEY, next);
  };
  const byName = new Map(Object.values(result.cards).map((c) => [c.name, c]));
  const short = RARITIES.map((r) => ({ r, need: Math.max(0, w.byRarity[r] - owned[r]) }));
  const enough = short.every((s) => s.need === 0);
  return (
    <Section id="deck-wildcards" title="Wildcard cost" meta={`${w.total} to craft from scratch`}>
      <ul class="wc">
        {RARITIES.map((r) => (
          <li class={`wc__item wc__item--${r}`} key={r}>
            <span class="wc__n">{w.byRarity[r]}</span>
            <RarityTag rarity={r} />
          </li>
        ))}
      </ul>
      <fieldset class="wc__owned">
        <legend>Wildcards you have</legend>
        <div class="wc__inputs">
          {RARITIES.map((r) => (
            <label key={r} class="field field--inline">
              <span class="field__label">{RARITY_LABEL[r]}</span>
              <input class="input input--num" type="number" min={0} max={9999} inputMode="numeric" value={owned[r]} onInput={(e) => update(r, (e.target as HTMLInputElement).value)} />
            </label>
          ))}
        </div>
        <p class="wc__plan" role="status">
          {enough
            ? 'You have enough wildcards to craft every card (if you own none of them yet).'
            : `Still short: ${short
                .filter((s) => s.need > 0)
                .map((s) => `${s.need} ${RARITY_LABEL[s.r].toLowerCase()}`)
                .join(', ')}.`}
        </p>
      </fieldset>
      <details class="disclosure">
        <summary>Cost per card ({w.cards.length})</summary>
        <ul class="wc__cards">
          {w.cards.map((c) => (
            <li key={c.name}>
              <span class="wc__qty">{c.qty}×</span> <CardName card={byName.get(c.name)} name={c.name} onOpen={onPeek} /> <RarityTag rarity={c.rarity} short />
            </li>
          ))}
        </ul>
      </details>
      {w.unavailable.length > 0 ? <p class="dsec__foot">Not on Arena: {w.unavailable.join(', ')}.</p> : null}
      <p class="dsec__foot">Counts every copy as uncrafted (Whetstone cannot see your collection), each at its cheapest Arena rarity; basic lands are free.</p>
    </Section>
  );
}

// ---- meta comparison --------------------------------------------------------------------------

export type MetaChoice = 'auto' | 'mine' | 'curated' | 'none';

export function MetaCompare({
  result,
  choice,
  onChoice,
  available,
  metaHref,
  onPeek,
  children,
}: {
  result: AnalyzeResult;
  choice: MetaChoice;
  onChoice: (c: MetaChoice) => void;
  available: { mine: number; curated: number };
  metaHref: string;
  onPeek: Peek;
  children?: ComponentChildren;
}) {
  const m = result.meta;
  const byName = new Map(Object.values(result.cards).map((c) => [c.name, c]));
  const options: { id: MetaChoice; label: string; note: string; disabled?: boolean }[] = [
    { id: 'auto', label: 'Automatic', note: 'my lists, else curated' },
    { id: 'mine', label: 'My lists', note: `${available.mine} for this format`, disabled: available.mine === 0 },
    { id: 'curated', label: 'Curated', note: `${available.curated} for this format`, disabled: available.curated === 0 },
    { id: 'none', label: 'None', note: 'heuristic only' },
  ];
  return (
    <Section id="deck-meta" title="Compare to the meta" meta={m ? `${m.label} · ${plural(m.lists, 'list')}` : 'no meta lists'}>
      <fieldset class="seg">
        <legend class="seg__legend">Meta lists to compare with</legend>
        <div class="seg__options">
          {options.map((o) => (
            <label key={o.id} class={`seg__opt${o.disabled ? ' is-disabled' : ''}`}>
              <input type="radio" name="meta-choice" value={o.id} checked={choice === o.id} disabled={o.disabled} onChange={() => onChoice(o.id)} />
              <span class="seg__label">{o.label}</span>
              <span class="seg__note">{o.note}</span>
            </label>
          ))}
        </div>
      </fieldset>
      {children}
      {!m ? (
        <p class="muted">
          No meta lists for {result.legality.find((l) => l.format === result.format)?.label ?? result.format} yet. Paste a few
          current decklists on the <a href={metaHref}>Meta page</a> (they stay in your browser) to see the closest archetype, the
          core cards you are missing, and a confident card-quality score.
        </p>
      ) : !m.closest ? (
        <p class="muted">None of the meta lists could be compared.</p>
      ) : (
        <>
          <p class="closest">
            Closest: <strong>{m.closest.name}</strong>
            {m.closest.archetype !== m.closest.name ? ` (${m.closest.archetype})` : ''} · {m.closest.overlapPercent}% of nonland cards shared
            {m.closest.winRate !== undefined ? ` · ${pct01(m.closest.winRate)} win rate` : ''}
          </p>
          <div class="cols">
            <div>
              <h3 class="sub">Missing core cards</h3>
              {m.missingCore.length ? (
                <ul class="plain">
                  {m.missingCore.map((x) => (
                    <li key={x.name}>
                      <CardName card={byName.get(x.name)} name={x.name} onOpen={onPeek} />: lists run {x.metaQty}, you run {x.deckQty}
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="muted">None: your deck has the closest list's core.</p>
              )}
            </div>
            <div>
              <h3 class="sub">Unusual choices</h3>
              {m.unusual.length ? (
                <ul class="plain">
                  {m.unusual.map((x) => (
                    <li key={x.name}>
                      {x.qty} <CardName card={byName.get(x.name)} name={x.name} onOpen={onPeek} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p class="muted">Nothing unusual.</p>
              )}
            </div>
          </div>
          {m.ranking.length > 1 ? (
            <details class="disclosure">
              <summary>All {m.ranking.length} lists by overlap</summary>
              <ol class="plain">
                {m.ranking.map((r, i) => (
                  <li key={i}>
                    {r.name} ({r.archetype}): {r.overlapPercent}%
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </>
      )}
      {m && m.unresolved.length > 0 ? (
        <p class="dsec__foot">
          Some meta lines were not recognized:{' '}
          {m.unresolved
            .map((u) => `${u.list} (${u.issues.map((i) => i.text ?? i.reason).slice(0, 3).join(', ')})`)
            .join('; ')}
          .
        </p>
      ) : null}
    </Section>
  );
}
