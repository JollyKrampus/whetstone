/**
 * "Catch up since you last played" (/hots/catch-up/): every hero change in the patches released
 * after a date, grouped by hero with the biggest changes first, plus new heroes and general
 * notes. Pure and browser-safe: the page computes the default view at build time and the island
 * recomputes it in the browser from the static changes.json endpoint.
 */
import { parseHashParams } from '../../../core/urlstate.ts';
import { countDirs, emptyCounts, type ChangeDir, type DirCounts, type PatchKind, type Verdict } from './labels.ts';

export interface CatchUpHeroRef {
  /** Hero id as patch notes use it (members such as CCho, not composites). */
  id: string;
  name: string;
  /** Hero page (the composite's page for members). Empty when the hero has no page. */
  href: string;
  /** Portrait URL, or null when there is none. */
  portrait: string | null;
}

export interface CatchUpChange {
  section: string;
  target?: string;
  text: string;
  dir?: ChangeDir;
}

export interface CatchUpPatch {
  id: string;
  date: string;
  title: string;
  kind: PatchKind;
  version: string;
  /** Game build the notes are for ('2.57.0.98285'), when the notes name it. */
  build?: string;
  href: string;
  general: string[];
  newHeroes: string[];
  heroes: Record<string, { verdict?: Verdict; changes: CatchUpChange[] }>;
}

export interface CatchUpData {
  heroes: Record<string, CatchUpHeroRef>;
  /** Newest first. */
  patches: CatchUpPatch[];
}

export interface CatchUpLine extends CatchUpChange {
  patchId: string;
  patchTitle: string;
  patchHref: string;
  date: string;
  kind: PatchKind;
}

export interface CatchUpGroup {
  hero: CatchUpHeroRef;
  /** Newest patch first, in note order within a patch. */
  lines: CatchUpLine[];
  counts: DirCounts;
  /** Any line marked as a rework (or a rework verdict). */
  rework: boolean;
  /** Released as a new hero in the window. */
  isNew: boolean;
  /** Date of the newest change. */
  latest: string;
}

export type CatchUpPatchSummary = Pick<CatchUpPatch, 'id' | 'date' | 'title' | 'kind' | 'version' | 'href'>;

export interface CatchUpResult {
  since: string;
  /** Patches after `since`, newest first. */
  patches: CatchUpPatchSummary[];
  groups: CatchUpGroup[];
  newHeroes: CatchUpHeroRef[];
  general: { patchId: string; title: string; href: string; date: string; lines: string[] }[];
  /** Change lines over every hero. */
  counts: DirCounts;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date written as YYYY-MM-DD. */
export function isIsoDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const m = DATE.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

/** Calendar arithmetic in UTC: shiftDate('2026-09-28', -1) === '2026-09-27'. */
export function shiftDate(iso: string, days: number): string {
  const t = Date.parse(`${iso}T00:00:00Z`);
  if (!Number.isFinite(t)) return iso;
  return new Date(t + days * 86_400_000).toISOString().slice(0, 10);
}

/** The default "last played" date: the day before the current major went live. */
export function defaultSince(majorSince: string): string {
  return shiftDate(majorSince, -1);
}

/** `since` from a location hash such as "#since=2026-09-01"; null when absent or invalid. */
export function readSince(hash: string): string | null {
  const raw = parseHashParams(hash)['since'];
  return isIsoDate(raw) ? raw : null;
}

export function sinceHash(since: string): string {
  return `#since=${since}`;
}

/**
 * Earliest live note per major version seen in the notes, newest first. This is only the start
 * of the major when the notes reach back that far: see knownMajorStarts.
 */
export function majorStarts(patches: readonly Pick<CatchUpPatch, 'version' | 'date' | 'kind'>[]): { version: string; date: string }[] {
  const first = new Map<string, string>();
  for (const p of patches) {
    if (p.kind === 'ptr') continue;
    const seen = first.get(p.version);
    if (seen === undefined || p.date < seen) first.set(p.version, p.date);
  }
  return [...first.entries()]
    .map(([version, date]) => ({ version, date }))
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.version < b.version ? 1 : -1));
}

export type CatchUpAnchor = { kind: 'major'; version: string; date: string } | { kind: 'oldest'; date: string };

/**
 * Dates a "catch up since" shortcut can honestly name, newest first:
 * - the current major, whose go-live date the data knows (meta.extra.majorSince);
 * - an older major only when its first build (`<version>.0.…`) is in the notes, so its earliest
 *   note really is its start (the feed reaches back only so far, and the oldest major on file
 *   usually started long before its first note here);
 * - the oldest live note on file, as its own anchor, when no major above already starts there.
 * Never "Before 2.55" for a major whose start the notes do not cover.
 */
export function knownMajorStarts(
  patches: readonly Pick<CatchUpPatch, 'version' | 'date' | 'kind' | 'build'>[],
  current: { version: string; since: string },
): CatchUpAnchor[] {
  const live = patches.filter((p) => p.kind !== 'ptr');
  const anchors: CatchUpAnchor[] = [{ kind: 'major', version: current.version, date: current.since }];
  for (const m of majorStarts(live)) {
    if (m.version === current.version) continue;
    const first = live.filter((p) => p.version === m.version && p.build?.startsWith(`${m.version}.0.`)).map((p) => p.date);
    if (first.length > 0) anchors.push({ kind: 'major', version: m.version, date: first.reduce((a, b) => (b < a ? b : a)) });
  }
  const oldest = live.map((p) => p.date).reduce<string | null>((a, b) => (a === null || b < a ? b : a), null);
  if (oldest && !anchors.some((a) => a.date <= oldest)) anchors.push({ kind: 'oldest', date: oldest });
  return anchors.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
}

function heroRef(data: CatchUpData, id: string): CatchUpHeroRef {
  return data.heroes[id] ?? { id, name: id, href: '', portrait: null };
}

/** Everything that changed after `since` (exclusive), PTR notes excluded (they are not live). */
export function catchUp(data: CatchUpData, since: string): CatchUpResult {
  const patches = data.patches.filter((p) => p.date > since && p.kind !== 'ptr');
  const groups = new Map<string, CatchUpGroup>();
  const newIds = new Set<string>();
  const counts = emptyCounts();
  const general: CatchUpResult['general'] = [];

  for (const patch of patches) {
    for (const id of patch.newHeroes) newIds.add(id);
    if (patch.general.length > 0) {
      general.push({ patchId: patch.id, title: patch.title, href: patch.href, date: patch.date, lines: [...patch.general] });
    }
    for (const [id, entry] of Object.entries(patch.heroes)) {
      if (entry.verdict === 'new') newIds.add(id);
      let group = groups.get(id);
      if (!group) {
        group = { hero: heroRef(data, id), lines: [], counts: emptyCounts(), rework: false, isNew: false, latest: patch.date };
        groups.set(id, group);
      }
      if (entry.verdict === 'rework') group.rework = true;
      if (patch.date > group.latest) group.latest = patch.date;
      for (const change of entry.changes) {
        group.lines.push({ ...change, patchId: patch.id, patchTitle: patch.title, patchHref: patch.href, date: patch.date, kind: patch.kind });
        if (change.dir === 'rework') group.rework = true;
      }
      countDirs(entry.changes, group.counts);
      countDirs(entry.changes, counts);
    }
  }

  for (const id of newIds) {
    const group = groups.get(id);
    if (group) group.isNew = true;
  }

  const ordered = [...groups.values()].sort(
    (a, b) =>
      b.lines.length - a.lines.length ||
      Number(b.rework) - Number(a.rework) ||
      (a.hero.name < b.hero.name ? -1 : a.hero.name > b.hero.name ? 1 : 0),
  );

  return {
    since,
    patches: patches.map(({ id, date, title, kind, version, href }) => ({ id, date, title, kind, version, href })),
    groups: ordered,
    newHeroes: [...newIds].map((id) => heroRef(data, id)).sort((a, b) => (a.name < b.name ? -1 : 1)),
    general,
    counts,
  };
}
