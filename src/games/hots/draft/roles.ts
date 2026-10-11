/**
 * Role guardrails (SPEC §7): keep suggestions inside a sane team composition, with rules simple
 * enough to state in one line each.
 *
 * Needs (a team should end with both):
 *   - a Healer, or one of the few Supports that can stand in for one (HEALER_SUBSTITUTES: Zarya
 *     and Medivh, whose shields and saves protect allies). This is a curated list on purpose: a
 *     tag such as `shield` also matches self-shields (The Lost Vikings' Norse Force!, Abathur's
 *     Carapace through his locust body), so a tag test let those teams skip their Healer;
 *   - a frontline hero: Tank or Bruiser (main or flex role; Varian counts, Cho'gall counts).
 * A pick that leaves fewer pick slots than unmet needs is penalised hard ("infeasible"). A need
 * no available hero can meet any more is dropped (nothing left to suggest), and reported once in
 * the team summary instead of on every hero.
 *
 * Soft rules (warnings, smaller penalties): a second main-role Tank, a second Healer, a second
 * Support, a third Melee Assassin, a fourth melee hero; and on the last pick, a team without
 * ranged damage, without waveclear or with at most one hero bringing hard crowd control. Soft
 * penalties grow on the team's last two picks (`late`), when the composition is all but decided.
 * Flex heroes (a main role plus `roleAlt`, e.g. Varian) never trigger the duplicate-tank rule.
 */
import type { Reason } from '../../../core/game.ts';
import type { HeroRole, HeroTag } from '../schema.ts';

export interface RoleHero {
  id: string;
  /** Hero slug (`zarya`); needed to recognise the curated Healer substitutes. */
  slug?: string;
  name: string;
  role: HeroRole;
  roleAlt: HeroRole | null;
  type: 'Melee' | 'Ranged';
  slots: 1 | 2;
  tags: ReadonlySet<HeroTag | string>;
}

export type Need = 'healer' | 'frontline';

export const NEED_LABEL: Readonly<Record<Need, string>> = { healer: 'Healer', frontline: 'Frontline' };

/**
 * Heroes that can replace a Healer in a sane composition, by slug. Curated: each one protects
 * allies, not just itself (Zarya's Shield Ally, Medivh's Force of Will and Leyline Seal setups).
 * The Lost Vikings and Abathur are deliberately absent: their shields protect themselves or one
 * hatted ally for a moment, and a team that drafts them still needs a Healer. A curated
 * `healer-sub` hero tag, if the theory data ever carries one, counts the same.
 */
export const HEALER_SUBSTITUTES: ReadonlySet<string> = new Set(['medivh', 'zarya']);

/** Crowd control that stops a hero acting or moving (the guardrail's "hard CC"). */
export const HARD_CC_TAGS: readonly string[] = Object.freeze(['stun', 'root', 'polymorph', 'sleep', 'taunt', 'fear', 'time-stop']);

const has = (h: RoleHero, role: HeroRole): boolean => h.role === role || h.roleAlt === role;

export const isHealer = (h: RoleHero): boolean => has(h, 'Healer');
export const isFrontline = (h: RoleHero): boolean => has(h, 'Tank') || has(h, 'Bruiser');
export const isRangedDamage = (h: RoleHero): boolean => has(h, 'Ranged Assassin');
/** A main-role Tank: flex heroes (main role plus roleAlt, e.g. Varian) are not, Cho'gall (Cho tanks) is. */
export const isMainTank = (h: RoleHero): boolean => h.role === 'Tank' && (h.roleAlt === null || h.slots === 2);
/** One of the curated heroes that keep allies alive well enough to replace a Healer. */
export const isHealerSubstitute = (h: RoleHero): boolean =>
  !isHealer(h) && (HEALER_SUBSTITUTES.has(h.slug ?? '') || h.tags.has('healer-sub'));
export const hasWaveclear = (h: RoleHero): boolean => h.tags.has('waveclear');
/** The hard crowd-control tags a hero has, in HARD_CC_TAGS order. */
export const hardCcOf = (h: RoleHero): string[] => HARD_CC_TAGS.filter((t) => h.tags.has(t));

export function meetsNeed(h: RoleHero, need: Need): boolean {
  return need === 'healer' ? isHealer(h) || isHealerSubstitute(h) : isFrontline(h);
}

export interface TeamRoles {
  /** Pick slots used (Cho'gall = 2). */
  slots: number;
  healers: number;
  /** Curated Supports that stand in for a Healer. */
  substitutes: RoleHero[];
  frontline: number;
  /** Main-role Tanks only (flex Tanks such as Varian excluded). */
  tanks: number;
  supports: number;
  meleeAssassins: number;
  rangedDamage: number;
  melee: number;
  ranged: number;
  /** Heroes with a waveclear tag. */
  waveclear: RoleHero[];
  /** Heroes with at least one hard crowd-control tag. */
  hardCc: RoleHero[];
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
    waveclear: [],
    hardCc: [],
  };
  for (const h of team) {
    out.slots += h.slots;
    if (isHealer(h)) out.healers++;
    else if (isHealerSubstitute(h)) out.substitutes.push(h);
    if (isFrontline(h)) out.frontline++;
    if (isMainTank(h)) out.tanks++;
    if (h.role === 'Support') out.supports++;
    if (h.role === 'Melee Assassin') out.meleeAssassins++;
    if (isRangedDamage(h)) out.rangedDamage++;
    if (h.type === 'Melee') out.melee++;
    else out.ranged++;
    if (hasWaveclear(h)) out.waveclear.push(h);
    if (hardCcOf(h).length > 0) out.hardCc.push(h);
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
  /** Last pick and the team would have no waveclear. */
  noWaveclear: number;
  /** Last pick and at most one hero would bring hard crowd control. */
  lowHardCc: number;
  /**
   * Multiplier for the soft penalties on a team's last two picks (not for the last-pick rules,
   * which are late by definition): early on another pick can
   * still balance the team, late it cannot, and a pile of counter and synergy evidence must not
   * bury a second Healer then.
   */
  late: number;
}

/** Storm League: a drafted team without a Healer or frontline is a real handicap. */
export const SL_ROLES: Readonly<RoleConfig> = Object.freeze({
  infeasible: 1.5,
  fillBase: 0.2,
  fillUrgency: 0.4,
  fillUrgencyFloor: 0,
  secondTank: 0.4,
  secondHealer: 0.45,
  thirdHealer: 0.9,
  secondSupport: 0.35,
  thirdMeleeAssassin: 0.5,
  fourthMelee: 0.3,
  noRangedDamage: 0.35,
  noWaveclear: 0.2,
  lowHardCc: 0.2,
  late: 1.75,
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
  noWaveclear: 0.15,
  lowHardCc: 0.15,
  late: 1.25,
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

/** "Muradin (stun)", "Malfurion (root, sleep)": who brings hard CC, with the tags as evidence. */
export function hardCcEvidence(h: RoleHero): string {
  return `${h.name} (${hardCcOf(h).join(', ').replace(/-/g, ' ')})`;
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
  const late = picksLeft <= 2 ? cfg.late : 1;
  const soft = (value: number, text: string) => out.push({ value: -value * late, reasons: [role(text)] });
  // Last-pick rules happen late by definition: their values are already the late values.
  const last = (value: number, text: string) => out.push({ value: -value, reasons: [role(text)] });

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
    soft(cfg.secondTank, `Second tank next to ${whose} ${tank?.name ?? 'tank'}`);
  }
  if (isHealer(candidate) && now.healers >= 1) {
    const third = now.healers >= 2;
    soft(third ? cfg.thirdHealer : cfg.secondHealer, third ? 'Third Healer: very little damage left' : `Second Healer: less damage for ${whose} team`);
  }
  if (candidate.role === 'Support' && now.supports >= 1) soft(cfg.secondSupport, `Second Support on ${whose} team`);
  if (candidate.role === 'Melee Assassin' && now.meleeAssassins >= 2) soft(cfg.thirdMeleeAssassin, 'Third melee assassin: hard to keep them all alive');
  if (candidate.type === 'Melee' && now.melee >= 3) soft(cfg.fourthMelee, 'Fourth melee hero: little damage from range');
  if (left === 0) {
    if (now.rangedDamage === 0 && !isRangedDamage(candidate) && others.some(isRangedDamage)) {
      last(cfg.noRangedDamage, `Last pick and ${whose} team has no ranged assassin`);
    }
    if (now.waveclear.length === 0 && !hasWaveclear(candidate) && others.some(hasWaveclear)) {
      last(cfg.noWaveclear, `Last pick and no hero on ${whose} team has waveclear`);
    }
    if (now.hardCc.length <= 1 && hardCcOf(candidate).length === 0 && others.some((h) => hardCcOf(h).length > 0)) {
      const only = now.hardCc[0];
      last(cfg.lowHardCc, only ? `Last pick and only ${hardCcEvidence(only)} brings hard crowd control` : `Last pick and ${whose} team has no hard crowd control`);
    }
  }
  return out;
}

export interface TeamSummary {
  needs: NeedStatus[];
  counts: { label: string; value: number }[];
  /** Plain-language notes about the composition (no colour needed to read them). */
  notes: string[];
  /** The notes that are guardrail problems (the rest only explain, e.g. who stands in for the Healer). */
  problems: string[];
}

/** Composition summary for the board (counts, needs, warnings). */
export function teamSummary(team: readonly RoleHero[], available: readonly RoleHero[], picksLeft: number): TeamSummary {
  const roles = teamRoles(team);
  const needs = needStatus(team, available);
  const notes: string[] = [];
  const problems: string[] = [];
  const note = (text: string, problem = true) => {
    notes.push(text);
    if (problem) problems.push(text);
  };
  const open = needs.filter((n) => !n.met && n.possible).map((n) => n.need);
  const word = (n: Need) => (n === 'healer' ? 'Healer' : 'frontline hero');
  if (picksLeft > 0) {
    for (const n of needs) if (!n.met && !n.possible) note(`No ${word(n.need)} left to pick.`);
    if (open.length > picksLeft) note(`Not enough picks left for ${needWords(open)}.`);
  } else if (team.length > 0) {
    for (const n of needs) if (!n.met) note(`No ${word(n.need)}.`);
  }
  if (roles.healers === 0 && roles.substitutes.length > 0) {
    note(`No Healer: ${listNames(roles.substitutes.map((h) => h.name))} provides the sustain.`, false);
  }
  if (roles.tanks >= 2) note('Two main tanks.');
  if (roles.healers >= 2) note(`${roles.healers} Healers.`);
  if (roles.meleeAssassins >= 3) note(`${roles.meleeAssassins} melee assassins.`);
  if (picksLeft === 0 && team.length > 0) {
    if (roles.rangedDamage === 0) note('No ranged assassin.');
    if (roles.waveclear.length === 0) note('No waveclear: no hero here has a waveclear tag.');
    if (roles.hardCc.length === 0) note('No hard crowd control: no stun, root, sleep or similar.');
    else if (roles.hardCc.length === 1) note(`Little hard crowd control: only ${hardCcEvidence(roles.hardCc[0]!)}.`);
  }
  return {
    problems,
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
