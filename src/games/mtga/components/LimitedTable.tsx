/**
 * Island: sortable, filterable 17Lands card ratings for one set and format. The server render is
 * the full table in the default order (usable without JS); hydration adds sorting, filters and
 * a shareable view in the URL hash. Card names open a dialog with the card image and every
 * number for that card.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { int } from '../../../core/format.ts';
import { IMAGE_CREDIT, IMAGE_SIZES, cardImageUrl, scryfallCardUrl } from '../lib/images.ts';
import {
  DEFAULT_DIR,
  LOW_SAMPLE,
  MIN_GAMES,
  averageGihWr,
  limitedCodec,
  normColors,
  normRarities,
  viewRows,
  wrBand,
  type LimitedRow,
  type LimitedView,
  type SortKey,
} from '../lib/limited.ts';
import type { Rarity } from '../worker/protocol.ts';
import { COLOR_NAME, RARITIES, RARITY_LABEL, RarityTag, pct01 } from './ui.tsx';

interface Props {
  rows: LimitedRow[];
  /** "HOB Premier Draft", for captions and the dialog. */
  label: string;
}

interface Column {
  key: SortKey;
  label: string;
  /** Spoken/long name used in the header's accessible name and the legend. */
  title: string;
  num?: boolean;
}

const COLUMNS: readonly Column[] = [
  { key: 'name', label: 'Card', title: 'Card name' },
  { key: 'gihWr', label: 'GIH WR', title: 'Win rate when the card was in hand (opening hand or drawn)', num: true },
  { key: 'ohWr', label: 'OH WR', title: 'Win rate when in the opening hand', num: true },
  { key: 'gdWr', label: 'GD WR', title: 'Win rate when drawn after the opening hand', num: true },
  { key: 'gnsWr', label: 'GNS WR', title: 'Win rate when in the deck but never seen', num: true },
  { key: 'iwd', label: 'IWD', title: 'Improvement when drawn: GIH WR minus GNS WR, in percentage points', num: true },
  { key: 'alsa', label: 'ALSA', title: 'Average pick number when last seen in a pack (lower = taken earlier)', num: true },
  { key: 'ata', label: 'ATA', title: 'Average pick number when taken (lower = taken earlier)', num: true },
  { key: 'gih', label: '# GIH', title: 'Games with the card in hand', num: true },
  { key: 'gpWr', label: 'GP WR', title: 'Win rate of decks that played the card', num: true },
];

const DEFAULT_VIEW: LimitedView = { sort: 'gihWr', dir: 'desc', colors: '', rarities: '', minGames: 0, query: '' };

const fixed = (v: number | null, digits: number) => (v === null || !Number.isFinite(v) ? '—' : v.toFixed(digits));
const signedPp = (v: number | null) => (v === null || !Number.isFinite(v) ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`);

function ColorCell({ colors }: { colors: string }) {
  if (!colors) return <span class="ltable__cl">Colourless</span>;
  return (
    <span class="pips" aria-label={[...colors].map((c) => COLOR_NAME[c as keyof typeof COLOR_NAME]).join(', ')}>
      {[...colors].map((c) => (
        <span key={c} class="pip" data-c={c} aria-hidden="true">
          {c}
        </span>
      ))}
    </span>
  );
}

export default function LimitedTable({ rows, label }: Props) {
  const [view, setView] = useState<LimitedView>(DEFAULT_VIEW);
  const [peek, setPeek] = useState<LimitedRow | null>(null);
  const hydrated = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const avg = useMemo(() => averageGihWr(rows), [rows]);
  const shown = useMemo(() => viewRows(rows, view), [rows, view]);

  useEffect(() => {
    const s = limitedCodec.decode(window.location.hash);
    setView({ ...s, colors: normColors(s.colors), rarities: normRarities(s.rarities) });
    hydrated.current = true;
  }, []);

  useEffect(() => {
    if (!hydrated.current) return;
    const hash = limitedCodec.encode(view);
    const next = hash === '#v=1' ? '' : hash;
    if (next !== window.location.hash && !(next === '' && window.location.hash === '')) {
      history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${next}`);
    }
  }, [view]);

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (peek && !d.open) d.showModal();
    if (!peek && d.open) d.close();
  }, [peek]);

  const sortBy = (key: SortKey) => setView((v) => ({ ...v, sort: key, dir: v.sort === key ? (v.dir === 'asc' ? 'desc' : 'asc') : DEFAULT_DIR[key] }));
  const toggleColor = (c: string) => setView((v) => ({ ...v, colors: normColors(v.colors.includes(c) ? v.colors.replace(c, '') : v.colors + c) }));
  const toggleRarity = (r: Rarity) => {
    const ch = r[0] ?? '';
    setView((v) => ({ ...v, rarities: normRarities(v.rarities.includes(ch) ? v.rarities.replace(ch, '') : v.rarities + ch) }));
  };
  const filtered = view.colors !== '' || view.rarities !== '' || view.minGames > 0 || view.query !== '';

  return (
    <div class="ltable">
      <div class="ltable__filters card" role="group" aria-label="Filter cards">
        <div class="ltable__frow">
          <span class="ltable__flabel" id="lt-colors">
            Castable in
          </span>
          <div class="cluster" role="group" aria-labelledby="lt-colors">
            {[...'WUBRG'].map((c) => (
              <button key={c} type="button" class="chip chip--small chip--color" aria-pressed={view.colors.includes(c)} onClick={() => toggleColor(c)}>
                <span class="pip" data-c={c} aria-hidden="true">
                  {c}
                </span>
                {COLOR_NAME[c as keyof typeof COLOR_NAME]}
              </button>
            ))}
          </div>
        </div>
        <div class="ltable__frow">
          <span class="ltable__flabel" id="lt-rarity">
            Rarity
          </span>
          <div class="cluster" role="group" aria-labelledby="lt-rarity">
            {RARITIES.map((r) => (
              <button key={r} type="button" class="chip chip--small" aria-pressed={view.rarities.includes(r[0] ?? '')} onClick={() => toggleRarity(r)}>
                <span class={`gem gem--${r}`} aria-hidden="true" />
                {RARITY_LABEL[r]}
              </button>
            ))}
          </div>
        </div>
        <div class="ltable__frow ltable__frow--inputs">
          <label class="field field--inline" for="lt-min">
            <span class="field__label">Min. games in hand</span>
            <select id="lt-min" class="input select" value={String(view.minGames)} onChange={(e) => setView((v) => ({ ...v, minGames: Number((e.target as HTMLSelectElement).value) }))}>
              {MIN_GAMES.map((m) => (
                <option key={m} value={String(m)}>
                  {m === 0 ? 'Any' : int(m)}
                </option>
              ))}
            </select>
          </label>
          <label class="field field--inline" for="lt-q">
            <span class="field__label">Name</span>
            <input id="lt-q" class="input" type="search" autocomplete="off" value={view.query} onInput={(e) => setView((v) => ({ ...v, query: (e.target as HTMLInputElement).value.slice(0, 60) }))} />
          </label>
          {filtered ? (
            <button type="button" class="btn btn--ghost" onClick={() => setView((v) => ({ ...DEFAULT_VIEW, sort: v.sort, dir: v.dir }))}>
              Clear filters
            </button>
          ) : null}
        </div>
        <p class="ltable__count" role="status">
          {shown.length === rows.length ? `${int(rows.length)} cards` : `${int(shown.length)} of ${int(rows.length)} cards`}
          {avg !== null ? ` · average GIH WR ${pct01(avg)}` : ''}
        </p>
      </div>

      <div class="tablewrap ltable__wrap" tabindex={0} aria-label={`${label} card ratings (scrolls sideways)`}>
        <table class="mtable ltable__table">
          <caption class="visually-hidden">
            {label} card ratings, sorted by {COLUMNS.find((c) => c.key === view.sort)?.title} ({view.dir === 'asc' ? 'ascending' : 'descending'})
          </caption>
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  class={`${c.num ? 'num' : ''}${c.key === 'name' ? ' ltable__namecol' : ''}`}
                  aria-sort={view.sort === c.key ? (view.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  <button type="button" class="sortbtn" onClick={() => sortBy(c.key)} title={c.title}>
                    {c.label}
                    <span class="sortbtn__icon" aria-hidden="true">
                      {view.sort === c.key ? (view.dir === 'asc' ? '▲' : '▼') : '↕'}
                    </span>
                    <span class="visually-hidden">: {c.title}</span>
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const low = r.gih < LOW_SAMPLE;
              return (
                <tr key={r.name} class={low ? 'is-low' : undefined}>
                  <th scope="row" class="ltable__namecol">
                    <button type="button" class="cardref ltable__name" aria-haspopup="dialog" onClick={() => setPeek(r)}>
                      {r.name}
                    </button>
                    <span class="ltable__meta">
                      <ColorCell colors={r.colors} />
                      <span class="ltable__rar">
                        <span class={`gem gem--${r.rarity}`} aria-hidden="true" />
                        {RARITY_LABEL[r.rarity]}
                      </span>
                      {low ? <span class="badge badge--warning ltable__low">low sample</span> : null}
                    </span>
                  </th>
                  <td class="num wr" data-band={wrBand(r.gihWr, avg)}>
                    {pct01(r.gihWr)}
                  </td>
                  <td class="num">{pct01(r.ohWr)}</td>
                  <td class="num">{pct01(r.gdWr)}</td>
                  <td class="num">{pct01(r.gnsWr)}</td>
                  <td class="num">{signedPp(r.iwd)}</td>
                  <td class="num">{fixed(r.alsa, 2)}</td>
                  <td class="num">{fixed(r.ata, 2)}</td>
                  <td class="num">{int(r.gih)}</td>
                  <td class="num">{pct01(r.gpWr)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {shown.length === 0 ? <p class="ltable__none muted">No card matches these filters.</p> : null}
      </div>

      <dialog ref={dialog} class="peek" aria-labelledby="lpeek-title" onClose={() => setPeek(null)} onClick={(e) => e.target === dialog.current && dialog.current?.close()}>
        {peek ? (
          <div class="peek__inner">
            <header class="peek__head">
              <h2 id="lpeek-title" class="peek__title">
                {peek.name}
              </h2>
              <button type="button" class="btn btn--ghost btn--icon" onClick={() => dialog.current?.close()} aria-label="Close card details">
                <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                  <path d="M6 6l12 12M18 6 6 18" />
                </svg>
              </button>
            </header>
            <div class="peek__body">
              {cardImageUrl(peek.scryfallId) ? (
                <figure class="peek__figure">
                  <img class="peek__img" src={cardImageUrl(peek.scryfallId) ?? ''} width={IMAGE_SIZES.normal.width} height={IMAGE_SIZES.normal.height} alt={`Card image of ${peek.name}`} decoding="async" referrerpolicy="no-referrer" />
                  <figcaption class="peek__credit">{IMAGE_CREDIT}</figcaption>
                </figure>
              ) : (
                <p class="peek__noimg muted">No image for this card in the card index.</p>
              )}
              <div class="peek__text">
                <p class="peek__line">
                  <ColorCell colors={peek.colors} /> <RarityTag rarity={peek.rarity} />
                </p>
                <dl class="peek__facts peek__facts--grid">
                  {COLUMNS.filter((c) => c.num).map((c) => (
                    <div key={c.key}>
                      <dt>{c.label}</dt>
                      <dd>
                        {c.key === 'iwd' ? `${signedPp(peek.iwd)} pp` : c.key === 'alsa' || c.key === 'ata' ? fixed(peek[c.key], 2) : c.key === 'gih' ? int(peek.gih) : pct01(peek[c.key] as number | null)}
                      </dd>
                    </div>
                  ))}
                  <div>
                    <dt># GP</dt>
                    <dd>{int(peek.gp)}</dd>
                  </div>
                </dl>
                {peek.gihWr !== null && avg !== null ? (
                  <p class="muted">
                    GIH WR is {Math.abs((peek.gihWr - avg) * 100).toFixed(1)} points {peek.gihWr >= avg ? 'above' : 'below'} the set average of {pct01(avg)}
                    {peek.gih < LOW_SAMPLE ? ', from a small sample' : ''}.
                  </p>
                ) : null}
                <p>
                  <a href={scryfallCardUrl(peek.set, peek.cn, peek.name)} rel="noopener" target="_blank">
                    View on Scryfall<span class="visually-hidden"> (opens in a new tab)</span>
                  </a>
                </p>
              </div>
            </div>
          </div>
        ) : null}
      </dialog>
    </div>
  );
}
