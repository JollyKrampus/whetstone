/**
 * Build-time loaders for HotS data: the only place pages read HotS files (SPEC §3).
 * Node-only (fs through src/lib/datadir.ts): call from .astro frontmatter / getStaticPaths,
 * never from an island; islands get props or fetch the staged draft shard.
 *
 * Every read is zod-validated (errors name the file) and memoized for the process.
 * Private files (class B stats, class C videos/streams) come from data/private/hots/; with
 * committed fixtures they come from fixtures/hots/_private/ and only when
 * WHETSTONE_FIXTURE_PRIVATE=1 (synthetic samples for UI work and tests).
 */
import path from 'node:path';
import type { Edge, Reason, SourceRef } from '../../core/game.ts';
import { createCachedLoader } from '../../core/schemas.ts';
import { sourcesFor } from '../registry.ts';
import { GATES, classifySample, isListable, scoreFromDelta } from '../../core/stats.ts';
import { gameDataDir, gamePrivateDir, readGameJson, usingFixtures } from '../../lib/datadir.ts';
import {
  DiffsFileSchema,
  DraftShardSchema,
  HeroesFileSchema,
  HotsMetaSchema,
  LinksSchema,
  MapsFileSchema,
  PatchesFileSchema,
  ProSchema,
  RETENTION,
  RotationSchema,
  StatsSchema,
  StreamsSchema,
  TheorySchema,
  VideosSchema,
  type Diff,
  type DraftShard,
  type GameMap,
  type GameMode,
  type Hero,
  type HotsMeta,
  type Link,
  type Links,
  type Patch,
  type Pro,
  type Rotation,
  type Stats,
  type StatsWindow,
  type Streams,
  type Theory,
  type Timeframe,
  type Videos,
} from './schema.ts';

const GAME = 'hots';

const publicData = createCachedLoader({
  read: (file, { optional }) => readGameJson(GAME, file, { optional }),
  where: (file) => path.join(gameDataDir(GAME), file),
});

function fixturePrivateEnabled(): boolean {
  return process.env.WHETSTONE_FIXTURE_PRIVATE === '1';
}

const privateData = createCachedLoader({
  read: (file, { optional }) => {
    if (usingFixtures(GAME)) return fixturePrivateEnabled() ? readGameJson(GAME, `_private/${file}`, { optional }) : null;
    return readGameJson(GAME, file, { optional, private: true });
  },
  where: (file) =>
    usingFixtures(GAME)
      ? path.join(gameDataDir(GAME), '_private', file)
      : path.join(gamePrivateDir(GAME) ?? path.join('data', 'private', GAME), file),
});

const derived = new Map<string, unknown>();
function memo<T>(key: string, make: () => T): T {
  if (!derived.has(key)) derived.set(key, make());
  return derived.get(key) as T;
}

/** Drops every cached file and index (tests, dev-server reloads). */
export function clearHotsCache(): void {
  publicData.clear();
  privateData.clear();
  derived.clear();
}

/** Private samples must never reach a real build. */
function guardSynthetic<T extends { synthetic?: true }>(value: T | null, file: string): T | null {
  if (value?.synthetic && !usingFixtures(GAME)) {
    throw new Error(`Refusing synthetic ${file} outside fixtures (${path.join(gamePrivateDir(GAME) ?? 'data/private/hots', file)})`);
  }
  return value;
}

// ---- meta / heroes ---------------------------------------------------------------------

export function getMeta(): HotsMeta {
  return publicData.required('meta.json', HotsMetaSchema);
}

/** Every hero record: playable heroes, Cho'gall's members and the composite itself. Sorted by slug. */
export function getHeroes(): Hero[] {
  return publicData.required('heroes.json', HeroesFileSchema);
}

/**
 * Draftable entities: heroes that are not composite members, plus composites (`chogall`).
 * Hero pages, grids, edges, stats and the draft use these.
 */
export function getDraftableEntities(): Hero[] {
  return memo('entities', () => getHeroes().filter((h) => !h.memberOf));
}

export function getHeroById(id: string): Hero | undefined {
  return memo('byId', () => new Map(getHeroes().map((h) => [h.id, h]))).get(id);
}

/** Exact slug lookup over all hero records (members included). */
export function getHeroBySlug(slug: string): Hero | undefined {
  return memo('bySlug', () => new Map(getHeroes().map((h) => [h.slug, h]))).get(slug);
}

/** The draftable entity for a hero: the composite for Cho/Gall, the hero itself otherwise. */
export function getEntity(heroOrId: Hero | string): Hero | undefined {
  const hero = typeof heroOrId === 'string' ? (getHeroById(heroOrId) ?? getHeroBySlug(heroOrId)) : heroOrId;
  if (!hero) return undefined;
  return hero.memberOf ? getHeroById(hero.memberOf) : hero;
}

/** Member heroes of a composite (empty for ordinary heroes). */
export function getMembers(hero: Hero): Hero[] {
  return (hero.members ?? []).map((id) => getHeroById(id)).filter((h): h is Hero => h !== undefined);
}

/** Lowercase, accent-free letters and digits only: "Li-Ming", "li ming" and "liming" share a key. */
export function searchKey(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** Resolves a search query (slug, name, nickname, localized alias) to a draftable entity. */
export function resolveHero(query: string): Hero | undefined {
  const index = memo('aliases', () => {
    const map = new Map<string, Hero>();
    // Composites first so a member alias ("cho") never shadows the composite's own aliases.
    const ordered = [...getHeroes()].sort((a, b) => Number(Boolean(b.members)) - Number(Boolean(a.members)));
    for (const h of ordered) {
      const entity = getEntity(h) ?? h;
      for (const key of [h.slug, h.name, ...h.aliases].map(searchKey)) if (key && !map.has(key)) map.set(key, entity);
    }
    return map;
  });
  return index.get(searchKey(query));
}

// ---- maps ------------------------------------------------------------------------------

export function getMaps(): GameMap[] {
  return publicData.required('maps.json', MapsFileSchema);
}

export function getMapBySlug(slug: string): GameMap | undefined {
  return memo('maps', () => new Map(getMaps().map((m) => [m.id, m]))).get(slug);
}

/** Current Storm League pool (standard maps flagged ranked). */
export function getRankedMaps(): GameMap[] {
  return getMaps().filter((m) => m.ranked && m.kind === 'standard');
}

// ---- patches / diffs -------------------------------------------------------------------

/** Newest first; empty when the notes source has never succeeded. */
export function getPatches(): Patch[] {
  return publicData.optional('patches.json', PatchesFileSchema) ?? [];
}

export function getPatch(id: string): Patch | undefined {
  return getPatches().find((p) => p.id === id);
}

/** Patches released after `since` (YYYY-MM-DD, exclusive), newest first: the catch-up page. */
export function getPatchesSince(since: string): Patch[] {
  return getPatches().filter((p) => p.date > since);
}

export interface HeroPatchEntry {
  patch: Patch;
  /** The hero (member) the changes are filed under. */
  heroId: string;
  changes: Patch['heroes'][string]['changes'];
  verdict?: Patch['heroes'][string]['verdict'];
}

/** Patch history of a hero; a composite gets its members' entries. Newest first. */
export function getHeroPatchHistory(hero: Hero, since?: string): HeroPatchEntry[] {
  const ids = hero.members ? [...hero.members] : [hero.id];
  const out: HeroPatchEntry[] = [];
  for (const patch of since === undefined ? getPatches() : getPatchesSince(since)) {
    for (const id of ids) {
      const entry = patch.heroes[id];
      if (entry) out.push({ patch, heroId: id, changes: entry.changes, ...(entry.verdict ? { verdict: entry.verdict } : {}) });
    }
  }
  return out;
}

/** Build-to-build game-data diffs, newest first; empty when none were computed. */
export function getDiffs(): Diff[] {
  return publicData.optional('diffs.json', DiffsFileSchema) ?? [];
}

// ---- theory / links / rotation / pro / draft shard -------------------------------------

export function getTheory(): Theory {
  return publicData.required('theory.json', TheorySchema);
}

export function getLinks(): Links | null {
  return publicData.optional('links.json', LinksSchema);
}

/** Outbound links for a hero; a composite merges its members' links (deduplicated by URL). */
export function getHeroLinks(hero: Hero): Link[] {
  const links = getLinks();
  if (!links) return [];
  const ids = hero.members ? [...hero.members] : [hero.id];
  const byUrl = new Map<string, Link>();
  for (const l of ids.flatMap((id) => links.heroes[id] ?? [])) if (!byUrl.has(l.url)) byUrl.set(l.url, l);
  return [...byUrl.values()];
}

export function getRotation(): Rotation | null {
  return publicData.optional('rotation.json', RotationSchema);
}

/**
 * True when the rotation's window had already ended when it was fetched: Nexus Compendium can lag
 * a day or two behind the weekly switch. Pages then say so and mark no hero as free, rather than
 * badge last week's heroes as "free this week".
 */
export function rotationIsStale(rotation: Rotation): boolean {
  return rotation.end < rotation.fetchedAt.slice(0, 10);
}

/** The free rotation when it is current, else null (absent or stale). */
export function currentRotation(): Rotation | null {
  const rotation = getRotation();
  return rotation && !rotationIsStale(rotation) ? rotation : null;
}

/** True when the hero (or any member of a composite) is in the current free rotation. */
export function isFreeToPlay(hero: Hero): boolean {
  const rotation = currentRotation();
  if (!rotation) return false;
  if (rotation.allFree) return true;
  const ids = hero.members ? [...hero.members] : [hero.id];
  return ids.some((id) => rotation.heroes.includes(id));
}

/** Class A-SA (Liquipedia, CC BY-SA 3.0): render `attribution` wherever it is shown. */
export function getPro(): Pro | null {
  return publicData.optional('pro.json', ProSchema);
}

/** The browser draft shard as written by the pipeline (stats are merged only at stage time). */
export function getDraftShard(): DraftShard | null {
  return publicData.optional('public/draft.json', DraftShardSchema);
}

// ---- private: stats (B), videos and streams (C) ----------------------------------------

/**
 * Match statistics (class B), or null when no statistics source is enabled. The file names the
 * source that provided it (`source`, a SourceRef id): pages credit that source, never a fixed one.
 */
export function getStats(): Stats | null {
  return guardSynthetic(privateData.optional('stats.json', StatsSchema), 'stats.json');
}

/**
 * The SourceRef behind the statistics (looked up by the file's `source` id in the game module),
 * for credits next to the numbers. Empty when there are no statistics or the id is unknown.
 */
export function statsSources(): SourceRef[] {
  const id = getStats()?.source;
  return id ? sourcesFor(GAME, [id]) : [];
}

/** Ids of statsSources(), for a layout's `uses` list (credits the page shows). */
export function statsSourceIds(): string[] {
  return statsSources().map((s) => s.id);
}

/** Display name of the statistics source ("match statistics" when it is not a known SourceRef). */
export function statsSourceName(): string {
  return statsSources()[0]?.name ?? 'match statistics';
}

export function getStatsWindow(mode: GameMode = 'sl', timeframe: Timeframe = 'current'): StatsWindow | null {
  const m = getStats()?.modes[mode];
  if (!m) return null;
  return timeframe === 'current' ? m.current : (m.previous ?? null);
}

/** Retention is measured against the data snapshot for fixtures, the wall clock otherwise. */
function clock(now?: Date): number {
  if (now) return now.getTime();
  return usingFixtures(GAME) ? Date.parse(getMeta().generatedAt) : Date.now();
}

/** YouTube metadata, or null when absent or older than 30 days (API policy). */
export function getVideos(opts: { now?: Date } = {}): Videos | null {
  const v = guardSynthetic(privateData.optional('videos.json', VideosSchema), 'videos.json');
  if (!v || clock(opts.now) - Date.parse(v.fetchedAt) > RETENTION.videosMs) return null;
  return v;
}

/**
 * Twitch streams, or null when absent or older than 24 hours (Twitch cache limit). The
 * client must still hide them RETENTION.streamsDisplayMs after `fetchedAt`.
 */
export function getStreams(opts: { now?: Date } = {}): Streams | null {
  const s = guardSynthetic(privateData.optional('streams.json', StreamsSchema), 'streams.json');
  if (!s || clock(opts.now) - Date.parse(s.fetchedAt) > RETENTION.streamsMaxMs) return null;
  return s;
}

// ---- matchups: stats primary, theory attached (SPEC §5.1, §6) --------------------------

/** SPEC §6 display gates and score formula live in core/stats.ts; re-exported for pages. */
export { GATES, scoreFromDelta };

/**
 * hidden: never shown · grey: shown muted (low sample) · shown: normal row, not a headline pick ·
 * listed: qualifies for the strong/weak/good-with lists. Theory rows use the theory gate
 * (theoryGate) and carry source 'theory' or 'curated' so the UI labels them.
 */
export type MatchupGate = 'hidden' | 'grey' | 'shown' | 'listed';

/** Gate for a stats row (n = games, delta in pp, optional z for high-volume significance gates). */
export function statGate(n: number, delta: number, z?: number): MatchupGate {
  const sample = classifySample(n);
  if (sample !== 'ok') return sample;
  return isListable(n, delta, z === undefined ? {} : { z }) ? 'listed' : 'shown';
}

/**
 * Theory list gate (docs/METHODOLOGY.md §11, docs/THEORY.md). A theory row makes the headline
 * strong/weak/good-with lists when a curator wrote the matchup, or when its generic rules reach
 * listMinScore (x ≥ 0.3: one strong, always-available interaction, or two clear ones; a match that
 * only works through a talent tops out at 62 on its own) AND it is among the hero's
 * listMaxGeneric strongest generic rows in that list. Broad rules match much of the roster, so
 * without the second bar a list could name nearly everyone and say nothing. Every other row stays
 * available below the bar. The engine already drops edges within ±4 of 50.
 */
export const THEORY_GATES = Object.freeze({ listMinScore: 65, listMaxGeneric: 8 });

/** The edge-level part of the theory gate (curated, or generic at listMinScore); see THEORY_GATES. */
export function theoryGate(edge: Pick<Edge, 'score' | 'source'>): MatchupGate {
  return edge.source === 'curated' || edge.score >= THEORY_GATES.listMinScore ? 'listed' : 'shown';
}

/**
 * Applies the list-level part of the theory gate to rows already sorted by byTheory: past the
 * first listMaxGeneric generic rows that clear listMinScore, generic rows go below the bar.
 */
function gateTheoryList(rows: HeroMatchupRow[]): HeroMatchupRow[] {
  let generic = 0;
  return rows.map((r) => {
    if (r.source === 'curated' || r.gate !== 'listed') return r;
    generic += 1;
    return generic <= THEORY_GATES.listMaxGeneric ? r : { ...r, gate: 'shown' };
  });
}

/** Signal value of a 1-100 theory score, as the draft reads it (inverse of 50 + 50·tanh(x)). */
function theoryValue(score: number): number {
  const x = Math.min(0.995, Math.max(-0.995, (score - 50) / 50));
  return Math.atanh(x);
}

/**
 * One row per opponent from both directed counter edges, netted the way the draft scores them
 * (value(hero → other) − value(other → hero)): the opponent goes in "strong against" or "weak
 * against" by the sign, never in both, with the net as its score. Reasons: the winning side's
 * first, then the other side's (so the page still shows what the losing kit has going for it).
 * The row is curated when the winning direction is. Null for an exact wash.
 */
export function netCounter(fwd: Edge | undefined, rev: Edge | undefined): { side: 'strong' | 'weak'; edge: Edge } | null {
  const net = (fwd ? theoryValue(fwd.score) : 0) - (rev ? theoryValue(rev.score) : 0);
  if (Math.abs(net) < 1e-9) return null;
  const [win, lose] = net > 0 ? [fwd, rev] : [rev, fwd];
  if (!win) return null;
  const score = Math.max(1, Math.min(100, Math.round(50 + 50 * Math.tanh(Math.abs(net)))));
  return { side: net > 0 ? 'strong' : 'weak', edge: { ...win, score, reasons: [...win.reasons, ...(lose?.reasons ?? [])] } };
}

export const MODE_LABEL: Record<GameMode, string> = { sl: 'Storm League', qm: 'Quick Match', aram: 'ARAM' };
export const THEORY_LABEL = 'Theory: rule-based from hero kits, not win rates';

export interface HeroMatchupRow {
  /** The other entity. */
  hero: Hero;
  /** Primary edge. strong: a = this hero; weak: a = the other hero; synergy: unordered. */
  edge: Edge;
  score: number;
  source: Edge['source'];
  gate: MatchupGate;
  /** Primary reasons, then theory reasons for the same pair when stats are primary. */
  reasons: Reason[];
  /** The theory edge for the same pair when the primary edge is from stats. */
  theory?: Edge;
}

export interface HeroMatchups {
  hero: Hero;
  primary: 'stats' | 'theory';
  /** Human label of the data basis, e.g. "Win rates · <source> · Storm League · …". */
  label: string;
  mode?: GameMode;
  timeframe?: Timeframe;
  /** This hero counters them (score > 50), best first. */
  strong: HeroMatchupRow[];
  /** They counter this hero (score > 50 from their side), worst first. */
  weak: HeroMatchupRow[];
  /** Good teammates (score > 50), best first. */
  synergy: HeroMatchupRow[];
}

function byScore(a: HeroMatchupRow, b: HeroMatchupRow): number {
  return b.score - a.score || (a.hero.name < b.hero.name ? -1 : a.hero.name > b.hero.name ? 1 : 0);
}

/** Theory rows: hand-written (curated) matchups first, then generic rule matches, each by score. */
function byTheory(a: HeroMatchupRow, b: HeroMatchupRow): number {
  return Number(b.source === 'curated') - Number(a.source === 'curated') || byScore(a, b);
}

/**
 * Theory-only strong/weak/good-with lists for a hero entity (mechanics + curated pairs), whatever
 * stats exist. Counters are netted per opponent (netCounter), so an opponent is in one list only;
 * rows above 50, curated first, gated by THEORY_GATES (curated, or one of the strongest generic).
 */
export function theoryLists(hero: Hero): Pick<HeroMatchups, 'strong' | 'weak' | 'synergy'> {
  return memo(`theoryLists:${hero.id}`, () => {
    const theory = getTheory();
    const row = (edge: Edge, otherId: string): HeroMatchupRow | null => {
      const h = getEntity(otherId);
      return h ? { hero: h, edge, score: edge.score, source: edge.source, gate: theoryGate(edge), reasons: edge.reasons } : null;
    };
    const keep = (r: HeroMatchupRow | null): r is HeroMatchupRow => r !== null;
    const fwd = new Map<string, Edge>();
    const rev = new Map<string, Edge>();
    for (const e of theory.counters) {
      if (e.a === hero.id) fwd.set(e.b, e);
      else if (e.b === hero.id) rev.set(e.a, e);
    }
    const strong: HeroMatchupRow[] = [];
    const weak: HeroMatchupRow[] = [];
    for (const other of [...new Set([...fwd.keys(), ...rev.keys()])].sort()) {
      const net = netCounter(fwd.get(other), rev.get(other));
      const r = net && net.edge.score > 50 ? row(net.edge, other) : null;
      if (r) (net?.side === 'strong' ? strong : weak).push(r);
    }
    return {
      strong: gateTheoryList(strong.sort(byTheory)),
      weak: gateTheoryList(weak.sort(byTheory)),
      synergy: gateTheoryList(
        theory.synergies
          .filter((e) => (e.a === hero.id || e.b === hero.id) && e.score > 50)
          .map((e) => row(e, e.a === hero.id ? e.b : e.a))
          .filter(keep)
          .sort(byTheory),
      ),
    };
  });
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}+${b}` : `${b}+${a}`;
}

/**
 * Strong-vs / weak-vs / good-with lists for a hero page or tooltip. Uses stats edges when the
 * requested stats window exists (theory reasons attached), otherwise theory edges.
 * Accepts a slug or id; members resolve to their composite. Null for unknown heroes.
 */
export function heroEdges(slugOrId: string, opts: { mode?: GameMode; timeframe?: Timeframe } = {}): HeroMatchups | null {
  const hero = getEntity(slugOrId);
  if (!hero) return null;
  const mode = opts.mode ?? 'sl';
  const timeframe = opts.timeframe ?? 'current';
  const theory = getTheory();
  const window = getStatsWindow(mode, timeframe);
  const other = (id: string) => getEntity(id);
  const theoryCounter = memo('theoryCounters', () => new Map(theory.counters.map((e) => [`${e.a}>${e.b}`, e])));
  const theorySynergy = memo('theorySynergies', () => new Map(theory.synergies.map((e) => [pairKey(e.a, e.b), e])));

  const row = (edge: Edge, otherId: string, attached?: Edge): HeroMatchupRow | null => {
    const h = other(otherId);
    if (!h) return null;
    const gate = edge.source === 'stats' ? statGate(edge.n ?? 0, edge.delta ?? 0, edge.z) : theoryGate(edge);
    if (gate === 'hidden') return null;
    return {
      hero: h,
      edge,
      score: edge.score,
      source: edge.source,
      gate,
      reasons: attached ? [...edge.reasons, ...attached.reasons] : edge.reasons,
      ...(attached ? { theory: attached } : {}),
    };
  };
  const keep = (r: HeroMatchupRow | null): r is HeroMatchupRow => r !== null;

  if (window) {
    const strong = window.counters.filter((e) => e.a === hero.id && e.score > 50).map((e) => row(e, e.b, theoryCounter.get(`${e.a}>${e.b}`)));
    const weak = window.counters.filter((e) => e.b === hero.id && e.score > 50).map((e) => row(e, e.a, theoryCounter.get(`${e.a}>${e.b}`)));
    const synergy = window.synergies
      .filter((e) => (e.a === hero.id || e.b === hero.id) && e.score > 50)
      .map((e) => row(e, e.a === hero.id ? e.b : e.a, theorySynergy.get(pairKey(e.a, e.b))));
    return {
      hero,
      primary: 'stats',
      label: `Win rates · ${statsSourceName()} · ${MODE_LABEL[mode]} · ${window.label}`,
      mode,
      timeframe,
      strong: strong.filter(keep).sort(byScore),
      weak: weak.filter(keep).sort(byScore),
      synergy: synergy.filter(keep).sort(byScore),
    };
  }
  return { hero, primary: 'theory', label: THEORY_LABEL, ...theoryLists(hero) };
}

export interface MapFitRow {
  map: GameMap;
  score: number;
  source: 'stats' | 'theory';
  gate: MatchupGate;
  reasons: Reason[];
  /** Stats only: games on the map and shrunk WR delta vs the hero's overall (pp). */
  n?: number;
  delta?: number;
}

/**
 * Best maps for a hero (or best heroes for a map with `heroesForMap`). Stats primary when the
 * window has map data for the hero; theory map-fit otherwise. Best first.
 */
export function heroMapFit(slugOrId: string, opts: { mode?: GameMode; timeframe?: Timeframe } = {}): MapFitRow[] {
  const hero = getEntity(slugOrId);
  if (!hero) return [];
  const theory = getTheory().mapFit.filter((f) => f.hero === hero.id);
  const theoryByMap = new Map(theory.map((f) => [f.map, f]));
  const perMap = getStatsWindow(opts.mode ?? 'sl', opts.timeframe ?? 'current')?.maps[hero.id];
  const rows: MapFitRow[] = [];
  if (perMap) {
    for (const [mapId, s] of Object.entries(perMap)) {
      const map = getMapBySlug(mapId);
      const gate = statGate(s.games, s.delta);
      if (!map || gate === 'hidden') continue;
      const stat: Reason = {
        kind: 'stat',
        text: `${s.delta >= 0 ? '+' : ''}${s.delta.toFixed(1)} pp on ${map.name} over ${s.games} games`,
        n: s.games,
        delta: s.delta,
        source: getStats()?.source ?? 'stats',
      };
      rows.push({ map, score: scoreFromDelta(s.delta), source: 'stats', gate, reasons: [stat, ...(theoryByMap.get(mapId)?.reasons ?? [])], n: s.games, delta: s.delta });
    }
  } else {
    for (const f of theory) {
      const map = getMapBySlug(f.map);
      if (map) rows.push({ map, score: f.score, source: 'theory', gate: 'listed', reasons: f.reasons });
    }
  }
  return rows.sort((a, b) => b.score - a.score || (a.map.name < b.map.name ? -1 : 1));
}

/** Heroes ranked for one map (map pages), same sourcing rules as heroMapFit. */
export function heroesForMap(mapSlug: string, opts: { mode?: GameMode; timeframe?: Timeframe } = {}): { hero: Hero; fit: MapFitRow }[] {
  const out: { hero: Hero; fit: MapFitRow }[] = [];
  for (const hero of getDraftableEntities()) {
    const fit = heroMapFit(hero.id, opts).find((r) => r.map.id === mapSlug);
    if (fit) out.push({ hero, fit });
  }
  return out.sort((a, b) => b.fit.score - a.fit.score || (a.hero.name < b.hero.name ? -1 : 1));
}

// ---- curated inputs and asset checks for the content pages ------------------------------
// Appended (not merged into the imports above) so parallel edits to this file stay additive.
import { existsSync, readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { parseData } from '../../core/schemas.ts';
import { repoRoot } from '../../lib/datadir.ts';
import { AliasesFileSchema, CreatorsFileSchema, type CreatorsFile } from './schema.ts';

/**
 * curated/hots/creators.yaml, validated: the hand-checked video and stream channels
 * (/hots/live/ shows the `featured` Twitch ones as keyless embeds). Null when the file is absent.
 */
export function getCreators(): CreatorsFile | null {
  return memo('creators', () => {
    const file = path.join(repoRoot(), 'curated', 'hots', 'creators.yaml');
    if (!existsSync(file)) return null;
    return parseData(CreatorsFileSchema, parseYaml(readFileSync(file, 'utf8')), file, { roundTrip: false });
  });
}

/** Map slug → extra lowercase aliases from curated/hots/aliases.yaml (maps carry none in maps.json). */
export function getMapAliases(): ReadonlyMap<string, readonly string[]> {
  return memo('map-aliases', () => {
    const file = path.join(repoRoot(), 'curated', 'hots', 'aliases.yaml');
    if (!existsSync(file)) return new Map<string, readonly string[]>();
    const parsed = parseData(AliasesFileSchema, parseYaml(readFileSync(file, 'utf8')), file, { roundTrip: false });
    return new Map(Object.entries(parsed.maps));
  });
}

/**
 * True when an image path from the data (`img/icons/….webp`) exists in the game's data dir and
 * will therefore be staged. Pages use it to draw a placeholder instead of linking a missing
 * file (fixtures ship portraits and map art, not every ability icon).
 */
export function hasAsset(rel: string): boolean {
  const cache = memo('assets', () => new Map<string, boolean>());
  let hit = cache.get(rel);
  if (hit === undefined) {
    hit = !rel.split('/').includes('..') && existsSync(path.join(gameDataDir(GAME), ...rel.split('/')));
    cache.set(rel, hit);
  }
  return hit;
}
