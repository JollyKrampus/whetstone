/**
 * Assembles patches.json from parsed articles and data diffs. Pure.
 *
 *  1. Builds: a live/balance/hotfix record gets the first live build published within 3 days
 *     on or after its date (heroes-data2 release dates); PTR records get PTR builds the same way.
 *  2. version (major): from the build, else from the newest known build published by then,
 *     else from the oldest known build (articles older than every known build).
 *  3. Diffs: a record whose build is a diff's `to` gains (a) "game data" numbers on lines that
 *     name a changed ability/talent but carry no numbers and (b) lines for heroes the article
 *     does not mention (section "Game data"). A diff no article matches becomes its own
 *     "undocumented update" record.
 *  4. Ids `<date>-<kind>[-n]`, newest first.
 */
import type { Diff, DiffEntry, Patch, PatchChange, PatchHero } from '../../schema.ts';
import { addDays, compareBuilds, compareStrings, hash16, isPtrBuild, majorOf } from '../util.ts';
import { verdictOf, type ParsedPatch } from './patches.ts';

export interface BuildDate {
  build: string;
  /** Release (publish) date, YYYY-MM-DD. */
  date: string;
}

/** How long after an article its build may be published. */
const BUILD_WINDOW_DAYS = 3;

export function buildForRecord(rec: Pick<ParsedPatch, 'date' | 'kind'>, builds: readonly BuildDate[]): string | undefined {
  const ptr = rec.kind === 'ptr';
  const until = addDays(rec.date, BUILD_WINDOW_DAYS);
  return [...builds]
    .filter((b) => isPtrBuild(b.build) === ptr && b.date >= rec.date && b.date <= until)
    .sort((a, b) => compareStrings(a.date, b.date) || compareBuilds(a.build, b.build))[0]?.build;
}

export function majorForDate(date: string, builds: readonly BuildDate[]): string | undefined {
  const sorted = [...builds].sort((a, b) => compareStrings(a.date, b.date) || compareBuilds(a.build, b.build));
  const until = addDays(date, BUILD_WINDOW_DAYS);
  const before = sorted.filter((b) => b.date <= until);
  const pick = before[before.length - 1] ?? sorted[0];
  return pick ? majorOf(pick.build) : undefined;
}

function fmt(v: string | number | undefined): string {
  return v === undefined ? '—' : String(v);
}

function numberOf(v: string | number | undefined): number | null {
  if (typeof v === 'number') return v;
  const m = /-?\d+(?:\.\d+)?/.exec(v ?? '');
  return m ? Number(m[0]) : null;
}

const LOWER_BETTER_FIELDS = new Set(['cooldown', 'cost', 'delay', 'mana']);

/** Direction of a numeric diff entry (cooldowns and costs are better when lower). */
export function diffDirection(e: DiffEntry): PatchChange['dir'] {
  if (e.kind === 'ability-added' || e.kind === 'talent-added' || e.kind === 'ability-removed' || e.kind === 'talent-removed' || e.kind === 'talent-moved') return 'change';
  if (e.field === 'text') return 'change';
  const o = numberOf(e.old);
  const n = numberOf(e.new);
  if (o === null || n === null || o === n) return 'change';
  const lowerBetter = LOWER_BETTER_FIELDS.has(e.field ?? '') || (e.kind === 'stat' && /cooldown/i.test(e.target));
  return (n > o) !== lowerBetter ? 'buff' : 'nerf';
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Section of every line derived from game data (never from article text). */
export const GAME_DATA_SECTION = 'Game data';

/** One short line of our own for a diff entry. */
export function diffLine(e: DiffEntry): PatchChange {
  const base = (text: string): PatchChange => {
    const c: PatchChange = { section: GAME_DATA_SECTION, text };
    if (e.kind !== 'stat') c.target = e.target;
    if (e.level) c.level = e.level;
    const dir = diffDirection(e);
    if (dir) c.dir = dir;
    return c;
  };
  switch (e.kind) {
    case 'stat':
      return base(`${e.target} ${fmt(e.old)} → ${fmt(e.new)}.`);
    case 'ability-added':
      return base('New ability.');
    case 'ability-removed':
      return base('Ability removed.');
    case 'talent-added':
      return base(`New level ${e.level ?? '?'} talent.`);
    case 'talent-removed':
      return base('Talent removed.');
    case 'talent-moved':
      return base(`Moved from level ${fmt(e.old)} to level ${fmt(e.new)}.`);
    default:
      if (e.field === 'text') return base('Tooltip text changed.');
      return base(`${capitalise(e.field ?? 'value')} ${fmt(e.old)} → ${fmt(e.new)}.`);
  }
}

/** Adds diff numbers and silent hero changes to a record (mutates a copy). */
export function enrichWithDiff(rec: Patch, diff: Diff, newHeroes: ReadonlySet<string>): Patch {
  const heroes: Record<string, PatchHero> = {};
  for (const [id, h] of Object.entries(rec.heroes)) heroes[id] = { ...h, changes: h.changes.map((c) => ({ ...c })) };
  for (const [id, entries] of Object.entries(diff.heroes)) {
    if (newHeroes.has(id)) continue;
    const existing = heroes[id];
    if (existing) {
      for (const c of existing.changes) {
        if (!c.target || /\d/.test(c.text)) continue;
        const nums = entries.filter((e) => e.target.toLowerCase() === c.target?.toLowerCase() && e.field !== 'text' && e.old !== undefined && e.new !== undefined).slice(0, 2);
        if (nums.length === 0) continue;
        const extra = nums.map((e) => `${e.field ?? 'value'} ${fmt(e.old)} → ${fmt(e.new)}`).join('; ');
        const text = `${c.text.replace(/\.$/, '')} (game data: ${extra}).`;
        if (text.length <= 400) c.text = text;
      }
      continue;
    }
    const changes = entries.map(diffLine);
    heroes[id] = { verdict: verdictOf(changes), changes };
  }
  return { ...rec, heroes: Object.fromEntries(Object.entries(heroes).sort(([a], [b]) => compareStrings(a, b))) };
}

function silentRecord(diff: Diff, date: string): Omit<Patch, 'id'> {
  const heroes: Record<string, PatchHero> = {};
  for (const [id, entries] of Object.entries(diff.heroes).sort(([a], [b]) => compareStrings(a, b))) {
    const changes = entries.map(diffLine);
    heroes[id] = { verdict: verdictOf(changes), changes };
  }
  return {
    version: majorOf(diff.to),
    build: diff.to,
    date,
    title: `Undocumented game data update (build ${diff.to})`,
    url: `https://github.com/HeroesToolChest/heroes-data2/releases/tag/v${diff.to}`,
    kind: 'hotfix',
    contentHash: hash16(JSON.stringify(diff.heroes)),
    general: [],
    heroes,
  };
}

/** Assigns ids `<date>-<kind>`, `-2`, `-3`… in (date, title, hash) order; returns newest first. */
export function assignIds(records: Omit<Patch, 'id'>[]): Patch[] {
  const sorted = [...records].sort((a, b) => compareStrings(a.date, b.date) || compareStrings(a.kind, b.kind) || compareStrings(a.title, b.title) || compareStrings(a.contentHash, b.contentHash));
  const used = new Map<string, number>();
  const withIds = sorted.map((r): Patch => {
    const base = `${r.date}-${r.kind}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    return { id: n === 1 ? base : `${base}-${n}`, ...r };
  });
  return withIds.sort((a, b) => compareStrings(b.date, a.date) || compareStrings(b.id, a.id));
}

export interface AssembleOptions {
  /** Known builds with release dates (heroes-data2). */
  builds: readonly BuildDate[];
  /** Diffs (diffs.json), any order. */
  diffs: readonly Diff[];
  /** Records before this date are dropped (YYYY-MM-DD). */
  since: string;
  /** Major used when no build date is known at all. */
  fallbackMajor: string;
}

export function assemblePatches(parsed: readonly ParsedPatch[], opts: AssembleOptions): Patch[] {
  const records: Omit<Patch, 'id'>[] = [];
  const usedBuilds = new Set<string>();
  const diffByTo = new Map(opts.diffs.map((d) => [d.to, d]));
  for (const p of parsed) {
    if (p.date < opts.since) continue;
    const build = p.build ?? buildForRecord(p, opts.builds);
    const version = build ? majorOf(build) : (majorForDate(p.date, opts.builds) ?? opts.fallbackMajor);
    let rec: Patch = { id: '', version, ...p };
    if (build) {
      rec.build = build;
      usedBuilds.add(build);
      const diff = diffByTo.get(build);
      if (diff) rec = enrichWithDiff(rec, diff, new Set(p.newHeroes ?? []));
    }
    const { id: _id, ...rest } = rec;
    records.push(rest);
  }
  const releaseDate = new Map(opts.builds.map((b) => [b.build, b.date]));
  for (const d of opts.diffs) {
    if (usedBuilds.has(d.to) || isPtrBuild(d.to)) continue;
    const date = d.date ?? releaseDate.get(d.to);
    if (!date || date < opts.since) continue;
    if (Object.keys(d.heroes).length === 0) continue;
    records.push(silentRecord(d, date));
  }
  return assignIds(records);
}

/** Date for a diff: the date of the record that documents its build, else the build's release date. */
export function diffDates(diffs: readonly Diff[], patches: readonly Patch[], builds: readonly BuildDate[]): Diff[] {
  const byBuild = new Map<string, string>();
  for (const p of patches) if (p.build && p.kind !== 'ptr') byBuild.set(p.build, byBuild.get(p.build) && (byBuild.get(p.build) as string) < p.date ? (byBuild.get(p.build) as string) : p.date);
  const release = new Map(builds.map((b) => [b.build, b.date]));
  return diffs.map((d) => {
    const date = byBuild.get(d.to) ?? d.date ?? release.get(d.to);
    return date ? { ...d, date } : d;
  });
}
