/**
 * Regulation windows from curated/pokemon/regulations.yaml (UTC). Pure helpers plus one
 * loader; the site's load.ts applies the same "current regulation" rule at build time.
 *
 * Rollover: when the clock enters a new window, the new regulation becomes current at once.
 * Sources that have no data for it yet keep their previous regulation's files and are listed
 * in meta.extra.warmingUp until they catch up (Smogon publishes monthly, so its first month
 * of a regulation can take up to ~4 weeks; Limitless and replays usually follow within days).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseData } from '../../../core/schemas.ts';
import { RegulationsFileSchema, type Regulation, type RegulationsFile } from '../schema.ts';

export const REGULATIONS_FILE = 'curated/pokemon/regulations.yaml';

/** Ends are inclusive to the minute (official windows end at hh:59). */
const MINUTE_MS = 60_000;

type Season = Regulation['seasons'][number];

export function loadRegulations(root: string): RegulationsFile {
  const file = path.join(root, REGULATIONS_FILE);
  return parseData(RegulationsFileSchema, parseYaml(readFileSync(file, 'utf8')), REGULATIONS_FILE);
}

export function isInWindow(w: { start: string; end: string }, t: number): boolean {
  return Date.parse(w.start) <= t && t < Date.parse(w.end) + MINUTE_MS;
}

/**
 * Regulation in force at `now`; between windows (or after the last one) the latest that has
 * started, so the site keeps the most recent rules; before the first one, the first.
 */
export function currentRegulation(file: RegulationsFile, now: Date): Regulation {
  const t = now.getTime();
  const regs = file.regulations;
  const inWindow = regs.find((r) => isInWindow(r, t));
  const started = regs.filter((r) => Date.parse(r.start) <= t);
  const pick = inWindow ?? started.at(-1) ?? regs[0];
  if (!pick) throw new Error(`${REGULATIONS_FILE} lists no regulations`);
  return pick;
}

/** The regulation listed right before `reg` (windows are sorted), or null. */
export function previousRegulation(file: RegulationsFile, reg: Regulation): Regulation | null {
  const i = file.regulations.findIndex((r) => r.id === reg.id);
  return i > 0 ? (file.regulations[i - 1] ?? null) : null;
}

/** The first regulation that starts after `now`, or null when none is scheduled. */
export function nextRegulation(file: RegulationsFile, now: Date): Regulation | null {
  return file.regulations.find((r) => Date.parse(r.start) > now.getTime()) ?? null;
}

export function currentSeason(reg: Regulation, now: Date): Season | undefined {
  return reg.seasons.find((s) => isInWindow(s, now.getTime()));
}

/** Whole days since the regulation started (0 on its first day; negative before it). */
export function daysSinceStart(reg: Regulation, now: Date): number {
  return Math.floor((now.getTime() - Date.parse(reg.start)) / 86_400_000);
}

export interface RegulationPlan {
  current: Regulation;
  /** The regulation before `current`: its data is shown while the current one warms up. */
  previous: Regulation | null;
  next: Regulation | null;
  season: Season | undefined;
}

export function regulationPlan(file: RegulationsFile, now: Date): RegulationPlan {
  const current = currentRegulation(file, now);
  return { current, previous: previousRegulation(file, current), next: nextRegulation(file, now), season: currentSeason(current, now) };
}

/** Regulations whose data a run should try to produce: the current one, then the previous one. */
export function candidateRegulations(plan: RegulationPlan): Regulation[] {
  return plan.previous ? [plan.current, plan.previous] : [plan.current];
}
