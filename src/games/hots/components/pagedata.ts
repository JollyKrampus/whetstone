/**
 * Build-time view models for the HotS content pages, assembled from the loaders in load.ts.
 * Node-only (it imports load.ts): call it from .astro frontmatter or static endpoints, never
 * from an island. Everything here is deterministic for a given data snapshot.
 */
import type { SourceRef } from '../../../core/game.ts';
import { assignTiers, HOTS_TIERS, type TierInput, type TierResult } from '../../../core/tiers.ts';
import { sourcesFor } from '../../registry.ts';
import {
  getCreators,
  getEntity,
  getHeroes,
  getMeta,
  getPatches,
  getStats,
  getStatsWindow,
  getTheory,
  getVideos,
  hasAsset,
  type HeroMatchupRow,
  type MapFitRow,
  MODE_LABEL,
  theoryLists,
} from '../load.ts';
import type { GameMap, GameMode, Hero, Patch, StatsWindow, Timeframe, Video } from '../schema.ts';
import { heroHref, heroPortrait, patchHref } from '../view.ts';
import type { CatchUpData } from './catchup.ts';
import { countDirs, emptyCounts, netVerdict, type DirCounts, type Verdict } from './labels.ts';

// ---- data mode -----------------------------------------------------------------------------

export const MODES: readonly GameMode[] = ['sl', 'qm', 'aram'];

export interface PeriodOption {
  id: Timeframe;
  label: string;
  note: string;
}

export interface ModeOption {
  id: GameMode;
  label: string;
  /** Current first; previous only when the data has that window. */
  periods: PeriodOption[];
}

function periodNote(w: StatsWindow): string {
  return w.pooled ? `${w.major}, blended with ${w.pooled.major}` : w.major;
}

/** Modes that have statistics in this build (empty in theory-only mode). */
export function statsModes(): ModeOption[] {
  if (!getStats()) return [];
  const out: ModeOption[] = [];
  for (const id of MODES) {
    const current = getStatsWindow(id, 'current');
    if (!current) continue;
    const previous = getStatsWindow(id, 'previous');
    const periods: PeriodOption[] = [{ id: 'current', label: 'Current patch', note: periodNote(current) }];
    if (previous) periods.push({ id: 'previous', label: 'Previous patch', note: periodNote(previous) });
    out.push({ id, label: MODE_LABEL[id], periods });
  }
  return out;
}

/** Union of the periods offered by any mode, in display order. */
export function allPeriods(modes: readonly ModeOption[]): PeriodOption[] {
  const byId = new Map<Timeframe, PeriodOption>();
  for (const m of modes) for (const p of m.periods) if (!byId.has(p.id)) byId.set(p.id, { ...p, note: '' });
  return (['current', 'previous'] as const).flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

/** SourceRef for Heroes Profile (inline credit wherever stats show). */
export function hpSource(): SourceRef[] {
  return sourcesFor('hots', ['heroesprofile']);
}

/** SourceRef.id -> display name, for reason lines. */
export function sourceNames(): Record<string, string> {
  return Object.fromEntries(sourcesFor('hots').map((s) => [s.id, s.name]));
}

// ---- tiers ---------------------------------------------------------------------------------

export const TIER_TITLE: Readonly<Record<string, string>> = {
  T1: 'Best',
  T2: 'Good',
  T3: 'Average',
  T4: 'Below average',
  T5: 'Weak',
};

function tierInputs(w: StatsWindow, previous?: { window: StatsWindow; tiers: Map<string, TierResult> }): TierInput[] {
  return Object.entries(w.heroes)
    .map(([id, s]): TierInput => {
      const input: TierInput = { id, value: s.shrunk, n: s.games, banRate: s.ban };
      const prevStat = previous?.window.heroes[id];
      const prevTier = previous?.tiers.get(id);
      if (prevStat || prevTier) {
        input.previous = {
          ...(prevStat ? { value: prevStat.shrunk } : {}),
          ...(prevTier && !prevTier.early ? { tier: prevTier.tier } : {}),
        };
      }
      return input;
    })
    .sort((a, b) => (a.id < b.id ? -1 : 1));
}

/**
 * Fixed-band tiers (SPEC §6) for one stats window. For the current window the previous one
 * supplies the change arrows and Δ. Null when the window does not exist.
 */
export function tierResults(mode: GameMode, timeframe: Timeframe): TierResult[] | null {
  const w = getStatsWindow(mode, timeframe);
  if (!w) return null;
  const prevWindow = timeframe === 'current' ? getStatsWindow(mode, 'previous') : null;
  const previous = prevWindow
    ? { window: prevWindow, tiers: new Map(assignTiers(tierInputs(prevWindow), HOTS_TIERS).map((t) => [t.id, t])) }
    : undefined;
  return assignTiers(tierInputs(w, previous), HOTS_TIERS);
}

export interface BanRow {
  hero: Hero;
  ban: number;
  pick: number;
  games: number;
}

/**
 * Ban priority (roadmap T2) for one stats window: the most banned heroes, ties broken by pick
 * rate, then name. Heroes below the tier sample gate are left out, like their tiers.
 */
export function banPriority(mode: GameMode, timeframe: Timeframe, limit = 10): BanRow[] {
  const w = getStatsWindow(mode, timeframe);
  if (!w) return [];
  return Object.entries(w.heroes)
    .flatMap(([id, s]): BanRow[] => {
      const hero = getEntity(id);
      return hero && s.games >= HOTS_TIERS.minN ? [{ hero, ban: s.ban, pick: s.pick, games: s.games }] : [];
    })
    .sort((a, b) => b.ban - a.ban || b.pick - a.pick || (a.hero.name < b.hero.name ? -1 : 1))
    .slice(0, limit);
}

/** Storm League (current patch) tier per entity id, for grid and header badges. */
export function tierById(): Map<string, TierResult> {
  return new Map((tierResults('sl', 'current') ?? []).map((t) => [t.id, t]));
}

// ---- matchups ------------------------------------------------------------------------------

export interface MatchupLists {
  strong: HeroMatchupRow[];
  weak: HeroMatchupRow[];
  synergy: HeroMatchupRow[];
}

/**
 * Theory-only lists for a hero (mechanics + curated pairs), whether or not stats exist, so a
 * stats page can still show what the kits say: load.ts theoryLists (gated, curated first).
 */
export function theoryMatchups(slugOrId: string): MatchupLists | null {
  const hero = getEntity(slugOrId);
  return hero ? theoryLists(hero) : null;
}

/** Rows that qualify for the headline list (SPEC §6 gates) and the rest (shown below the bar). */
export function splitByGate<T extends { gate: string }>(rows: readonly T[]): { listed: T[]; other: T[] } {
  return { listed: rows.filter((r) => r.gate === 'listed'), other: rows.filter((r) => r.gate !== 'listed') };
}

/** Theory map fit for a hero, best first (independent of stats). */
export function theoryMapFit(hero: Hero, maps: readonly GameMap[]): MapFitRow[] {
  const byId = new Map(maps.map((m) => [m.id, m]));
  return getTheory()
    .mapFit.filter((f) => f.hero === hero.id)
    .flatMap((f): MapFitRow[] => {
      const map = byId.get(f.map);
      return map ? [{ map, score: f.score, source: 'theory', gate: 'listed', reasons: f.reasons }] : [];
    })
    .sort((a, b) => b.score - a.score || (a.map.name < b.map.name ? -1 : 1));
}

/** Theory map fit of every hero on one map, best first (independent of stats). */
export function theoryHeroesForMap(map: GameMap): { hero: Hero; fit: MapFitRow }[] {
  return getTheory()
    .mapFit.filter((f) => f.map === map.id)
    .flatMap((f): { hero: Hero; fit: MapFitRow }[] => {
      const hero = getEntity(f.hero);
      return hero ? [{ hero, fit: { map, score: f.score, source: 'theory', gate: 'listed', reasons: f.reasons } }] : [];
    })
    .sort((a, b) => b.fit.score - a.fit.score || (a.hero.name < b.hero.name ? -1 : 1));
}

// ---- patches -------------------------------------------------------------------------------

/** Newest live patch (PTR notes are not live). */
export function latestLivePatch(): Patch | undefined {
  return getPatches().find((p) => p.kind !== 'ptr');
}

export interface MomentumRow {
  hero: Hero;
  counts: DirCounts;
  verdict: Verdict;
  /** Newest change date. */
  latest: string;
  lines: number;
  patches: { id: string; title: string; date: string; kind: Patch['kind']; href: string }[];
}

/**
 * Patch momentum: every hero touched by the live patches of `major` (falling back to the two
 * newest live patches when that major has none), with buff/nerf counts. Newest change first.
 */
export function patchMomentum(major: string): { patches: Patch[]; rows: MomentumRow[] } {
  const live = getPatches().filter((p) => p.kind !== 'ptr');
  const inMajor = live.filter((p) => p.version === major);
  const patches = inMajor.length > 0 ? inMajor : live.slice(0, 2);
  const rows = new Map<string, MomentumRow>();
  for (const patch of patches) {
    for (const [id, entry] of Object.entries(patch.heroes)) {
      const hero = getEntity(id);
      if (!hero) continue;
      let row = rows.get(hero.id);
      if (!row) {
        row = { hero, counts: emptyCounts(), verdict: 'change', latest: patch.date, lines: 0, patches: [] };
        rows.set(hero.id, row);
      }
      countDirs(entry.changes, row.counts);
      row.lines += entry.changes.length;
      if (entry.verdict === 'new') row.verdict = 'new';
      if (patch.date > row.latest) row.latest = patch.date;
      if (!row.patches.some((p) => p.id === patch.id)) {
        row.patches.push({ id: patch.id, title: patch.title, date: patch.date, kind: patch.kind, href: patchHref(patch) });
      }
    }
  }
  for (const row of rows.values()) if (row.verdict !== 'new') row.verdict = netVerdict(row.counts);
  return {
    patches,
    rows: [...rows.values()].sort(
      (a, b) => (a.latest < b.latest ? 1 : a.latest > b.latest ? -1 : 0) || b.lines - a.lines || (a.hero.name < b.hero.name ? -1 : 1),
    ),
  };
}

/** Compact patch history for the catch-up page and its static JSON endpoint. */
export function catchUpData(): CatchUpData {
  const heroes: CatchUpData['heroes'] = {};
  for (const hero of getHeroes()) {
    const entity = getEntity(hero) ?? hero;
    heroes[hero.id] = {
      id: hero.id,
      name: hero.name,
      href: heroHref(entity),
      portrait: hasAsset(hero.portrait) ? heroPortrait(hero) : null,
    };
  }
  const patches = getPatches().map((p) => ({
    id: p.id,
    date: p.date,
    title: p.title,
    kind: p.kind,
    version: p.version,
    href: patchHref(p),
    general: p.general,
    newHeroes: p.newHeroes ?? [],
    heroes: Object.fromEntries(
      Object.entries(p.heroes).map(([id, e]) => [
        id,
        {
          ...(e.verdict ? { verdict: e.verdict } : {}),
          changes: e.changes.map((c) => ({
            section: c.section,
            ...(c.target ? { target: c.target } : {}),
            text: c.text,
            ...(c.dir ? { dir: c.dir } : {}),
          })),
        },
      ]),
    ),
  }));
  return { heroes, patches };
}

/** The current major's start date (meta.extra.majorSince). */
export function majorSince(): string {
  return getMeta().extra.majorSince;
}

// ---- videos, creators ------------------------------------------------------------------------

/** YouTube videos tagged with this hero (class C, within retention), newest first. */
export function heroVideos(hero: Hero): { fetchedAt: string; videos: Video[] } | null {
  const v = getVideos();
  if (!v) return null;
  const videos = v.videos.filter((x) => x.heroes.includes(hero.id)).sort((a, b) => (a.published < b.published ? 1 : -1));
  return videos.length > 0 ? { fetchedAt: v.fetchedAt, videos } : null;
}

/** Curated channels flagged `featured` that have a Twitch login (keyless embeds on /hots/live/). */
export function featuredChannels(): { id: string; name: string; login: string; notes?: string; lang: string }[] {
  return (getCreators()?.creators ?? [])
    .filter((c) => c.featured && c.twitch)
    .map((c) => ({ id: c.id, name: c.name, login: c.twitch!.login, lang: c.lang, ...(c.notes ? { notes: c.notes } : {}) }));
}

