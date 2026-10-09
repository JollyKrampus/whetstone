/**
 * Island: the /mtga/deck/ analyzer. Paste an Arena export, and the analyzer worker (grindstone's
 * core over the staged card shards) answers with legality in every Arena format, curve, mana,
 * roles, power tier, hands, wildcard cost, upgrades and a meta comparison.
 *
 * The deck travels in the URL hash (lib/share.ts), so a shared link opens straight into the
 * same analysis; nothing is sent to a server. The server render is the empty paste form, so the
 * page is usable as soon as it hydrates.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import CopyButton from '../../../components/CopyButton.tsx';
import ShareButton from '../../../components/ShareButton.tsx';
import { createStore } from '../../../core/storage.ts';
import { MY_LISTS_KEY, curatedSelection, validateMyLists, type CuratedSnapshotView, type MyList } from '../lib/metaLists.ts';
import { deckHash, readDeckHash } from '../lib/share.ts';
import { isMetaChoice, metaByFormat, nameIn, progressText, replaceName, type MetaChoice } from '../lib/view.ts';
import { AnalyzerError, analyzer } from '../worker/client.ts';
import {
  FORMAT_IDS,
  FORMAT_LABELS,
  type AnalyzeResult,
  type CardView,
  type FormatId,
  type ShardUrls,
  type WorkerProgress,
} from '../worker/protocol.ts';
import CardPeek from './CardPeek.tsx';
import { Hands } from './deck/Hands.tsx';
import { DeckList, Curve, Legality, Mana, MetaCompare, Power, Wildcards } from './deck/sections.tsx';
import { Upgrades } from './deck/Upgrades.tsx';
import { Busy, Notice, plural } from './ui.tsx';

export interface DeckAnalyzerProps {
  shards: ShardUrls;
  /** Scryfall snapshot id the shards were built from (IndexedDB cache key). */
  snapshot: string;
  /** Curated snapshots by format (example-only snapshots are never used as meta). */
  curated: CuratedSnapshotView[];
  /** A deck to try, from the curated examples; null when there is none. */
  sample: { name: string; text: string } | null;
  metaHref: string;
}

type FormatChoice = 'auto' | FormatId;
type Phase = 'idle' | 'working' | 'done' | 'error';

const store = createStore('mtga');
const META_CHOICE_KEY = 'metaChoice';
const validChoice = (v: unknown): MetaChoice | undefined => (isMetaChoice(v) ? v : undefined);

function randomSeed(): number {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return (buf[0] ?? 1) || 1;
}

export default function DeckAnalyzer({ shards, snapshot, curated, sample, metaHref }: DeckAnalyzerProps) {
  const [text, setText] = useState('');
  const [format, setFormat] = useState<FormatChoice>('auto');
  const [fuzzy, setFuzzy] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<WorkerProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AnalyzeResult | null>(null);
  const [seed, setSeed] = useState(0);
  const [undo, setUndo] = useState<string[]>([]);
  const [peek, setPeek] = useState<CardView | null>(null);
  const [myLists, setMyLists] = useState<MyList[]>([]);
  const [metaChoice, setMetaChoice] = useState<MetaChoice>('auto');
  const [editing, setEditing] = useState(true);
  const runId = useRef(0);
  const resultsRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Visitor's saved meta lists and meta choice (and later edits from the Meta page in another tab).
  useEffect(() => {
    setMyLists(store.get(MY_LISTS_KEY, [], validateMyLists));
    setMetaChoice(store.get(META_CHOICE_KEY, 'auto', validChoice));
    return store.subscribe(MY_LISTS_KEY, (v) => setMyLists(validateMyLists(v) ?? []));
  }, []);

  const writeHash = useCallback(async (deckText: string, fmt: FormatChoice, handSeed: number) => {
    try {
      const hash = await deckHash({ text: deckText, format: fmt === 'auto' ? null : fmt, seed: handSeed });
      if (hash !== window.location.hash) history.replaceState(history.state, '', `${window.location.pathname}${window.location.search}${hash}`);
    } catch {
      // A link that cannot be written only costs sharing; the analysis is still shown.
    }
  }, []);

  const run = useCallback(
    async (deckText: string, fmt: FormatChoice, choice: MetaChoice, lists: readonly MyList[], opts: { seed?: number; scroll?: boolean } = {}) => {
      const id = ++runId.current;
      if (!deckText.trim()) {
        setError('Paste an Arena export first: a "Deck" line followed by lines like "4 Lightning Strike".');
        setPhase('error');
        return;
      }
      setPhase('working');
      setError(null);
      setProgress(null);
      const client = analyzer();
      const off = client.onProgress((p) => {
        if (id === runId.current) setProgress(p);
      });
      try {
        await client.init({ shards, snapshot });
        const res = await client.request('analyze', {
          text: deckText,
          format: fmt === 'auto' ? null : fmt,
          meta: null,
          metaByFormat: metaByFormat(choice, lists, curated),
          fuzzy,
        });
        if (id !== runId.current) return;
        setResult(res);
        setPhase('done');
        setEditing(false);
        // Share the canonical list when every line resolved (shorter, no set codes); else the paste.
        const handSeed = opts.seed ?? 0;
        void writeHash(res.issues.length === 0 ? res.arenaText : deckText, fmt, handSeed);
        if (opts.scroll !== false) {
          requestAnimationFrame(() => {
            const h = resultsRef.current?.querySelector<HTMLElement>('#deck-summary-title');
            h?.focus({ preventScroll: true });
            resultsRef.current?.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
          });
        }
      } catch (err) {
        if (id !== runId.current) return;
        setError(err instanceof AnalyzerError ? err.message : `The analyzer failed: ${err instanceof Error ? err.message : String(err)}`);
        setPhase('error');
      } finally {
        off();
      }
    },
    [shards, snapshot, curated, fuzzy, writeHash],
  );

  // A shared link (or a new hash pasted into the address bar) opens straight into its analysis.
  useEffect(() => {
    const load = async () => {
      const shared = await readDeckHash(window.location.hash);
      if (!shared) return;
      const fmt: FormatChoice = shared.format ?? 'auto';
      setText(shared.text);
      setFormat(fmt);
      setSeed(shared.seed);
      setUndo([]);
      void run(shared.text, fmt, store.get(META_CHOICE_KEY, 'auto', validChoice), store.get(MY_LISTS_KEY, [], validateMyLists), { seed: shared.seed, scroll: false });
    };
    void load();
    const onHash = () => void load();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
    // Mount only: later runs are user-driven.
  }, []);

  const analyze = (e?: Event) => {
    e?.preventDefault();
    setUndo([]);
    setSeed(0);
    void run(text, format, metaChoice, myLists);
  };

  const reanalyze = (next: { text?: string; format?: FormatChoice; choice?: MetaChoice; keepUndo?: boolean }) => {
    const t = next.text ?? text;
    const f = next.format ?? format;
    const c = next.choice ?? metaChoice;
    if (next.text !== undefined) setText(t);
    if (next.format !== undefined) setFormat(f);
    if (next.choice !== undefined) {
      setMetaChoice(c);
      store.set(META_CHOICE_KEY, c);
    }
    void run(t, f, c, myLists, { seed, scroll: false });
  };

  const applyDeck = (nextText: string) => {
    setUndo((u) => [...u.slice(-9), result?.arenaText ?? text]);
    setSeed(0);
    reanalyze({ text: nextText });
  };

  const undoApply = () => {
    const prev = undo[undo.length - 1];
    if (prev === undefined) return;
    setUndo((u) => u.slice(0, -1));
    setSeed(0);
    reanalyze({ text: prev });
  };

  const onSeed = (s: number) => {
    setSeed(s);
    if (result) void writeHash(result.issues.length === 0 ? result.arenaText : text, format, s);
  };

  const loadFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 200_000) {
      setError('That file is too large to be a deck list.');
      setPhase('error');
      return;
    }
    setText((await file.text()).replace(/\r\n/g, '\n'));
    textRef.current?.focus();
  };

  const replaceLine = (line: number | undefined, wrong: string | undefined, right: string) => {
    if (!wrong) return;
    const next = replaceName(text, line, wrong, right);
    if (next !== null) reanalyze({ text: next });
  };

  const counts = useMemo(() => ({ mine: (f: FormatId) => myLists.filter((l) => l.format === f).length }), [myLists]);
  const curatedCount = (f: FormatId) => curatedSelection(curated.find((s) => s.format === f))?.lists.length ?? 0;
  const working = phase === 'working';

  return (
    <div class={`analyzer${result ? ' analyzer--has-result' : ''}`}>
      <div class="analyzer__input">
        <form class="card paste" onSubmit={analyze} aria-labelledby="paste-title" data-collapsed={result && !editing ? 'true' : undefined}>
          <div class="paste__head">
            <h2 id="paste-title" class="paste__title">
              Your deck
            </h2>
            {result && !editing ? (
              <button type="button" class="btn btn--ghost paste__edit" aria-expanded="false" aria-controls="deck-text-wrap" onClick={() => setEditing(true)}>
                Edit list
              </button>
            ) : null}
          </div>
          <div id="deck-text-wrap" class="paste__body">
            <label class="field" for="deck-text">
              <span class="field__label">Arena export</span>
              <span class="field__hint" id="deck-text-hint">
                In MTG Arena open the deck and choose Export, then paste here. Set codes are optional; one card per line.
              </span>
            </label>
            <textarea
              id="deck-text"
              ref={textRef}
              class="input paste__text"
              rows={14}
              spellcheck={false}
              autocomplete="off"
              aria-describedby="deck-text-hint"
              placeholder={'Deck\n4 Lightning Strike\n4 Heartfire Hero\n20 Mountain\n\nSideboard\n2 Abrade'}
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
            />
            <div class="paste__row">
              <label class="field field--inline" for="deck-format">
                <span class="field__label">Format</span>
                <select id="deck-format" class="input select" value={format} onChange={(e) => setFormat((e.target as HTMLSelectElement).value as FormatChoice)}>
                  <option value="auto">Detect automatically</option>
                  {FORMAT_IDS.map((f) => (
                    <option key={f} value={f}>
                      {FORMAT_LABELS[f]}
                    </option>
                  ))}
                </select>
              </label>
              <label class="check">
                <input type="checkbox" checked={fuzzy} onChange={(e) => setFuzzy((e.target as HTMLInputElement).checked)} />
                <span>
                  Ask Scryfall about names this site doesn't know
                  <span class="check__hint">Sends only those names to api.scryfall.com.</span>
                </span>
              </label>
            </div>
            <div class="paste__actions">
              <button type="submit" class="btn btn--primary" disabled={working}>
                {working ? 'Analyzing…' : 'Analyze deck'}
              </button>
              {sample ? (
                <button
                  type="button"
                  class="btn"
                  disabled={working}
                  onClick={() => {
                    setText(sample.text);
                    setFormat('auto');
                    setUndo([]);
                    setSeed(0);
                    void run(sample.text, 'auto', metaChoice, myLists);
                  }}
                >
                  Try a sample deck
                </button>
              ) : null}
              <button type="button" class="btn btn--ghost" onClick={() => fileRef.current?.click()}>
                Open a .txt file
              </button>
              <input ref={fileRef} type="file" accept=".txt,text/plain" class="visually-hidden" tabindex={-1} aria-hidden="true" onChange={loadFile} />
            </div>
          </div>
          {result && !editing ? (
            <p class="paste__summary">
              {result.name ? <strong>{result.name}</strong> : 'Pasted deck'} · {plural(result.counts.main, 'card')}
              {result.counts.side ? ` + ${result.counts.side} sideboard` : ''} · {result.autoFormat ? `${FORMAT_LABELS[result.format]} (detected)` : FORMAT_LABELS[result.format]}
            </p>
          ) : null}
        </form>
        <p class="analyzer__privacy muted">
          Analysis runs in your browser. The deck is only stored in this page's link, after the <code>#</code>, which is never sent to a
          server.
        </p>
      </div>

      <div class="analyzer__out" ref={resultsRef} aria-busy={working ? 'true' : 'false'}>
        {working ? <Busy>{progressText(progress)}</Busy> : null}
        {phase === 'error' && error ? (
          <Notice tone="error" title="Could not analyze this deck">
            <p>{error}</p>
          </Notice>
        ) : null}
        {!result && !working && phase !== 'error' ? (
          <div class="analyzer__empty card">
            <h2 class="analyzer__empty-title">What you get</h2>
            <ul class="ticks">
              <li>Legality in Standard, Pioneer, Historic, Timeless, Brawl and Standard Brawl at once</li>
              <li>Mana curve, colour sources against Karsten's targets, and tapped lands</li>
              <li>A power tier with the reasons behind each part of the score</li>
              <li>Sample opening hands and a mulligan simulation you can share</li>
              <li>Wildcards to craft it, and budget upgrades you can apply or undo</li>
              <li>How close it is to the meta lists you choose</li>
            </ul>
          </div>
        ) : null}
        {result ? (
          <div class={`results${working ? ' is-stale' : ''}`}>
            <section class="dsec card summary" aria-labelledby="deck-summary-title">
              <div class="summary__top">
                <div class="summary__id">
                  <p class="kicker">{result.autoFormat ? `${FORMAT_LABELS[result.format]} · detected` : FORMAT_LABELS[result.format]}</p>
                  <h2 id="deck-summary-title" class="summary__name" tabindex={-1}>
                    {result.name ?? 'Your deck'}
                  </h2>
                  <p class="summary__meta">
                    {plural(result.counts.main, 'card')} main{result.counts.side ? ` · ${result.counts.side} sideboard` : ''}
                    {result.commander ? ` · commander ${result.commander.name}` : ''} · card data of {result.asOf}
                  </p>
                </div>
                <a class="summary__tier" href="#deck-power" data-tier={result.power.tier} onClick={(e) => jumpTo(e, 'deck-power')}>
                  <span class="summary__tier-num">
                    <span class="visually-hidden">Power tier </span>
                    {result.power.tier}
                  </span>
                  <span class="summary__tier-label">
                    {result.power.label}
                    <span class="summary__tier-score">{result.power.score.toFixed(0)}/100</span>
                  </span>
                </a>
              </div>
              <ul class="summary__pills" aria-label="Legality by format">
                {result.legality.map((l) => (
                  <li key={l.format} class={`lpill lpill--${l.legal ? 'ok' : 'no'}`}>
                    <span aria-hidden="true">{l.legal ? '✓' : '✕'}</span> {l.label}
                    <span class="visually-hidden">{l.legal ? ': legal' : ': not legal'}</span>
                  </li>
                ))}
              </ul>
              <div class="summary__actions">
                <CopyButton text={result.arenaText} label="Copy for Arena" copiedLabel="Copied" />
                <ShareButton title={result.name ?? 'MTG Arena deck'} label="Share link" />
                {undo.length > 0 ? (
                  <button type="button" class="btn" onClick={undoApply} disabled={working}>
                    Undo upgrade
                  </button>
                ) : null}
              </div>
              {result.issues.length > 0 ? (
                <Notice tone="warning" title={`${plural(result.issues.length, 'line')} not recognized`}>
                  <ul class="issues">
                    {result.issues.map((i, k) => (
                      <li key={k}>
                        {i.line ? <span class="issues__line">Line {i.line}: </span> : null}
                        <span class="issues__text">{i.text ?? ''}</span> {i.reason}
                        {i.suggestions && i.suggestions.length > 0 ? (
                          <span class="issues__fix">
                            {' '}
                            Did you mean{' '}
                            {i.suggestions.slice(0, 3).map((s) => (
                              <button key={s} type="button" class="chip chip--small" onClick={() => replaceLine(i.line, nameIn(i.text), s)}>
                                {s}
                              </button>
                            ))}
                            ?
                          </span>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                  {!fuzzy ? <p class="issues__tip">Tip: tick "Ask Scryfall about names this site doesn't know" and analyze again to fix misspellings.</p> : null}
                </Notice>
              ) : null}
              <nav class="jump" aria-label="Analysis sections">
                <ul>
                  {[
                    ['deck-legality', 'Legality'],
                    ['deck-power', 'Power'],
                    ['deck-curve', 'Curve'],
                    ['deck-mana', 'Mana'],
                    ['deck-list', 'Roles'],
                    ['deck-hands', 'Hands'],
                    ['deck-wildcards', 'Wildcards'],
                    ['deck-upgrades', 'Upgrades'],
                    ['deck-meta', 'Meta'],
                  ].map(([id, label]) => (
                    <li key={id}>
                      <a href={`#${id}`} onClick={(e) => jumpTo(e, id as string)}>
                        {label}
                      </a>
                    </li>
                  ))}
                </ul>
              </nav>
            </section>

            <Legality result={result} onFormat={(f) => reanalyze({ format: f })} busy={working} />
            <Power result={result} onAddMeta={() => jumpTo(null, 'deck-meta')} />
            <Curve result={result} />
            <Mana result={result} />
            <DeckList result={result} onPeek={setPeek} />
            <Hands key={`h-${result.arenaText}`} result={result} seed={seed} onSeed={onSeed} newSeed={randomSeed} onPeek={setPeek} />
            <Wildcards result={result} onPeek={setPeek} />
            <Upgrades key={`u-${result.arenaText}-${result.format}`} result={result} meta={result.meta ? (metaByFormat(metaChoice, myLists, curated)[result.format] ?? null) : null} onApply={applyDeck} onPeek={setPeek} busy={working} />
            <MetaCompare
              result={result}
              choice={metaChoice}
              onChoice={(c) => reanalyze({ choice: c })}
              available={{ mine: counts.mine(result.format), curated: curatedCount(result.format) }}
              metaHref={metaHref}
              onPeek={setPeek}
            />
            <p class="results__foot muted">Anyone who opens the share link sees this deck, format and sample hand.</p>
          </div>
        ) : null}
      </div>
      <CardPeek card={peek} onClose={() => setPeek(null)} />
    </div>
  );
}

function jumpTo(e: Event | null, id: string): void {
  const el = document.getElementById(id);
  if (!el) return;
  e?.preventDefault();
  el.scrollIntoView({ block: 'start', behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  el.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
}
