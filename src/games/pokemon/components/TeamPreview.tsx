import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import ReasonList from '../../../components/ReasonList.tsx';
import ScoreRing from '../../../components/ScoreRing.tsx';
import ShareButton from '../../../components/ShareButton.tsx';
import type { Edge } from '../../../core/game.ts';
import { signed } from '../../../core/format.ts';
import { readHash, writeHash } from '../../../core/urlstate.ts';
import ComboInput, { type ComboOption } from './ComboInput.tsx';
import IssueList, { type IssueItem } from './IssueList.tsx';
import { TypeList } from './TypeChip.tsx';
import { useAsync, useDebounced, useDex } from './hooks.ts';
import type { MetaSet } from './lib/metasets.ts';
import { parsePaste } from './lib/paste.ts';
import { PREVIEW_PRESETS, PREVIEW_PRESET_IDS, PREVIEW_SIGNAL_LABEL, bringText, recommend, type PreviewMon, type PreviewPresetId } from './lib/preview.ts';
import type { CompactEdge } from '../view.ts';
import { CURRENT_KEY, listSaved, pokemonStore, savedToTeam, type SavedTeam } from './lib/saved.ts';
import { decodeTeam, encodeTeam, teamHash } from './lib/share.ts';
import { newSet, unpackTeam, TEAM_SIZE, type Team } from './lib/team.ts';
import { damageTable, metaByBase, previewFromSet, previewTheirs, setToCalcMon, theirCalcMon } from './lib/teamview.ts';
import { calcClient } from '../worker/client.ts';


interface Props {
  dexUrl: string | null;
  regulation: string;
  metaSets: MetaSet[];
  usageLabel: string | null;
  edges: { counters: CompactEdge[]; synergies: CompactEdge[] } | null;
  /** "Showdown Bo3 replays · last 30 days · 1,234 replays" */
  edgesLabel: string | null;
  builderHref: string;
}

const SOURCE_NAMES = { 'showdown-replays': 'Showdown replays', showdown: 'type chart', 'smogon-calc': '@smogon/calc', smogon: 'Smogon' };
const isString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function toEdges(list: readonly CompactEdge[]): Edge[] {
  return list.map(([a, b, delta, n]) => ({ a, b, delta, n, score: Math.min(100, Math.max(1, Math.round(50 + 50 * Math.tanh(delta / 4)))), source: 'replays', reasons: [] }));
}

function PickChips({ mons, onRemove, label }: { mons: readonly { key: string; name: string }[]; onRemove?: (i: number) => void; label: string }) {
  return (
    <ul class="pk-picks" aria-label={label}>
      {mons.map((m, i) => (
        <li class="pk-pill" key={m.key}>
          {m.name}
          {onRemove && (
            <button type="button" onClick={() => onRemove(i)} aria-label={`Remove ${m.name}`}>
              ×
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

/**
 * Island: Team Preview assistant. Your six against their six → which four to bring and which two
 * to lead, ranked by the generic draft scorer (core/draft.ts) with Pokémon evidence: replay
 * head-to-head results, type matchups, speed and speed control, calc KO coverage both ways, and
 * how likely each of theirs is to be brought. Every pick lists its reasons with n and source.
 */
export default function TeamPreview({ dexUrl, regulation, metaSets, usageLabel, edges, edgesLabel, builderHref }: Props) {
  const dexState = useDex(dexUrl);
  const dex = dexState.status === 'ready' ? dexState.dex : null;
  const [mine, setMine] = useState<Team>([]);
  const [theirs, setTheirs] = useState<Team>([]);
  const [preset, setPreset] = useState<PreviewPresetId>('balanced');
  const [ready, setReady] = useState(false);
  const [saved, setSaved] = useState<SavedTeam[]>([]);
  const [mineNote, setMineNote] = useState('');
  const [pasteMine, setPasteMine] = useState('');
  const [pasteTheirs, setPasteTheirs] = useState('');
  const [issues, setIssues] = useState<IssueItem[]>([]);
  const builderTeam = useRef<Team>([]);

  useEffect(() => {
    let live = true;
    const store = pokemonStore();
    setSaved(listSaved(store));
    builderTeam.current = unpackTeam(store.get(CURRENT_KEY, '', isString));
    (async () => {
      const state = teamHash.decode(readHash());
      let my = state.team ? await decodeTeam(state.team) : [];
      const their = state.them ? await decodeTeam(state.them) : [];
      if (my.length) setMineNote('Your team came from the link.');
      else if (builderTeam.current.length) {
        my = builderTeam.current;
        setMineNote('Your team is the one open in the builder.');
      }
      if (!live) return;
      setMine(my);
      setTheirs(their);
      setReady(true);
    })();
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!ready) return;
    let live = true;
    const t = setTimeout(() => {
      void Promise.all([encodeTeam(mine), encodeTeam(theirs)]).then(([a, b]) => {
        if (!live) return;
        writeHash(a || b ? teamHash.encode({ team: a, them: b }) : '');
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [mine, theirs, ready]);

  const byBase = useMemo(() => metaByBase(metaSets), [metaSets]);
  const h2h = useMemo(() => (edges ? { counters: toEdges(edges.counters), synergies: toEdges(edges.synergies) } : null), [edges]);
  const speciesOptions = useMemo<ComboOption[]>(
    () =>
      dex
        ? dex
            .teamSpecies()
            .filter((s) => s.legal.includes(regulation))
            .map((s) => ({ id: s.id, label: s.name }))
        : [],
    [dex, regulation],
  );
  const quick = useMemo(() => {
    const seen = new Set<string>();
    return metaSets.filter((m) => !seen.has(m.base) && seen.add(m.base)).slice(0, 12);
  }, [metaSets]);

  const myMons = useMemo<PreviewMon[]>(() => (dex ? mine.flatMap((s, i) => previewFromSet(dex, s, `m${i}`) ?? []) : []), [dex, mine]);
  const theirMons = useMemo<PreviewMon[]>(() => (dex ? theirs.flatMap((s, i) => previewTheirs(dex, s, `t${i}`, byBase) ?? []) : []), [dex, theirs, byBase]);

  // Damage both ways from the calc worker, after edits settle.
  const settledMine = useDebounced(mine, 400);
  const settledTheirs = useDebounced(theirs, 400);
  const job = useMemo(() => {
    if (!dex || settledMine.length === 0 || settledTheirs.length === 0) return null;
    const my = settledMine.flatMap((s, i) =>
      dex.speciesById(s.species) ? [{ key: `m${i}`, mon: setToCalcMon(dex, s), moves: s.moves.filter((m) => (dex.move(m)?.category ?? 'Status') !== 'Status') }] : [],
    );
    const their = settledTheirs.flatMap((s, i) => {
      const c = theirCalcMon(dex, s, byBase);
      return c ? [{ key: `t${i}`, mon: c.mon, moves: c.moves }] : [];
    });
    return my.length && their.length ? { my, their } : null;
  }, [dex, settledMine, settledTheirs, byBase]);
  const damage = useAsync(job ? JSON.stringify(job) : null, async () => {
    const client = calcClient();
    const field = { doubles: true };
    const [out, inn] = await Promise.all([
      client.matrix({ attackers: job!.my, defenders: job!.their.map((t) => ({ key: t.key, mon: t.mon })), field }),
      client.matrix({ attackers: job!.their, defenders: job!.my.map((m) => ({ key: m.key, mon: m.mon })), field }),
    ]);
    return damageTable(out.pairs, inn.pairs);
  });

  const result = useMemo(() => {
    if (!dex || myMons.length === 0 || theirMons.length === 0) return null;
    return recommend({ mine: myMons, theirs: theirMons, chart: dex.typechart, h2h, damage: damage.status === 'done' ? damage.value : null }, preset);
  }, [dex, myMons, theirMons, h2h, damage, preset]);

  const nameOf = (key: string) => myMons.find((m) => m.key === key)?.name ?? key;
  const addTheirs = (id: string) => setTheirs((t) => (t.length >= TEAM_SIZE || t.some((s) => s.species === id) ? t : [...t, newSet(id)]));
  const weights = PREVIEW_PRESETS[preset].weights;

  if (!dex) {
    return (
      <p class="pk-loading" role="status">
        {dexState.status === 'error' ? dexState.message : 'Loading the Champions Pokédex…'}
      </p>
    );
  }

  return (
    <div class="pk-tool" data-ready={ready ? 'true' : undefined}>
      <div class="pk-vs">
        <section class="card pk-panel" aria-labelledby="pv-mine-h">
          <h2 id="pv-mine-h">Your team</h2>
          {myMons.length > 0 ? <PickChips mons={myMons} label="Your team" /> : <p class="pk-subtle">No team yet. Paste one, load a saved team or build one first.</p>}
          {mineNote && <p class="pk-subtle">{mineNote}</p>}
          <div class="pk-actions">
            {builderTeam.current.length > 0 && (
              <button
                type="button"
                class="btn btn--sm"
                onClick={() => {
                  setMine(builderTeam.current);
                  setMineNote('Your team is the one open in the builder.');
                }}
              >
                Use the builder's team
              </button>
            )}
            {saved.length > 0 && (
              <label class="pk-field pk-field--inline">
                <span>Saved team</span>
                <select
                  class="pk-select"
                  value=""
                  onChange={(e) => {
                    const s = saved.find((x) => x.id === (e.currentTarget as HTMLSelectElement).value);
                    if (s) {
                      setMine(savedToTeam(s));
                      setMineNote(`Your team is "${s.name}".`);
                    }
                  }}
                >
                  <option value="">Choose…</option>
                  {saved.map((s) => (
                    <option value={s.id} key={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <a class="btn btn--sm btn--ghost" href={builderHref}>
              Open the builder
            </a>
          </div>
          <details class="pk-details">
            <summary>Paste your team</summary>
            <label class="visually-hidden" for="pv-paste-mine">
              Your team as Showdown text
            </label>
            <textarea id="pv-paste-mine" class="pk-textarea" rows={6} spellcheck={false} value={pasteMine} onInput={(e) => setPasteMine((e.currentTarget as HTMLTextAreaElement).value)} />
            <button
              type="button"
              class="btn btn--sm btn--primary"
              disabled={pasteMine.trim() === ''}
              onClick={() => {
                const r = parsePaste(pasteMine, dex);
                setIssues(r.issues.filter((x) => x.level !== 'info').map((x) => ({ level: x.level, message: x.message })));
                if (r.team.length) {
                  setMine(r.team);
                  setMineNote(`Imported ${r.team.length} Pokémon.`);
                }
              }}
            >
              Use this team
            </button>
          </details>
        </section>

        <section class="card pk-panel" aria-labelledby="pv-theirs-h">
          <h2 id="pv-theirs-h">
            Their team <span class="pk-subtle pk-num">({theirs.length}/{TEAM_SIZE})</span>
          </h2>
          {theirMons.length > 0 ? (
            <PickChips mons={theirMons} label="Their team" onRemove={(i) => setTheirs((t) => t.filter((_, j) => j !== i))} />
          ) : (
            <p class="pk-subtle">Add the six Pokémon you see at Team Preview.</p>
          )}
          {theirs.length < TEAM_SIZE && (
            <ComboInput id="pv-add-theirs" label="Add their Pokémon" value={undefined} options={speciesOptions} placeholder="Type a name" clearOnCommit onCommit={(id) => id && addTheirs(id)} />
          )}
          {quick.length > 0 && theirs.length < TEAM_SIZE && (
            <div class="pk-quick" role="group" aria-label="Most used Pokémon">
              <span class="pk-label">Most used</span>
              <div class="pk-actions">
                {quick
                  .filter((m) => !theirs.some((s) => s.species === m.base))
                  .map((m) => (
                    <button type="button" class="btn btn--sm btn--ghost" key={m.base} onClick={() => addTheirs(m.base)}>
                      + {dex.speciesName(m.base)}
                    </button>
                  ))}
              </div>
            </div>
          )}
          <div class="pk-actions">
            {theirs.length > 0 && (
              <button type="button" class="btn btn--sm btn--ghost" onClick={() => setTheirs([])}>
                Clear their team
              </button>
            )}
          </div>
          <details class="pk-details">
            <summary>Paste their team sheet</summary>
            <label class="visually-hidden" for="pv-paste-theirs">
              Their team as Showdown text
            </label>
            <textarea id="pv-paste-theirs" class="pk-textarea" rows={6} spellcheck={false} value={pasteTheirs} onInput={(e) => setPasteTheirs((e.currentTarget as HTMLTextAreaElement).value)} />
            <button
              type="button"
              class="btn btn--sm btn--primary"
              disabled={pasteTheirs.trim() === ''}
              onClick={() => {
                const r = parsePaste(pasteTheirs, dex);
                setIssues(r.issues.filter((x) => x.level !== 'info').map((x) => ({ level: x.level, message: x.message })));
                if (r.team.length) setTheirs(r.team);
              }}
            >
              Use as their team
            </button>
          </details>
          <p class="pk-subtle">Without a team sheet, each of theirs is assumed to run its most common ladder set{usageLabel ? ` (${usageLabel})` : ''}.</p>
        </section>
      </div>
      <IssueList issues={issues} label="Import messages" />

      <section class="pk-section" aria-labelledby="pv-plan-h">
        <div class="section-head">
          <h2 id="pv-plan-h">Recommendation</h2>
          <ShareButton label="Share this matchup" class="btn--sm" />
        </div>
        <div class="pk-actions" role="group" aria-label="What to weigh">
          <span class="pk-label">Weigh</span>
          <span class="pk-seg">
            {PREVIEW_PRESET_IDS.map((id) => (
              <button type="button" key={id} aria-pressed={preset === id ? 'true' : 'false'} onClick={() => setPreset(id)}>
                {PREVIEW_PRESETS[id].label}
              </button>
            ))}
          </span>
        </div>
        <p class="pk-status" role="status" aria-live="polite">
          {!result
            ? 'Add your team and theirs to get a recommendation.'
            : damage.status === 'busy'
              ? 'Ranked without damage so far; calculating damage…'
              : damage.status === 'error'
                ? `Ranked without damage: the calculator failed (${damage.message}).`
                : damage.status === 'done'
                  ? 'Ranked with replay results, types, speed and damage.'
                  : 'Ranked without damage: add moves to get damage calcs.'}
        </p>

        {result && result.lead && (
          <div class="card pk-plan" data-plan>
            <div class="pk-plan__row">
              <span class="pk-plan__label">Lead</span>
              {result.lead.leads.map((k) => (
                <span class="pk-plan__mon" key={k} data-lead={k}>
                  {nameOf(k)}
                </span>
              ))}
            </div>
            <div class="pk-plan__row">
              <span class="pk-plan__label">Back</span>
              {result.lead.back.map((k) => (
                <span class="pk-plan__mon pk-plan__mon--back" key={k}>
                  {nameOf(k)}
                </span>
              ))}
            </div>
            <ul class="pk-plan__why">
              {result.lead.reasons.map((r) => (
                <li key={r}>{r}</li>
              ))}
              {result.bringNotes.map((r) => (
                <li key={r}>{r}</li>
              ))}
            </ul>
          </div>
        )}

        {result && (
          <ol class="pk-cards pk-ranked" aria-label="Your Pokémon, best pick first">
            {result.ranked.map((r) => {
              const mon = myMons.find((m) => m.key === r.id)!;
              const lead = result.lead?.leads.includes(r.id) ?? false;
              const bring = result.bring.includes(r.id);
              const parts = Object.entries(r.byKey)
                .filter(([k, v]) => v !== undefined && Math.abs(v) >= 0.01 && (weights[k as keyof typeof weights] ?? 0) > 0)
                .map(([k, v]) => `${PREVIEW_SIGNAL_LABEL[k] ?? k} ${signed(v as number, 2)}`);
              return (
                <li class="pk-card" key={r.id} data-pick={lead ? 'lead' : bring ? 'bring' : 'leave'} data-key={r.id}>
                  <div class="pk-card__head">
                    <span class="pk-rank">
                      <ScoreRing score={Math.max(1, r.score)} size={40} label={`${mon.name}: score ${r.score} out of 100`} />
                      <span>
                        <span class="pk-card__name">{mon.name}</span>
                        <TypeList types={mon.types} small />
                      </span>
                    </span>
                    <span class={`badge badge--${lead ? 'accent' : bring ? 'positive' : 'neutral'}`}>{lead ? 'Lead' : bring ? 'Bring' : 'Leave'}</span>
                  </div>
                  {r.reasons.length > 0 ? <ReasonList reasons={r.reasons} sourceNames={SOURCE_NAMES} /> : <p class="pk-subtle">No strong evidence either way.</p>}
                  {r.warning && (
                    <p class="pk-warn">
                      <strong>Watch out:</strong> {r.warning.text}
                      {r.warning.n !== undefined ? ` (n = ${r.warning.n})` : ''}
                    </p>
                  )}
                  {parts.length > 0 && (
                    <p class="pk-breakdown">
                      <span>Score parts:</span>
                      {parts.map((p) => (
                        <span key={p}>{p}</span>
                      ))}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {result && (
        <section class="pk-section" aria-labelledby="pv-their-h">
          <h2 id="pv-their-h">What they likely bring</h2>
          <ul class="pk-bars">
            {result.theirBring.map(({ key, weight }) => {
              const mon = theirMons.find((m) => m.key === key)!;
              return (
                <li class="pk-bar" key={key} style={`--w: ${(weight * 100).toFixed(1)}%`}>
                  <span class="pk-bar__label">
                    {mon.name}
                    <small> · Speed {mon.speed}{mon.assumed ? ' · common set assumed' : ''}</small>
                  </span>
                  <span class="pk-bar__value">{bringText(weight)}</span>
                </li>
              );
            })}
          </ul>
          <p class="pk-subtle">
            Estimated from ladder usage: chances are proportional to usage and add up to four, none above 100%. Pokémon without usage data count as the
            average of the rest.
          </p>
        </section>
      )}

      <p class="pk-note">
        <span>Evidence: {edgesLabel ?? 'no replay head-to-head data yet'}</span>
        <span>· type chart from Pokémon Showdown</span>
        <span>· damage by @smogon/calc (Doubles)</span>
        {usageLabel && <span>· common sets from {usageLabel}</span>}
      </p>
    </div>
  );
}
