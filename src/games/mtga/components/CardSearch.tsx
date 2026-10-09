/**
 * Island: Scryfall-style card search over the local Arena index (grindstone's searchCards in
 * the analyzer worker; no search request leaves the browser). The query, format and order live
 * in the URL hash, so a search can be bookmarked or shared.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import { int } from '../../../core/format.ts';
import { createHashCodec, field } from '../../../core/urlstate.ts';
import { IMAGE_CREDIT, IMAGE_SIZES, cardImageUrl } from '../lib/images.ts';
import { bytesText, progressText } from '../lib/view.ts';
import { AnalyzerError, analyzer } from '../worker/client.ts';
import { FORMAT_IDS, FORMAT_LABELS, type CardView, type FormatId, type SearchOrder, type SearchResult, type ShardUrls, type WorkerProgress } from '../worker/protocol.ts';
import CardPeek from './CardPeek.tsx';
import ManaCost from './ManaCost.tsx';
import { Busy, Notice, RarityTag } from './ui.tsx';

interface Props {
  shards: ShardUrls;
  snapshot: string;
  /** Download sizes (gzip bytes) of the two card shards, for the "loads once" note. */
  sizes: { standard: number; arena: number };
}

const ORDERS: readonly { id: SearchOrder; label: string }[] = [
  { id: 'name', label: 'Name' },
  { id: 'mv', label: 'Mana value' },
  { id: 'edhrec', label: 'Popularity' },
  { id: 'released', label: 'Newest' },
];

export const searchCodec = createHashCodec({
  version: 1,
  maxLength: 400,
  fields: {
    q: field.str('q', '', { maxLength: 300 }),
    format: field.enum('f', ['any', ...FORMAT_IDS] as const, 'standard'),
    order: field.enum('o', ['name', 'mv', 'edhrec', 'released'] as const, 'name'),
  },
});

const EXAMPLES: readonly { q: string; what: string }[] = [
  { q: 't:creature mv<=2 c:r', what: 'red creatures costing 2 or less' },
  { q: 'o:"draw a card" t:instant', what: 'instants that draw a card' },
  { q: 'id<=wu r:rare t:land', what: 'rare lands for a white-blue deck' },
  { q: 'kw:flying pow>=3', what: 'fliers with 3 or more power' },
  { q: 'is:commander id:g', what: 'possible green Brawl commanders' },
  { q: '"lightning" or "bolt"', what: 'either word in the name' },
];

const PAGE = 60;
const MAX = 200;

export default function CardSearch({ shards, snapshot, sizes }: Props) {
  const [query, setQuery] = useState('');
  const [format, setFormat] = useState<'any' | FormatId>('standard');
  const [order, setOrder] = useState<SearchOrder>('name');
  const [limit, setLimit] = useState(PAGE);
  const [res, setRes] = useState<SearchResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<WorkerProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [images, setImages] = useState(true);
  const [peek, setPeek] = useState<CardView | null>(null);
  const seq = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const ready = useRef(false);

  const search = async (q: string, f: 'any' | FormatId, o: SearchOrder, lim: number) => {
    const id = ++seq.current;
    if (!q.trim()) {
      setRes(null);
      setError(null);
      return;
    }
    setBusy(true);
    setError(null);
    const client = analyzer();
    const off = client.onProgress((p) => {
      if (id === seq.current) setProgress(p);
    });
    try {
      await client.init({ shards, snapshot });
      const r = await client.request('search', { query: q, format: f === 'any' ? null : f, order: o, limit: lim });
      if (id !== seq.current) return;
      setRes(r);
      const hash = searchCodec.encode({ q: q.trim(), format: f, order: o });
      if (hash !== window.location.hash) history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${hash}`);
    } catch (err) {
      if (id !== seq.current) return;
      setError(err instanceof AnalyzerError ? err.message : `Search failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      off();
      if (id === seq.current) {
        setBusy(false);
        setProgress(null);
      }
    }
  };

  useEffect(() => {
    const s = searchCodec.decode(window.location.hash);
    setQuery(s.q);
    setFormat(s.format);
    setOrder(s.order);
    ready.current = true;
    if (s.q) void search(s.q, s.format, s.order, PAGE);
    return () => clearTimeout(timer.current);
  }, []);

  // Typing searches after a short pause; format/order changes search at once.
  const schedule = (q: string, f: 'any' | FormatId, o: SearchOrder, delay: number) => {
    clearTimeout(timer.current);
    setLimit(PAGE);
    timer.current = setTimeout(() => void search(q, f, o, PAGE), delay);
  };

  const submit = (e: Event) => {
    e.preventDefault();
    clearTimeout(timer.current);
    setLimit(PAGE);
    void search(query, format, order, PAGE);
  };

  const more = () => {
    const next = Math.min(MAX, limit + PAGE);
    setLimit(next);
    void search(query, format, order, next);
  };

  return (
    <div class="csearch">
      <form class="card csearch__form" role="search" aria-label="Cards" onSubmit={submit}>
        <label class="field" for="card-q">
          <span class="field__label">Search Arena cards</span>
          <span class="field__hint" id="card-q-hint">
            Words match card names. Add filters like <code>t:creature</code>, <code>c:r</code>, <code>mv&lt;=2</code> or <code>o:"draw a card"</code>.
          </span>
        </label>
        <div class="csearch__bar">
          <input
            id="card-q"
            class="input csearch__input"
            type="search"
            autocomplete="off"
            spellcheck={false}
            aria-describedby="card-q-hint"
            placeholder="t:creature mv<=2 c:r"
            value={query}
            onInput={(e) => {
              const q = (e.target as HTMLInputElement).value;
              setQuery(q);
              if (ready.current) schedule(q, format, order, 350);
            }}
          />
          <button type="submit" class="btn btn--primary">
            Search
          </button>
        </div>
        <div class="csearch__opts">
          <label class="field field--inline" for="card-f">
            <span class="field__label">Legal in</span>
            <select
              id="card-f"
              class="input select"
              value={format}
              onChange={(e) => {
                const f = (e.target as HTMLSelectElement).value as 'any' | FormatId;
                setFormat(f);
                schedule(query, f, order, 0);
              }}
            >
              {FORMAT_IDS.map((f) => (
                <option key={f} value={f}>
                  {FORMAT_LABELS[f]}
                </option>
              ))}
              <option value="any">Any (every Arena card)</option>
            </select>
          </label>
          <label class="field field--inline" for="card-o">
            <span class="field__label">Sort by</span>
            <select
              id="card-o"
              class="input select"
              value={order}
              onChange={(e) => {
                const o = (e.target as HTMLSelectElement).value as SearchOrder;
                setOrder(o);
                schedule(query, format, o, 0);
              }}
            >
              {ORDERS.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label class="check">
            <input type="checkbox" checked={images} onChange={(e) => setImages((e.target as HTMLInputElement).checked)} />
            <span>Show card images</span>
          </label>
        </div>
        <details class="disclosure csearch__help">
          <summary>Search syntax and examples</summary>
          <ul class="csearch__examples">
            {EXAMPLES.map((x) => (
              <li key={x.q}>
                <button
                  type="button"
                  class="chip chip--small"
                  onClick={() => {
                    setQuery(x.q);
                    clearTimeout(timer.current);
                    setLimit(PAGE);
                    void search(x.q, format, order, PAGE);
                  }}
                >
                  <code>{x.q}</code>
                </button>{' '}
                <span class="muted">{x.what}</span>
              </li>
            ))}
          </ul>
          <dl class="syntax">
            <div>
              <dt>
                <code>t:</code> <code>o:</code> <code>kw:</code>
              </dt>
              <dd>type line, rules text, keyword</dd>
            </div>
            <div>
              <dt>
                <code>c:</code> <code>id:</code>
              </dt>
              <dd>colours (at least), colour identity (at most); letters W U B R G C, or names like boros</dd>
            </div>
            <div>
              <dt>
                <code>mv</code> <code>pow</code> <code>tou</code>
              </dt>
              <dd>
                mana value, power, toughness with <code>=</code> <code>&lt;</code> <code>&lt;=</code> <code>&gt;</code> <code>&gt;=</code>
              </dd>
            </div>
            <div>
              <dt>
                <code>r:</code> <code>f:</code> <code>is:</code>
              </dt>
              <dd>wildcard rarity, legal format, flags such as is:commander, is:mdfc, is:legendary</dd>
            </div>
            <div>
              <dt>
                <code>or</code> <code>( )</code> <code>-</code>
              </dt>
              <dd>either term, grouping, exclude</dd>
            </div>
          </dl>
        </details>
      </form>

      <div class="csearch__out" aria-busy={busy ? 'true' : 'false'}>
        {busy ? <Busy>{progressText(progress, 'Searching…')}</Busy> : null}
        {error ? (
          <Notice tone="error" title="Search failed">
            <p>{error}</p>
          </Notice>
        ) : null}
        {res?.error ? (
          <Notice tone="warning" title="That query could not be read">
            <p>{res.error}</p>
          </Notice>
        ) : null}
        {res && !res.error ? (
          <>
            <p class="csearch__count" role="status">
              {res.total === 0
                ? 'No cards match.'
                : res.total > res.cards.length
                  ? `Showing ${int(res.cards.length)} of ${int(res.total)} cards.`
                  : `${int(res.total)} ${res.total === 1 ? 'card' : 'cards'}.`}
            </p>
            {res.cards.length > 0 ? (
              <ul class={`cgrid${images ? '' : ' cgrid--text'}`}>
                {res.cards.map((c) => {
                  const src = images ? cardImageUrl(c.scryfallId, 'small') : null;
                  return (
                    <li key={c.oracleId} class="cgrid__item">
                      <button type="button" class="cgrid__btn" aria-haspopup="dialog" onClick={() => setPeek(c)}>
                        {images ? (
                          src ? (
                            <img class="cgrid__img" src={src} alt="" width={IMAGE_SIZES.small.width} height={IMAGE_SIZES.small.height} loading="lazy" decoding="async" referrerpolicy="no-referrer" />
                          ) : (
                            <span class="cgrid__noimg" aria-hidden="true" />
                          )
                        ) : null}
                        <span class="cgrid__text">
                          <span class="cgrid__name">{c.name}</span>
                          <span class="cgrid__type">{c.typeLine}</span>
                        </span>
                      </button>
                      <span class="cgrid__meta">
                        {c.manaCost ? <ManaCost cost={c.manaCost} /> : <span class="muted">no cost</span>}
                        <RarityTag rarity={c.rarity} short />
                      </span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {res.total > res.cards.length && limit < MAX ? (
              <button type="button" class="btn csearch__more" onClick={more} disabled={busy}>
                Show more
              </button>
            ) : null}
            {res.total > res.cards.length && limit >= MAX ? <p class="muted">Add filters to narrow the search; at most {MAX} cards are listed.</p> : null}
            {images && res.cards.length > 0 ? <p class="muted csearch__credit">{IMAGE_CREDIT} (cards.scryfall.io).</p> : null}
          </>
        ) : null}
        {!res && !busy && !error ? (
          <p class="muted csearch__idle">
            Type a search to begin. The first Standard search downloads {bytesText(sizes.standard)} of card data and "Any" downloads every Arena card ({bytesText(sizes.arena)}); both stay cached in this browser.
          </p>
        ) : null}
      </div>
      <CardPeek card={peek} onClose={() => setPeek(null)} />
    </div>
  );
}
