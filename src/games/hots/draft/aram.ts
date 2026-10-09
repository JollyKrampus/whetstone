/**
 * ARAM helper (SPEC §7, roadmap D15): each player chooses one of three offered heroes. Rank the
 * offered heroes for the team you are on, using the same providers as the draft with gentler
 * role rules, no blind-pick term (ARAM has no draft to answer you) and ARAM statistics only:
 * a Storm League win rate says little about ARAM, so other modes' stats are ignored here.
 *
 * Mirror matches exist in ARAM, so an enemy may hold the same hero as one of your options.
 */
import { WEIGHT_PRESETS, type DraftContext, type Weights } from '../../../core/draft.ts';
import type { DraftData } from './data.ts';
import { ARAM_ROLES } from './roles.ts';
import { ARAM_ALLIES, ARAM_ENEMIES, ARAM_OPTIONS } from './state.ts';
import { suggest, type Suggestion } from './suggest.ts';

export const ARAM_TEAM_SIZE = 5;

/** Composite weights, with map fit a little lower (ARAM maps differ less than the draft pool). */
export const ARAM_WEIGHTS: Weights = Object.freeze({ ...WEIGHT_PRESETS.composite, map: 0.4 });

export interface AramInput {
  options: readonly string[];
  allies: readonly string[];
  enemies: readonly string[];
  map: string;
}

export interface AramIssue {
  id: string;
  text: string;
}

/** Statistics block usable for ARAM (only an ARAM-mode block). */
export function aramStats(data: DraftData): boolean {
  return data.stats?.mode === 'aram';
}

function slotsOf(data: DraftData, ids: readonly string[]): number {
  return ids.reduce((sum, id) => sum + (data.byId.get(id)?.slots ?? 1), 0);
}

/** The scoring context for "you, about to lock one of your options". */
export function aramContext(data: DraftData, input: AramInput): DraftContext {
  const ctx: DraftContext = {
    team: 'A',
    action: 'pick',
    allies: [...input.allies],
    enemies: [...input.enemies],
    bans: [],
    picksLeft: Math.max(0, ARAM_TEAM_SIZE - slotsOf(data, input.allies)),
    enemyPicksLeft: Math.max(0, ARAM_TEAM_SIZE - slotsOf(data, input.enemies)),
  };
  if (input.map && data.mapById.get(input.map)?.kind === 'aram') ctx.map = input.map;
  return ctx;
}

export interface AramRanking {
  ranked: Suggestion[];
  /** Options that cannot be ranked, with the reason (duplicate, already an ally, no room). */
  issues: AramIssue[];
  usesStats: boolean;
}

export function rankAram(data: DraftData, input: AramInput, opts: { favorites?: ReadonlySet<string> } = {}): AramRanking {
  const issues: AramIssue[] = [];
  const seen = new Set<string>();
  const candidates: string[] = [];
  const allySlots = slotsOf(data, input.allies);
  for (const id of input.options.slice(0, ARAM_OPTIONS)) {
    const hero = data.byId.get(id);
    if (!hero) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    if (input.allies.includes(id)) {
      issues.push({ id, text: `${hero.name} is already on your team.` });
      continue;
    }
    if (allySlots + hero.slots > ARAM_TEAM_SIZE) {
      issues.push({ id, text: `No room for ${hero.name}: your team has no ${hero.slots > 1 ? 'two free slots' : 'free slot'} left.` });
      continue;
    }
    candidates.push(id);
  }
  const useStats = aramStats(data);
  const ranked = suggest({
    data,
    ctx: aramContext(data, input),
    candidates,
    preset: 'composite',
    weights: ARAM_WEIGHTS,
    roles: ARAM_ROLES,
    useStats,
    blindSafety: false,
    ...(opts.favorites ? { favorites: opts.favorites } : {}),
  });
  return { ranked, issues, usesStats: useStats };
}

export const ARAM_LIMITS = { options: ARAM_OPTIONS, allies: ARAM_ALLIES, enemies: ARAM_ENEMIES } as const;
