import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import CopyButton from '../../../components/CopyButton.tsx';
import ShareButton from '../../../components/ShareButton.tsx';
import { onHashChange, readHash, writeHash } from '../../../core/urlstate.ts';
import ComboInput, { OptionList, type ComboOption } from './ComboInput.tsx';
import IssueList, { type IssueItem } from './IssueList.tsx';
import SetEditor, { switchSpecies } from './SetEditor.tsx';
import { Coverage, SpeedPanel, ThreatPanel, TypeMatrix, type PanelMember } from './TeamPanels.tsx';
import { useAsync, useDebounced, useDex } from './hooks.ts';
import type { DexIndex } from './lib/dex.ts';
import { checkTeam, issuesForSlot } from './lib/legality.ts';
import type { MetaSet } from './lib/metasets.ts';
import { exportTeam, parsePaste, type PasteIssue } from './lib/paste.ts';
import { CURRENT_KEY, deleteSaved, listSaved, pokemonStore, saveTeam, savedToTeam, type SavedTeam } from './lib/saved.ts';
import { decodeTeam, encodeTeam, teamHash } from './lib/share.ts';
import { packTeam, unpackTeam, TEAM_SIZE, type PokemonSet, type Team } from './lib/team.ts';
import { attackMoves } from './lib/types.ts';
import { battleAbility, battleForme, metaToCalcMon, sampleTeam, setDisplayName, setSpeed, setStats, setToCalcMon, summarizeThreats } from './lib/teamview.ts';
import { calcClient } from '../worker/client.ts';

interface Props {
  /** Staged dex shard URL (stagedUrlOrNull('pokemon', 'dex')). */
  dexUrl: string | null;
  regulation: string;
  regulationLabel: string;
  /** Common sets of the top Pokémon (threats, speed). */
  metaSets: MetaSet[];
  /** "Smogon ≥ 1760 · Sep 2026", or null while usage is warming up. */
  usageLabel: string | null;
  previewHref: string;
}

const isString = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function pasteIssueItems(issues: readonly PasteIssue[]): IssueItem[] {
  return issues.map((x) => ({ level: x.level, message: x.message }));
}

function useOptions(dex: DexIndex | null, regulation: string) {
  return useMemo(() => {
    if (!dex) return { species: [] as ComboOption[], items: [] as ComboOption[] };
    const species = dex
      .teamSpecies()
      .filter((s) => s.legal.includes(regulation))
      .map((s) => ({ id: s.id, label: s.name }));
    const items = dex.items
      .filter((i) => i.legal.includes(regulation))
      .map((i) => ({ id: i.id, label: i.name }))
      .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
    return { species, items };
  }, [dex, regulation]);
}

/**
 * Island: the team builder. Six sets with Showdown paste import/export (Stat Points; EV pastes
 * converted), legality for the regulation, weakness matrix, coverage, speed against the top 50,
 * and a threat list from the damage calc worker. The team lives in this browser (localStorage)
 * and in the URL hash, so a link reproduces it.
 */
export default function TeamBuilder({ dexUrl, regulation, regulationLabel, metaSets, usageLabel, previewHref }: Props) {
  const dexState = useDex(dexUrl);
  const dex = dexState.status === 'ready' ? dexState.dex : null;
  const options = useOptions(dex, regulation);

  const [team, setTeam] = useState<Team>([]);
  const [ready, setReady] = useState(false);
  const [note, setNote] = useState('');
  const [paste, setPaste] = useState('');
  const [pasteIssues, setPasteIssues] = useState<IssueItem[]>([]);
  const [saved, setSaved] = useState<SavedTeam[]>([]);
  const [name, setName] = useState('');
  const [savedId, setSavedId] = useState<string | undefined>(undefined);
  const [payload, setPayload] = useState('');
  const written = useRef<string | null>(null);

  // Restore: a team in the link wins over the one left in this browser.
  useEffect(() => {
    let live = true;
    const store = pokemonStore();
    setSaved(listSaved(store));
    (async () => {
      const fromHash = teamHash.decode(readHash()).team;
      let restored: Team = fromHash ? await decodeTeam(fromHash) : [];
      if (restored.length > 0) setNote('Loaded the team from the link.');
      else restored = unpackTeam(store.get(CURRENT_KEY, '', isString));
      if (!live) return;
      written.current = fromHash;
      setTeam(restored);
      setReady(true);
    })();
    const off = onHashChange((hash) => {
      const next = teamHash.decode(hash).team;
      if (next === written.current) return;
      written.current = next;
      void decodeTeam(next).then((t) => {
        if (!live) return;
        setTeam(t);
        setNote(t.length ? 'Loaded the team from the link.' : '');
      });
    });
    return () => {
      live = false;
      off();
    };
  }, []);

  // Keep this browser's copy and the link in step with the team.
  useEffect(() => {
    if (!ready) return;
    pokemonStore().set(CURRENT_KEY, packTeam(team));
    let live = true;
    const t = setTimeout(() => {
      void encodeTeam(team).then((p) => {
        if (!live) return;
        written.current = p;
        setPayload(p);
        writeHash(p ? teamHash.encode({ team: p }) : '');
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [team, ready]);

  const report = dex ? checkTeam(team, dex, regulation) : null;
  const exportText = dex ? exportTeam(team, dex) : '';

  const members: PanelMember[] = useMemo(() => {
    if (!dex) return [];
    return team.flatMap((set, i) => {
      const forme = battleForme(dex, set);
      const stats = setStats(dex, set);
      if (!forme || !stats) return [];
      const m: PanelMember = { id: `s${i}`, name: setDisplayName(dex, set), types: forme.types, speed: stats.spe };
      if (set.item) m.item = set.item;
      const ability = battleAbility(dex, set);
      if (ability) m.ability = ability;
      return [m];
    });
  }, [dex, team]);
  const names = Object.fromEntries(members.map((m) => [m.id, m.name]));
  const attacks = useMemo(() => {
    if (!dex) return [];
    return team.flatMap((set, i) => {
      const forme = battleForme(dex, set);
      if (!forme) return [];
      const moves = set.moves.map((id) => dex.move(id)).filter((m) => m !== undefined);
      return attackMoves(`s${i}`, moves, forme.types, battleAbility(dex, set));
    });
  }, [dex, team]);

  // Threat list: both directions through the calc worker, recomputed after edits settle.
  const settled = useDebounced(team, 450);
  const calcJob = useMemo(() => {
    if (!dex || settled.length === 0 || metaSets.length === 0) return null;
    const mine = settled.flatMap((set, i) =>
      dex.speciesById(set.species)
        ? [{ key: `s${i}`, mon: setToCalcMon(dex, set), moves: set.moves.filter((m) => (dex.move(m)?.category ?? 'Status') !== 'Status'), speed: setSpeed(dex, set) ?? 0 }]
        : [],
    );
    return { mine, theirs: metaSets.map((m) => ({ key: m.id, mon: metaToCalcMon(m), moves: m.attacks })) };
  }, [dex, settled, metaSets]);
  const threats = useAsync(calcJob ? JSON.stringify(calcJob) : null, async () => {
    const job = calcJob!;
    const client = calcClient();
    const field = { doubles: true };
    const [into, back] = await Promise.all([
      client.matrix({ attackers: job.theirs, defenders: job.mine.map((m) => ({ key: m.key, mon: m.mon })), field }),
      client.matrix({ attackers: job.mine.map((m) => ({ key: m.key, mon: m.mon, moves: m.moves })), defenders: job.theirs.map((t) => ({ key: t.key, mon: t.mon })), field }),
    ]);
    return summarizeThreats(metaSets, job.mine, into.pairs, back.pairs);
  });

  const replaceSlot = (i: number, set: PokemonSet) => setTeam((t) => t.map((s, j) => (j === i ? set : s)));
  const removeSlot = (i: number) => setTeam((t) => t.filter((_, j) => j !== i));
  const moveSlot = (i: number, dir: -1 | 1) =>
    setTeam((t) => {
      const j = i + dir;
      if (j < 0 || j >= t.length) return t;
      const next = [...t];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  const doImport = () => {
    if (!dex) return;
    const res = parsePaste(paste, dex);
    setPasteIssues(pasteIssueItems(res.issues));
    if (res.team.length > 0) {
      setTeam(res.team);
      setSavedId(undefined);
      setNote(`Imported ${res.team.length} Pokémon${res.convertedFromEvs ? ' (EVs converted to Stat Points)' : ''}.`);
    } else setNote('Nothing was imported.');
  };

  const doSave = () => {
    const list = saveTeam(savedId ? { id: savedId, name, team } : { name, team });
    setSaved(list);
    setSavedId(list[0]?.id);
    setName(list[0]?.name ?? name);
    setNote(`Saved "${list[0]?.name ?? name}" in this browser.`);
  };

  const legalText = !report
    ? dexState.status === 'error'
      ? 'The Pokédex could not be loaded.'
      : 'Loading the Champions Pokédex…'
    : team.length === 0
      ? 'Add Pokémon or import a paste to start.'
      : report.ok
        ? `Legal for ${regulationLabel}${report.warnings ? ` (${report.warnings} note${report.warnings > 1 ? 's' : ''})` : ''}.`
        : `${report.errors} problem${report.errors > 1 ? 's' : ''} to fix for ${regulationLabel}.`;
  const teamIssues: IssueItem[] = report ? report.issues.filter((x) => x.slots.length === 0).map((x) => ({ level: x.level, message: x.message })) : [];

  return (
    <div class="pk-builder" data-ready={dex && ready ? 'true' : undefined}>
      <OptionList id="pk-species-options" options={options.species} />
      <OptionList id="pk-item-options" options={options.items} />

      <section class="card pk-panel pk-teambar" aria-labelledby="pk-status-h">
        <div class="pk-teambar__top">
          <div>
            <h2 id="pk-status-h" class="pk-label">
              Team status
            </h2>
            <p class="pk-teambar__state" data-legal={report && team.length ? String(report.ok) : undefined} role="status" aria-live="polite">
              {legalText}
            </p>
          </div>
          <div class="pk-actions">
            <ShareButton label="Share link" class="btn--sm" title="Pokémon Champions team" />
            <CopyButton text={exportText} label="Copy paste" class="btn--sm" />
            <a class="btn btn--sm" href={`${previewHref}${payload ? teamHash.encode({ team: payload }) : ''}`}>
              Team preview →
            </a>
          </div>
        </div>
        <IssueList issues={teamIssues} label="Team-wide checks" />
        {note && <p class="pk-subtle">{note}</p>}
      </section>

      <div class="pk-cols">
        <section class="card pk-panel" aria-labelledby="pk-import-h">
          <h2 id="pk-import-h">Import a paste</h2>
          <label class="pk-field" for="pk-paste">
            <span>Showdown or PokéPaste text (Stat Points or EVs)</span>
          </label>
          <textarea
            id="pk-paste"
            class="pk-textarea"
            rows={8}
            spellcheck={false}
            placeholder={'Rillaboom @ Miracle Seed\nAbility: Grassy Surge\nEVs: 32 HP / 32 Atk / 2 SpD\nAdamant Nature\n- Fake Out\n- Grassy Glide'}
            value={paste}
            onInput={(e) => setPaste((e.currentTarget as HTMLTextAreaElement).value)}
          />
          <div class="pk-actions">
            <button type="button" class="btn btn--primary btn--sm" disabled={!dex || paste.trim() === ''} onClick={doImport}>
              Import (replaces the team)
            </button>
            {metaSets.length > 0 && (
              <button
                type="button"
                class="btn btn--sm btn--ghost"
                disabled={!dex}
                onClick={() => {
                  setTeam(sampleTeam(metaSets, dex ?? undefined));
                  setSavedId(undefined);
                  setNote('Started from the most used common sets. Adjust them to your own.');
                }}
              >
                Start from the top six
              </button>
            )}
          </div>
          <IssueList issues={pasteIssues} label="Import messages" />
          <p class="pk-subtle">
            Stat Points go in the <code>EVs:</code> line, as Showdown's Champions formats write them. Each set is checked on its own: one with a stat above 32 or
            more than 130 points is read as EVs and converted (4 EVs buy the first point in a stat, then every 8 more buy one, up to 32). A set with 67–130
            points stays Stat Points and is flagged as over the 66-point budget.
          </p>
        </section>

        <section class="card pk-panel" aria-labelledby="pk-export-h">
          <h2 id="pk-export-h">Export and save</h2>
          <label class="pk-field" for="pk-export">
            <span>Paste for Showdown (Champions formats)</span>
          </label>
          <textarea id="pk-export" class="pk-textarea" rows={8} readOnly spellcheck={false} value={exportText} />
          <div class="pk-save">
            <label class="pk-field" for="pk-team-name">
              <span>Team name</span>
            </label>
            <div class="pk-save__row">
              <input id="pk-team-name" class="pk-input" maxLength={60} value={name} placeholder="Untitled team" onInput={(e) => setName((e.currentTarget as HTMLInputElement).value)} />
              <button type="button" class="btn btn--sm" disabled={team.length === 0} onClick={doSave}>
                {savedId ? 'Update' : 'Save'}
              </button>
              <button
                type="button"
                class="btn btn--sm btn--ghost"
                disabled={team.length === 0}
                onClick={() => {
                  setTeam([]);
                  setSavedId(undefined);
                  setName('');
                  setPasteIssues([]);
                  setNote('Started a new team.');
                }}
              >
                New team
              </button>
            </div>
          </div>
          {saved.length > 0 ? (
            <ul class="pk-saved" aria-label="Teams saved in this browser">
              {saved.map((s) => (
                <li key={s.id} data-current={s.id === savedId ? 'true' : undefined}>
                  <span class="pk-saved__name">{s.name}</span>
                  <span class="pk-subtle">{unpackTeam(s.team).length} Pokémon</span>
                  <span class="pk-actions">
                    <button
                      type="button"
                      class="btn btn--sm"
                      onClick={() => {
                        setTeam(savedToTeam(s));
                        setSavedId(s.id);
                        setName(s.name);
                        setNote(`Loaded "${s.name}".`);
                      }}
                    >
                      Load<span class="visually-hidden"> {s.name}</span>
                    </button>
                    <button
                      type="button"
                      class="btn btn--sm btn--ghost"
                      onClick={() => {
                        setSaved(deleteSaved(s.id));
                        if (savedId === s.id) setSavedId(undefined);
                        setNote(`Deleted "${s.name}".`);
                      }}
                    >
                      Delete<span class="visually-hidden"> {s.name}</span>
                    </button>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p class="pk-subtle">Saved teams stay in this browser only; nothing is uploaded.</p>
          )}
        </section>
      </div>

      <section class="pk-section" aria-labelledby="pk-team-h">
        <div class="section-head">
          <h2 id="pk-team-h">
            Your team <span class="pk-subtle pk-num">({team.length}/{TEAM_SIZE})</span>
          </h2>
        </div>
        {!dex ? (
          <p class="pk-loading" role="status">
            {dexState.status === 'error' ? dexState.message : 'Loading the Champions Pokédex…'}
          </p>
        ) : (
          <ol class="pk-slots">
            {team.map((set, i) => (
              <li key={i}>
                <SetEditor
                  idBase={`slot${i + 1}`}
                  title={setDisplayName(dex, set)}
                  marker={String(i + 1)}
                  set={set}
                  dex={dex}
                  speciesOptions={options.species}
                  speciesListId="pk-species-options"
                  itemOptions={options.items}
                  itemListId="pk-item-options"
                  issues={report ? issuesForSlot(report, i).map((x) => ({ level: x.level, message: x.message })) : []}
                  onChange={(s) => replaceSlot(i, s)}
                  actions={
                    <>
                      <button type="button" class="btn btn--sm btn--ghost btn--icon" disabled={i === 0} onClick={() => moveSlot(i, -1)} aria-label={`Move ${setDisplayName(dex, set)} up`}>
                        ↑
                      </button>
                      <button
                        type="button"
                        class="btn btn--sm btn--ghost btn--icon"
                        disabled={i === team.length - 1}
                        onClick={() => moveSlot(i, 1)}
                        aria-label={`Move ${setDisplayName(dex, set)} down`}
                      >
                        ↓
                      </button>
                      <button type="button" class="btn btn--sm btn--ghost" onClick={() => removeSlot(i)}>
                        Remove<span class="visually-hidden"> {setDisplayName(dex, set)}</span>
                      </button>
                    </>
                  }
                />
              </li>
            ))}
            {team.length < TEAM_SIZE && (
              <li>
                <div class="pk-slot pk-slot__empty">
                  <ComboInput
                    id="pk-add-species"
                    label={`Add a Pokémon (slot ${team.length + 1} of ${TEAM_SIZE})`}
                    value={undefined}
                    options={options.species}
                    listId="pk-species-options"
                    placeholder="Type a name, e.g. Incineroar"
                    clearOnCommit
                    onCommit={(id) => id && setTeam((t) => [...t, switchSpecies(dex, null, id)])}
                  />
                </div>
              </li>
            )}
          </ol>
        )}
      </section>

      {dex && members.length > 0 && (
        <>
          <section class="pk-section" aria-labelledby="pk-weak-h">
            <h2 id="pk-weak-h">Weaknesses and resistances</h2>
            <TypeMatrix chart={dex.typechart} members={members} />
          </section>

          <section class="pk-section" aria-labelledby="pk-cover-h">
            <h2 id="pk-cover-h">Offensive coverage</h2>
            <Coverage chart={dex.typechart} attacks={attacks} names={names} dex={dex} />
          </section>

          <section class="pk-section" aria-labelledby="pk-speed-h">
            <h2 id="pk-speed-h">Speed against the top {metaSets.length}</h2>
            <SpeedPanel members={members} sets={metaSets} usageLabel={usageLabel} />
          </section>

          <section class="pk-section" aria-labelledby="pk-threat-h">
            <div class="section-head">
              <h2 id="pk-threat-h">Threats</h2>
            </div>
            <p class="pk-subtle">
              The most used Pokémon's common sets against your team: how many of yours each one KOs in one or two hits, and which of yours hit it back as hard.
              Doubles damage (spread moves ×0.75), no weather, terrain or boosts. {usageLabel ? `Sets: ${usageLabel}.` : ''}
            </p>
            {metaSets.length === 0 ? (
              <p class="pk-subtle">Threats need ladder usage data, which is still warming up for this regulation.</p>
            ) : threats.status === 'done' ? (
              <ThreatPanel summary={threats.value} names={names} />
            ) : threats.status === 'error' ? (
              <p class="pk-issue" data-level="error">
                <span class="pk-issue__tag">Error</span>
                <span>The damage calculator failed: {threats.message}</span>
              </p>
            ) : (
              <p class="pk-loading" role="status" aria-live="polite">
                Calculating {metaSets.length * members.length * 2} matchups…
              </p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
