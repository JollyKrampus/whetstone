/**
 * meta.json pieces that are pure decisions: when the current major started and the counts shown
 * on the home page (keys are sorted when written, and the home page shows the first three, so
 * the headline counts come first alphabetically: heroes, maps, patches).
 */
import type { Hero, Patch, Pro } from '../../schema.ts';
import { TALENT_TIERS } from '../../schema.ts';
import { compareStrings, isPtrBuild, majorOf } from '../util.ts';
import type { BuildDate } from './patchset.ts';

/**
 * Start date of `major`: its first live patch or balance notes, else the last-good value for the
 * same major, else its first heroes-data2 release, else today.
 */
export function majorSince(input: {
  major: string;
  patches: readonly Patch[];
  buildDates: readonly BuildDate[];
  previous: { major: string; majorSince: string } | null;
  today: string;
}): string {
  const fromNotes = input.patches
    .filter((p) => p.version === input.major && (p.kind === 'patch' || p.kind === 'balance'))
    .map((p) => p.date)
    .sort(compareStrings)[0];
  if (fromNotes) return fromNotes;
  if (input.previous?.major === input.major) return input.previous.majorSince;
  const fromBuilds = input.buildDates
    .filter((b) => !isPtrBuild(b.build) && majorOf(b.build) === input.major)
    .map((b) => b.date)
    .sort(compareStrings)[0];
  return fromBuilds ?? input.today;
}

export function hotsCounts(input: { heroes: readonly Hero[]; mapCount: number; patches: readonly Patch[]; pro: Pro | null; theory: { counters: unknown[]; synergies: unknown[] } }): Record<string, number> {
  const playable = input.heroes.filter((h) => !h.members);
  const counts: Record<string, number> = {
    heroes: playable.length,
    maps: input.mapCount,
    patches: input.patches.length,
    talents: playable.reduce((s, h) => s + TALENT_TIERS.reduce((t, tier) => t + h.talents[tier].length, 0), 0),
    theoryCounters: input.theory.counters.length,
    theorySynergies: input.theory.synergies.length,
  };
  if (input.pro) counts.proMaps = input.pro.totals.maps;
  return counts;
}
