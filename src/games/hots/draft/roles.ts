/**
 * Role guardrails (SPEC §7): keep suggestions inside a sane team composition, with rules simple
 * enough to state in one line each.
 *
 * Needs (a team should end with both):
 *   - a Healer, or a Support who shields or saves allies (the "support-healer" exception:
 *     Zarya/Medivh/Tassadar-style comps). Data-driven: role Support with a shield, save or
 *     heal-ally tag;
 *   - a frontline hero: Tank or Bruiser (main or flex role; Varian counts, Cho'gall counts).
 * A pick that leaves fewer pick slots than unmet needs is penalised hard ("infeasible"). A need
 * no available hero can meet any more is dropped (nothing left to suggest), and reported once in
 * the team summary instead of on every hero.
 *
 * Soft rules (warnings, smaller penalties): a second main-role Tank, a second Healer, a second
 * Support, a third Melee Assassin, a fourth melee hero, a final team without ranged damage.
 * Flex heroes (a main role plus `roleAlt`, e.g. Varian) never trigger the duplicate-tank rule.
 */
import type { Reason } from '../../../core/game.ts';
import type { HeroRole, HeroTag } from '../schema.ts';

export interface RoleHero {
  id: string;
  name: string;
  role: HeroRole;
  roleAlt: HeroRole | null;
  type: 'Melee' | 'Ranged';
  slots: 1 | 2;
  tags: ReadonlySet<HeroTag | string>;
}

export type Need = 'healer' | 'frontline';

export const NEED_LABEL: Readonly<Record<Need, string>> = { healer: 'Healer', frontline: 'Frontline' };

const has = (h: RoleHero, role: HeroRole): boolean => h.role === role || h.roleAlt === role;

export const isHealer = (h: RoleHero): boolean => has(h, 'Healer');
export const isFrontline = (h: RoleHero): boolean => has(h, 'Tank') || has(h, 'Bruiser');
export const isRangedDamage = (h: RoleHero): boolean => has(h, 'Ranged Assassin');
/** A main-role Tank: flex heroes (main role plus roleAlt, e.g. Varian) are not, Cho'gall (Cho tanks) is. */
export const isMainTank = (h: RoleHero): boolean => h.role === 'Tank' && (h.roleAlt === null || h.slots === 2);
/** Support who keeps allies alive without being a Healer (shields, saves, heals). */
export const isSustainSupport = (h: RoleHero): boolean =>
  h.role === 'Support' && (h.tags.has('shield') || h.tags.has('save') || h.tags.has('heal-ally'));

export function meetsNeed(h: RoleHero, need: Need): boolean {
  return need === 'healer' ? isHealer(h) || isSustainSupport(h) : isFrontline(h);
}

export interface TeamRoles {
  /** Pick slots used (Cho'gall = 2). */
  slots: number;
  healers: number;
  /** Supports that stand in for a Healer. */
  substitutes: RoleHero[];
  frontline: number;
  /** Main-role Tanks only (flex Tanks such as Varian excluded). */
  tanks: number;
  supports: number;
  meleeAssassins: number;
  rangedDamage: number;
  melee: number;
  ranged: number;
}

export function teamRoles(team: readonly RoleHero[]): TeamRoles {
  const out: TeamRoles = {
    slots: 0,
    healers: 0,
    substitutes: [],
    frontline: 0,
    tanks: 0,
    supports: 0,
    meleeAssassins: 0,
    rangedDamage: 0,
    melee: 0,
    ranged: 0,
  };
  for (const h of team) {
    out.slots += h.slots;
    if (isHealer(h)) out.healers++;
    else if (isSustainSupport(h)) out.substitutes.push(h);
    if (isFrontline(h)) out.frontline++;
    if (isMainTank(h)) out.tanks++;
    if (h.role === 'Support') out.supports++;
    if (h.role === 'Melee Assassin') out.meleeAssassins++;
    if (isRangedDamage(h)) out.rangedDamage++;
    if (h.type === 'Melee') out.melee++;
    else out.ranged++;
  }
  return out;
}

function met(roles: TeamRoles, need: Need): boolean {
  return need === 'healer' ? roles.healers > 0 || roles.substitutes.length > 0 : roles.frontline > 0;
}

const NEEDS: readonly Need[] = ['healer', 'frontline'];

export interface NeedStatus {
  need: Need;
  met: boolean;
  /** Some hero still available could meet it. */
  possible: boolean;
  /** Names of the heroes meeting it (for the summary). */
  by: string[];
}

/** Needs status for a team given the heroes still available to it. */
export function needStatus(team: readonly RoleHero[], available: readonly RoleHero[]): NeedStatus[] {
  const roles = teamRoles(team);
  return NEEDS.map((need) => ({
    need,
    met: met(roles, need),
    possible: available.some((h) => meetsNeed(h, need)),
    by: team.filter((h) => meetsNeed(h, need)).map((h) => h.name),
  }));
}

/** Unmet needs that can still be met by someone available. */
export function openNeeds(team: readonly RoleHero[], available: readonly RoleHero[]): Need[] {
  return needStatus(team, available)
    .filter((s) => !s.met && s.possible)
    .map((s) => s.need);
}

export interface RoleConfig {
  /** Penalty (signal value) for a pick that makes the needs impossible with the picks left. */
  infeasible: number;
  /** Bonus for filling an open need; grows with urgency (needs ÷ picks left). */
  fillBase: number;
  fillUrgency: number;
  /**
   * Lowest urgency a fillable need gets. 0 in Storm League (your team drafts its later picks on
   * purpose); 1 in ARAM, where teammates still to lock get random options and may not be able
   * to fill the gap, so a gap you can fill yourself counts as if you were the last chance.
   */
  fillUrgencyFloor: number;
  secondTank: number;
  secondHealer: number;
  thirdHealer: number;
  secondSupport: number;
  thirdMeleeAssassin: number;
  fourthMelee: number;
  noRangedDamage: number;
}

/** Storm League: a drafted team without a Healer or frontline is a real handicap. */
export const SL_ROLES: Readonly<RoleConfig> = Object.freeze({
  infeasible: 1.5,
  fillBase: 0.2,
  fillUrgency: 0.4,
  fillUrgencyFloor: 0,
  secondTank: 0.4,
  secondHealer: 0.3,
  thirdHealer: 0.8,
  secondSupport: 0.35,
  thirdMeleeAssassin: 0.5,
  fourthMelee: 0.3,
  noRangedDamage: 0.35,
});

/**
 * ARAM: random options and no draft. Penalties are gentler (you can only choose among three),
 * but filling a gap counts fully, because the teammates still to lock cannot plan for it.
 */
export const ARAM_ROLES: Readonly<RoleConfig> = Object.freeze({
  infeasible: 0.6,
  fillBase: 0.2,
  fillUrgency: 0.3,
  fillUrgencyFloor: 1,
  secondTank: 0.25,
  secondHealer: 0.2,
  thirdHealer: 0.5,
  secondSupport: 0.25,
  thirdMeleeAssassin: 0.3,
  fourthMelee: 0.2,
  noRangedDamage: 0.25,
});

export interface RoleVerdict {
  /** Signal value (logit-like scale; positive = good for the team). */
  value: number;
  reasons: Reason[];
}

function listNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function needWords(needs: readonly Need[]): string {
  return listNames(needs.map((n) => (n === 'healer' ? 'a Healer' : 'a frontline hero')));
}

/**
 * Role signals for adding `candidate` to `team`.
 * @param picksLeft pick slots the team still has, counting the current one.
 * @param available heroes still draftable by this team (candidate included or not; it is skipped).
 * @param whose "your" or "their", for the reason text.
 */
export function roleVerdicts(
  candidate: RoleHero,
  team: readonly RoleHero[],
  available: readonly RoleHero[],
  picksLeft: number,
  cfg: RoleConfig,
  whose: 'your' | 'their' = 'your',
): RoleVerdict[] {
  const out: RoleVerdict[] = [];
  const others = available.filter((h) => h.id !== candidate.id);
  const before = openNeeds(team, [candidate, ...others]);
  const after = [...team, candidate];
  const left = Math.max(0, picksLeft - candidate.slots);
  const afterNeeds = openNeeds(after, others);
  const role = (text: string): Reason => ({ kind: 'role', text });

  if (afterNeeds.length > left) {
    const text =
      left === 0
        ? `Leaves ${whose} team without ${needWords(afterNeeds)}`
        : `Leaves ${left} pick${left === 1 ? '' : 's'} for ${needWords(afterNeeds)}`;
    out.push({ value: -cfg.infeasible, reasons: [role(text)] });
  } else {
    const filled = before.filter((n) => !afterNeeds.includes(n) && meetsNeed(candidate, n));
    if (filled.length > 0 && picksLeft > 0) {
      const urgency = Math.min(1, Math.max(cfg.fillUrgencyFloor, before.length / picksLeft));
      const what = filled.map((n) => (n === 'healer' ? (isHealer(candidate) ? 'Healer' : 'sustain (shields/saves)') : 'frontline')).join(' and ');
      out.push({ value: cfg.fillBase + cfg.fillUrgency * urgency, reasons: [role(`Gives ${whose} team the ${what} it still needs`)] });
    }
  }

  const now = teamRoles(team);
  if (isMainTank(candidate) && now.tanks >= 1) {
    const tank = team.find(isMainTank);
    out.push({ value: -cfg.secondTank, reasons: [role(`Second tank next to ${whose} ${tank?.name ?? 'tank'}`)] });
  }
  if (isHealer(candidate) && now.healers >= 1) {
    const third = now.healers >= 2;
    out.push({
      value: -(third ? cfg.thirdHealer : cfg.secondHealer),
      reasons: [role(third ? 'Third Healer: very little damage left' : `Second Healer: less damage for ${whose} team`)],
    });
  }
  if (candidate.role === 'Support' && now.supports >= 1) {
    out.push({ value: -cfg.secondSupport, reasons: [role(`Second Support on ${whose} team`)] });
  }
  if (candidate.role === 'Melee Assassin' && now.meleeAssassins >= 2) {
    out.push({ value: -cfg.thirdMeleeAssassin, reasons: [role('Third melee assassin: hard to keep them all alive')] });
  }
  if (candidate.type === 'Melee' && now.melee >= 3) {
    out.push({ value: -cfg.fourthMelee, reasons: [role('Fourth melee hero: little damage from range')] });
  }
  if (left === 0 && now.rangedDamage === 0 && !isRangedDamage(candidate) && others.some(isRangedDamage)) {
    out.push({ value: -cfg.noRangedDamage, reasons: [role(`Last pick and ${whose} team has no ranged assassin`)] });
  }
  return out;
}

export interface TeamSummary {
  needs: NeedStatus[];
  counts: { label: string; value: number }[];
  /** Plain-language notes about the composition (no colour needed to read them). */
  notes: string[];
}

/** Composition summary for the board (counts, needs, warnings). */
export function teamSummary(team: readonly RoleHero[], available: readonly RoleHero[], picksLeft: number): TeamSummary {
  const roles = teamRoles(team);
  const needs = needStatus(team, available);
  const notes: string[] = [];
  const open = needs.filter((n) => !n.met && n.possible).map((n) => n.need);
  for (const n of needs) {
    if (!n.met && !n.possible && picksLeft > 0) notes.push(`No ${n.need === 'healer' ? 'Healer' : 'frontline hero'} left to pick.`);
  }
  if (open.length > picksLeft) notes.push(`Not enough picks left for ${needWords(open)}.`);
  if (roles.healers === 0 && roles.substitutes.length > 0) {
    notes.push(`No Healer: ${listNames(roles.substitutes.map((h) => h.name))} provides the sustain.`);
  }
  if (roles.tanks >= 2) notes.push('Two main tanks.');
  if (roles.healers >= 2) notes.push(`${roles.healers} Healers.`);
  if (roles.meleeAssassins >= 3) notes.push(`${roles.meleeAssassins} melee assassins.`);
  if (picksLeft === 0 && team.length > 0 && roles.rangedDamage === 0) notes.push('No ranged assassin.');
  return {
    needs,
    counts: [
      { label: 'Frontline', value: roles.frontline },
      { label: 'Healer', value: roles.healers },
      { label: 'Ranged dmg', value: roles.rangedDamage },
      { label: 'Melee', value: roles.melee },
    ],
    notes,
  };
}
