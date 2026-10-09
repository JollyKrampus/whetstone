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
import type { Edge, Reason } from '../../core/game.ts';
import { createCachedLoader } from '../../core/schemas.ts';
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

/** True when the hero (or any member of a composite) is in the free rotation. */
export function isFreeToPlay(hero: Hero): boolean {
  const rotation = getRotation();
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

/** Heroes Profile aggregates, or null when HP is off / not fetched. */
export function getStats(): Stats | null {
  return guardSynthetic(privateData.optional('stats.json', StatsSchema), 'stats.json');
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
 * Theory list gate (docs/METHODOLOGY.md §13, docs/THEORY.md). A theory edge makes the headline
 * strong/weak/good-with lists when a curator wrote the matchup, or when the generic rules alone
 * reach listMinScore (x ≥ 0.3: one strong, always-available interaction, or two clear ones; a match
 * that only works through a talent tops out at 62 on its own). Weaker generic edges
 * stay available below the bar. The engine already drops edges within ±4 of 50.
 */
export const THEORY_GATES = Object.freeze({ listMinScore: 65 });

export function theoryGate(edge: Pick<Edge, 'score' | 'source'>): MatchupGate {
  return edge.source === 'curated' || edge.score >= THEORY_GATES.listMinScore ? 'listed' : 'shown';
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
  /** Human label of the data basis, e.g. "Win rates · Heroes Profile · Storm League · …". */
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
 * stats exist: rows above 50, gated by theoryGate, curated first.
 */
export function theoryLists(hero: Hero): Pick<HeroMatchups, 'strong' | 'weak' | 'synergy'> {
  return memo(`theoryLists:${hero.id}`, () => {
    const theory = getTheory();
    const row = (edge: Edge, otherId: string): HeroMatchupRow | null => {
      const h = getEntity(otherId);
      return h ? { hero: h, edge, score: edge.score, source: edge.source, gate: theoryGate(edge), reasons: edge.reasons } : null;
    };
    const keep = (r: HeroMatchupRow | null): r is HeroMatchupRow => r !== null;
    return {
      strong: theory.counters.filter((e) => e.a === hero.id && e.score > 50).map((e) => row(e, e.b)).filter(keep).sort(byTheory),
      weak: theory.counters.filter((e) => e.b === hero.id && e.score > 50).map((e) => row(e, e.a)).filter(keep).sort(byTheory),
      synergy: theory.synergies
        .filter((e) => (e.a === hero.id || e.b === hero.id) && e.score > 50)
        .map((e) => row(e, e.a === hero.id ? e.b : e.a))
        .filter(keep)
        .sort(byTheory),
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
      label: `Win rates · Heroes Profile · ${MODE_LABEL[mode]} · ${window.label}`,
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
        source: 'heroesprofile',
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
