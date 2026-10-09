/**
 * Island: "bring your own meta". Visitors save decklists per format in their own browser
 * (localStorage), check them against the card data, and import or export them as grindstone
 * snapshot JSON. The deck analyzer compares decks with these lists and uses them to score card
 * quality. Nothing leaves the browser.
 */
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import CopyButton from '../../../components/CopyButton.tsx';
import { createStore } from '../../../core/storage.ts';
import { MAX_LISTS, MY_LISTS_KEY, fromSnapshot, newListId, percentInput, sanitizeList, toSnapshot, validateMyLists, type CuratedDeck, type MyList } from '../lib/metaLists.ts';
import { deckHash } from '../lib/share.ts';
import { progressText } from '../lib/view.ts';
import { AnalyzerError, analyzer } from '../worker/client.ts';
import { FORMAT_IDS, FORMAT_LABELS, type FormatId, type ListCheck, type ShardUrls, type WorkerProgress } from '../worker/protocol.ts';
import { Busy, ColorPip, Notice, pct01, plural } from './ui.tsx';

interface Props {
  shards: ShardUrls;
  snapshot: string;
  /** Deck analyzer URL (lists open there through a share hash). */
  deckHref: string;
  /** Curated example decks a visitor may copy to try the flow. */
  examples: { format: FormatId; decks: CuratedDeck[] }[];
}

const store = createStore('mtga');

interface Draft {
  id: string | null;
  format: FormatId;
  name: string;
  archetype: string;
  share: string;
  winRate: string;
  sourceUrl: string;
  list: string;
}

const EMPTY: Draft = { id: null, format: 'standard', name: '', archetype: '', share: '', winRate: '', sourceUrl: '', list: '' };

const today = () => new Date().toISOString().slice(0, 10);

function download(name: string, json: unknown): void {
  const blob = new Blob([`${JSON.stringify(json, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function MetaManager({ shards, snapshot, deckHref, examples }: Props) {
  const [lists, setLists] = useState<MyList[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [formError, setFormError] = useState<string | null>(null);
  const [checks, setChecks] = useState<Record<string, ListCheck>>({});
  const [checking, setChecking] = useState(false);
  const [progress, setProgress] = useState<WorkerProgress | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [importText, setImportText] = useState('');
  const [importMsg, setImportMsg] = useState<{ tone: 'info' | 'warning' | 'error'; text: string; errors: string[] } | null>(null);
  const [removed, setRemoved] = useState<{ list: MyList; index: number } | null>(null);
  const [persistent, setPersistent] = useState(true);
  const formRef = useRef<HTMLFormElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLists(store.get(MY_LISTS_KEY, [], validateMyLists));
    setPersistent(store.persistent);
    setLoaded(true);
    return store.subscribe(MY_LISTS_KEY, (v) => setLists(validateMyLists(v) ?? []));
  }, []);

  const save = (next: MyList[]) => {
    setLists(next);
    if (!store.set(MY_LISTS_KEY, next)) setPersistent(false);
  };

  const check = async (targets: MyList[]) => {
    if (targets.length === 0) return;
    setChecking(true);
    setCheckError(null);
    const client = analyzer();
    const off = client.onProgress(setProgress);
    try {
      await client.init({ shards, snapshot });
      const res = await client.request('checkLists', { lists: targets.map((l) => ({ list: l.list, format: l.format })) });
      setChecks((prev) => {
        const next = { ...prev };
        targets.forEach((l, i) => {
          if (res[i]) next[l.id] = res[i];
        });
        return next;
      });
    } catch (err) {
      setCheckError(err instanceof AnalyzerError ? err.message : String(err));
    } finally {
      off();
      setChecking(false);
      setProgress(null);
    }
  };

  const submit = (e: Event) => {
    e.preventDefault();
    setFormError(null);
    if (!draft.list.trim()) {
      setFormError('Paste the decklist (an Arena export) first.');
      return;
    }
    if (!draft.id && lists.length >= MAX_LISTS) {
      setFormError(`You can keep up to ${MAX_LISTS} lists. Delete some first.`);
      return;
    }
    const share = percentInput(draft.share);
    const wr = percentInput(draft.winRate);
    if (draft.share.trim() !== '' && share === undefined) {
      setFormError('Meta share must be a percentage between 0 and 100.');
      return;
    }
    if (draft.winRate.trim() !== '' && wr === undefined) {
      setFormError('Win rate must be a percentage between 0 and 100.');
      return;
    }
    const existing = draft.id ? lists.find((l) => l.id === draft.id) : undefined;
    const l = sanitizeList({
      id: draft.id ?? newListId(lists, Date.now()),
      format: draft.format,
      name: draft.name,
      archetype: draft.archetype,
      list: draft.list,
      sourceUrl: draft.sourceUrl,
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      ...(share !== undefined ? { metaShare: share } : {}),
      ...(wr !== undefined ? { winRate: wr } : {}),
    });
    if (!l) {
      setFormError('That list could not be saved. Check the format and the decklist.');
      return;
    }
    if (draft.sourceUrl.trim() && !l.sourceUrl) {
      setFormError('The source link must start with https:// or http://.');
      return;
    }
    save(existing ? lists.map((x) => (x.id === l.id ? l : x)) : [...lists, l]);
    setDraft({ ...EMPTY, format: draft.format });
    void check([l]);
  };

  const edit = (l: MyList) => {
    setDraft({
      id: l.id,
      format: l.format,
      name: l.name,
      archetype: l.archetype ?? '',
      share: l.metaShare !== undefined ? String(Math.round(l.metaShare * 1000) / 10) : '',
      winRate: l.winRate !== undefined ? String(Math.round(l.winRate * 1000) / 10) : '',
      sourceUrl: l.sourceUrl ?? '',
      list: l.list,
    });
    formRef.current?.scrollIntoView({ block: 'start' });
    formRef.current?.querySelector<HTMLElement>('select, input, textarea')?.focus({ preventScroll: true });
  };

  const remove = (l: MyList) => {
    const index = lists.findIndex((x) => x.id === l.id);
    save(lists.filter((x) => x.id !== l.id));
    setRemoved({ list: l, index });
  };

  const undoRemove = () => {
    if (!removed) return;
    const next = [...lists];
    next.splice(Math.min(removed.index, next.length), 0, removed.list);
    save(next);
    setRemoved(null);
  };

  const importFrom = (raw: string) => {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      setImportMsg({ tone: 'error', text: 'That is not valid JSON. Paste a snapshot like the export below produces.', errors: [] });
      return;
    }
    const r = fromSnapshot(json, new Date(), lists);
    const room = Math.max(0, MAX_LISTS - lists.length);
    const added = r.lists.slice(0, room);
    if (added.length > 0) save([...lists, ...added]);
    const dropped = r.lists.length - added.length;
    setImportMsg({
      tone: r.errors.length || dropped ? 'warning' : 'info',
      text: `Imported ${plural(added.length, 'list')}${dropped ? `; ${dropped} skipped (limit ${MAX_LISTS})` : ''}.`,
      errors: r.errors,
    });
    if (added.length) {
      setImportText('');
      void check(added);
    }
  };

  const onFile = async (e: Event) => {
    const input = e.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    if (file.size > 2_000_000) {
      setImportMsg({ tone: 'error', text: 'That file is too large for a snapshot.', errors: [] });
      return;
    }
    importFrom(await file.text());
  };

  const copyExamples = () => {
    const now = new Date();
    const add: MyList[] = [];
    for (const ex of examples) {
      for (const d of ex.decks) {
        if (lists.some((l) => l.list === d.list && l.format === ex.format)) continue;
        const l = sanitizeList({ ...d, name: d.name ?? d.archetype ?? 'Example list', format: ex.format, id: newListId([...lists, ...add], now.getTime() + add.length), addedAt: now.toISOString() });
        if (l) add.push(l);
      }
    }
    if (add.length) {
      save([...lists, ...add].slice(0, MAX_LISTS));
      void check(add);
    }
    setImportMsg({ tone: 'info', text: add.length ? `Copied ${plural(add.length, 'example list')} to your lists.` : 'The example lists are already in your lists.', errors: [] });
  };

  const openInAnalyzer = async (l: MyList) => {
    const hash = await deckHash({ text: l.list, format: l.format, seed: 0 });
    window.location.assign(`${deckHref}${hash}`);
  };

  const byFormat = useMemo(() => FORMAT_IDS.map((f) => ({ format: f, lists: lists.filter((l) => l.format === f) })).filter((g) => g.lists.length > 0), [lists]);
  const exampleCount = examples.reduce((n, e) => n + e.decks.length, 0);

  return (
    <div class="mymeta">
      {!persistent ? (
        <Notice tone="warning" title="Lists are not being saved">
          <p>This browser blocks site storage, so your lists last only until you close the page. Export them to keep a copy.</p>
        </Notice>
      ) : null}

      <section class="mymeta__lists" aria-labelledby="mylists-title">
        <div class="mymeta__head">
          <h2 id="mylists-title">My meta lists</h2>
          <p class="muted">{loaded ? `${plural(lists.length, 'list')} saved in this browser` : 'Loading your lists…'}</p>
        </div>
        {removed ? (
          <p class="undo" role="status">
            Deleted "{removed.list.name}".{' '}
            <button type="button" class="btn btn--ghost btn--tiny" onClick={undoRemove}>
              Undo
            </button>
          </p>
        ) : null}
        {checking ? <Busy>{progressText(progress, 'Checking lists against the card data…')}</Busy> : null}
        {checkError ? (
          <Notice tone="error" title="Could not check the lists">
            <p>{checkError}</p>
          </Notice>
        ) : null}
        {loaded && lists.length === 0 ? (
          <div class="mymeta__empty card">
            <p>
              No lists yet. Add the decks you keep meeting on the ladder, or lists from a tournament report you trust, with their meta share and win
              rate if the source gives them. The analyzer then shows how close your deck is to each one and scores card quality from what these
              decks play.
            </p>
            {exampleCount > 0 ? (
              <p>
                <button type="button" class="btn" onClick={copyExamples}>
                  Copy the {plural(exampleCount, 'example list')} to try it
                </button>
              </p>
            ) : null}
          </div>
        ) : null}
        {byFormat.map((g) => (
          <div class="mymeta__group" key={g.format}>
            <div class="mymeta__ghead">
              <h3 class="sub">
                {FORMAT_LABELS[g.format]} <span class="count">{g.lists.length}</span>
              </h3>
              <div class="cluster">
                <button type="button" class="btn btn--ghost btn--tiny" onClick={() => void check(g.lists)} disabled={checking}>
                  Check lists
                </button>
                <button type="button" class="btn btn--ghost btn--tiny" onClick={() => download(`whetstone-${g.format}-meta-${today()}.json`, toSnapshot(lists, g.format, today()))}>
                  Export JSON
                </button>
              </div>
            </div>
            <ul class="mlists">
              {g.lists.map((l) => {
                const c = checks[l.id];
                return (
                  <li class="mlist card" key={l.id}>
                    <div class="mlist__main">
                      <p class="mlist__name">
                        {c && c.colors.length > 0 ? (
                          <span class="pips" aria-hidden="true">
                            {c.colors.map((x) => (
                              <ColorPip key={x} color={x} />
                            ))}
                          </span>
                        ) : null}
                        <strong>{l.name}</strong>
                        {l.archetype && l.archetype !== l.name ? <span class="muted"> · {l.archetype}</span> : null}
                      </p>
                      <p class="mlist__facts">
                        {l.metaShare !== undefined ? <span>{pct01(l.metaShare)} of the meta</span> : null}
                        {l.winRate !== undefined ? <span>{pct01(l.winRate)} win rate</span> : null}
                        {l.sourceUrl ? (
                          <a href={l.sourceUrl} rel="noopener nofollow" target="_blank">
                            Source<span class="visually-hidden"> (opens in a new tab)</span>
                          </a>
                        ) : (
                          <span class="muted">no source link</span>
                        )}
                      </p>
                      {c ? (
                        <p class={`mlist__check mlist__check--${c.legal ? 'ok' : 'no'}`}>
                          <span aria-hidden="true">{c.legal ? '✓' : '!'}</span> {c.main} cards{c.side ? ` + ${c.side} sideboard` : ''}
                          {c.legal ? ` · legal in ${FORMAT_LABELS[l.format]}` : ` · ${c.problem ?? 'not legal'}`}
                        </p>
                      ) : null}
                    </div>
                    <div class="mlist__actions">
                      <button type="button" class="btn btn--tiny" onClick={() => void openInAnalyzer(l)}>
                        Analyze
                      </button>
                      <button type="button" class="btn btn--ghost btn--tiny" onClick={() => edit(l)} aria-label={`Edit ${l.name}`}>
                        Edit
                      </button>
                      <button type="button" class="btn btn--ghost btn--tiny" onClick={() => remove(l)} aria-label={`Delete ${l.name}`}>
                        Delete
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      <div class="mymeta__tools">
        <form class="card mymeta__form" ref={formRef} onSubmit={submit} aria-labelledby="addlist-title">
          <h2 id="addlist-title" class="mymeta__ftitle">
            {draft.id ? 'Edit list' : 'Add a list'}
          </h2>
          <div class="formgrid">
            <label class="field" for="ml-format">
              <span class="field__label">Format</span>
              <select id="ml-format" class="input select" value={draft.format} onChange={(e) => setDraft({ ...draft, format: (e.target as HTMLSelectElement).value as FormatId })}>
                {FORMAT_IDS.map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABELS[f]}
                  </option>
                ))}
              </select>
            </label>
            <label class="field" for="ml-name">
              <span class="field__label">Deck name</span>
              <input id="ml-name" class="input" maxLength={80} value={draft.name} onInput={(e) => setDraft({ ...draft, name: (e.target as HTMLInputElement).value })} placeholder="Boros Aggro" />
            </label>
            <label class="field" for="ml-arch">
              <span class="field__label">
                Archetype <span class="field__opt">(optional)</span>
              </span>
              <input id="ml-arch" class="input" maxLength={80} value={draft.archetype} onInput={(e) => setDraft({ ...draft, archetype: (e.target as HTMLInputElement).value })} />
            </label>
            <label class="field" for="ml-share">
              <span class="field__label">
                Meta share % <span class="field__opt">(optional)</span>
              </span>
              <input id="ml-share" class="input" inputMode="decimal" value={draft.share} onInput={(e) => setDraft({ ...draft, share: (e.target as HTMLInputElement).value })} placeholder="12.5" />
            </label>
            <label class="field" for="ml-wr">
              <span class="field__label">
                Win rate % <span class="field__opt">(optional)</span>
              </span>
              <input id="ml-wr" class="input" inputMode="decimal" value={draft.winRate} onInput={(e) => setDraft({ ...draft, winRate: (e.target as HTMLInputElement).value })} placeholder="54" />
            </label>
            <label class="field formgrid__wide" for="ml-src">
              <span class="field__label">
                Source link <span class="field__opt">(optional)</span>
              </span>
              <input id="ml-src" class="input" type="url" inputMode="url" value={draft.sourceUrl} onInput={(e) => setDraft({ ...draft, sourceUrl: (e.target as HTMLInputElement).value })} placeholder="https://" />
            </label>
          </div>
          <label class="field" for="ml-list">
            <span class="field__label">Decklist (Arena export)</span>
          </label>
          <textarea id="ml-list" class="input mymeta__text" rows={8} spellcheck={false} value={draft.list} onInput={(e) => setDraft({ ...draft, list: (e.target as HTMLTextAreaElement).value })} placeholder={'Deck\n4 Card Name\n...'} />
          {formError ? (
            <p class="form-error" role="alert">
              {formError}
            </p>
          ) : null}
          <div class="cluster">
            <button type="submit" class="btn btn--primary">
              {draft.id ? 'Save changes' : 'Save list'}
            </button>
            {draft.id ? (
              <button type="button" class="btn btn--ghost" onClick={() => setDraft({ ...EMPTY, format: draft.format })}>
                Cancel
              </button>
            ) : null}
          </div>
        </form>

        <section class="card mymeta__io" aria-labelledby="io-title">
          <h2 id="io-title" class="mymeta__ftitle">
            Import and export
          </h2>
          <p class="muted">
            Snapshots use grindstone-mcp's format: <code>{'{ "format": "standard", "decks": [{ "name", "list", ... }] }'}</code>, so the same file works
            with the grindstone MCP server.
          </p>
          <label class="field" for="ml-import">
            <span class="field__label">Paste snapshot JSON</span>
          </label>
          <textarea id="ml-import" class="input mymeta__text" rows={4} spellcheck={false} value={importText} onInput={(e) => setImportText((e.target as HTMLTextAreaElement).value)} />
          <div class="cluster">
            <button type="button" class="btn" disabled={!importText.trim()} onClick={() => importFrom(importText)}>
              Import
            </button>
            <button type="button" class="btn btn--ghost" onClick={() => fileRef.current?.click()}>
              Import a file
            </button>
            <input ref={fileRef} type="file" accept=".json,application/json" class="visually-hidden" tabindex={-1} aria-hidden="true" onChange={onFile} />
            {lists.length > 0 ? <CopyButton text={JSON.stringify(FORMAT_IDS.filter((f) => lists.some((l) => l.format === f)).map((f) => toSnapshot(lists, f, today())), null, 2)} label="Copy all as JSON" /> : null}
          </div>
          {importMsg ? (
            <Notice tone={importMsg.tone} title={importMsg.text}>
              {importMsg.errors.length ? (
                <ul>
                  {importMsg.errors.slice(0, 8).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              ) : null}
            </Notice>
          ) : null}
        </section>
      </div>
    </div>
  );
}
