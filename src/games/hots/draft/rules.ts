/**
 * Heroes of the Storm draft rules on top of the generic engine (src/core/draft.ts, SPEC §7).
 *
 * - Storm League: the verified 16-step order (0-based) below, 3 bans per team split 2 + 1.
 *   Team A is always "you"; the first-pick toggle swaps who acts at each step.
 * - Cho'gall (any 2-slot entity) needs two consecutive picks of the same team, which only
 *   happens at steps 5, 7, 11 and 13; it fills both slots.
 * - No mirror picks and no picking a banned hero (the core engine's `taken` set).
 * - Missed bans are allowed (a skipped ban step), picks cannot be skipped.
 * - Free mode: heroescounters-style, any team in any order, 5 + 5 picks and up to 3 bans each.
 */
import {
  bansOf,
  checkFree,
  checkSequential,
  freeTeam,
  parseOrder,
  picksOf,
  swapTeams,
  type DraftAction,
  type DraftStep,
  type EntityRules,
  type FreeConfig,
  type FreeState,
  type Illegal,
  type SequentialConfig,
  type SequentialState,
  type Team,
} from '../../../core/draft.ts';

export const SL_ORDER_SPEC =
  'A-ban B-ban A-ban B-ban A-pick B-pick B-pick A-pick A-pick B-ban A-ban B-pick B-pick A-pick A-pick B-pick';

/** Storm League order with team A (you) picking first. */
export const SL_STEPS: readonly DraftStep[] = Object.freeze(parseOrder(SL_ORDER_SPEC));

/** 0-based steps where a team picks twice in a row: the only places a 2-slot entity fits. */
export const DOUBLE_PICK_STEPS: readonly number[] = Object.freeze([5, 7, 11, 13]);

export const FREE_TEAM_SIZE = 5;
export const FREE_MAX_BANS = 3;

/** Which team moves first. 'a' = you. */
export type FirstPick = 'a' | 'b';

export const OUR_TEAM: Team = 'A';

export function slOrder(firstPick: FirstPick): DraftStep[] {
  return firstPick === 'a' ? [...SL_STEPS] : swapTeams(SL_STEPS);
}

/** Slot/step rules for every multi-slot entity in the roster (data-driven; today only Cho'gall). */
export function entityRules(heroes: readonly { id: string; slots: number }[]): EntityRules {
  const rules: Record<string, { slots: number; allowedSteps: readonly number[] }> = {};
  for (const h of heroes) if (h.slots === 2) rules[h.id] = { slots: 2, allowedSteps: DOUBLE_PICK_STEPS };
  return rules;
}

export function slConfig(firstPick: FirstPick, rules: EntityRules): SequentialConfig {
  return { steps: slOrder(firstPick), rules, allowSkip: 'ban' };
}

export function freeConfig(rules: EntityRules): FreeConfig {
  return { teamSize: FREE_TEAM_SIZE, maxBans: FREE_MAX_BANS, rules };
}

// ---- labels ---------------------------------------------------------------------------------

export const TEAM_NAME: Readonly<Record<Team, string>> = { A: 'You', B: 'Enemy' };

/** "your" / "the enemy's" for prose. */
export function teamPossessive(team: Team): string {
  return team === OUR_TEAM ? 'your' : "the enemy's";
}

export function stepTitle(team: Team, action: DraftAction): string {
  if (team === OUR_TEAM) return action === 'ban' ? 'Your ban' : 'Your pick';
  return action === 'ban' ? 'Enemy ban' : 'Enemy pick';
}

/** 1-based step numbers for prose, e.g. "6, 8, 12 or 14". */
export function humanSteps(steps: readonly number[]): string {
  const list = steps.map((s) => String(s + 1));
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} or ${list.at(-1)}`;
}

export interface NamedEntity {
  id: string;
  name: string;
  slots?: number;
}

/** Where an entity already sits in a draft, for "Picked by you" style notes. */
export type Placement = { kind: 'ban'; team: Team } | { kind: 'pick'; team: Team } | null;

export function placementInSequential(state: SequentialState, id: string): Placement {
  for (const team of ['A', 'B'] as const) {
    if (picksOf(state, team).includes(id)) return { kind: 'pick', team };
    if (bansOf(state, team).includes(id)) return { kind: 'ban', team };
  }
  return null;
}

export function placementInFree(state: FreeState, id: string): Placement {
  for (const team of ['A', 'B'] as const) {
    const t = freeTeam(state, team);
    if (t.picks.includes(id)) return { kind: 'pick', team };
    if (t.bans.includes(id)) return { kind: 'ban', team };
  }
  return null;
}

/** Short tile label for an unavailable entity. */
export function placementLabel(p: Placement): string {
  if (!p) return '';
  if (p.kind === 'ban') return p.team === OUR_TEAM ? 'Banned by you' : 'Banned by enemy';
  return p.team === OUR_TEAM ? 'Your team' : 'Enemy team';
}

export interface Availability {
  ok: boolean;
  /** Short status for the tile ("Banned by you", "Needs 2 picks"). Empty when ok. */
  label: string;
  /** Full sentence explaining why it cannot be chosen now. Empty when ok. */
  why: string;
}

const OK: Availability = Object.freeze({ ok: true, label: '', why: '' });

function slotsWhy(hero: NamedEntity): string {
  return `${hero.name} takes two picks in a row, so it can only start at step ${humanSteps(DOUBLE_PICK_STEPS)}.`;
}

/** Can `hero` be chosen at the current Storm League step, and if not, why (in words)? */
export function availabilityInSequential(state: SequentialState, hero: NamedEntity): Availability {
  const check = checkSequential(state, hero.id);
  if (check.ok) return OK;
  return explain(check, hero, () => placementInSequential(state, hero.id));
}

/** Free mode: can `hero` go to `team` as `action`? */
export function availabilityInFree(state: FreeState, hero: NamedEntity, team: Team, action: DraftAction): Availability {
  const check = checkFree(state, { team, action, id: hero.id });
  if (check.ok) return OK;
  return explain(check, hero, () => placementInFree(state, hero.id), team);
}

function explain(check: Illegal, hero: NamedEntity, place: () => Placement, team?: Team): Availability {
  switch (check.reason) {
    case 'taken': {
      const p = place();
      const label = placementLabel(p) || 'Taken';
      const why =
        p?.kind === 'ban'
          ? `${hero.name} is banned, so neither team can pick it.`
          : p
            ? `${hero.name} is already on ${teamPossessive(p.team)} team; Storm League has no mirror picks.`
            : `${hero.name} is already in the draft.`;
      return { ok: false, label, why };
    }
    case 'step':
    case 'slots':
      return { ok: false, label: 'Needs 2 picks', why: slotsWhy(hero) };
    case 'full':
      return {
        ok: false,
        label: (hero.slots ?? 1) > 1 ? 'Needs 2 slots' : 'Team full',
        why:
          (hero.slots ?? 1) > 1
            ? `${hero.name} needs two free pick slots on ${team ? teamPossessive(team) : 'the'} team.`
            : `${team ? (team === OUR_TEAM ? 'Your' : "The enemy's") : 'The'} team already has ${FREE_TEAM_SIZE} heroes.`,
      };
    case 'bans':
      return { ok: false, label: 'No bans left', why: `${team === OUR_TEAM ? 'You have' : 'The enemy has'} used all ${FREE_MAX_BANS} bans.` };
    case 'complete':
      return { ok: false, label: 'Draft done', why: 'The draft is complete. Undo a step or start a new draft.' };
    default:
      return { ok: false, label: 'Unavailable', why: check.message };
  }
}
