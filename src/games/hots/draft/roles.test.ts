import { describe, expect, it } from 'vitest';
import type { HeroRole } from '../schema.ts';
import { ARAM_ROLES, SL_ROLES, isHealerSubstitute, meetsNeed, openNeeds, roleVerdicts, teamRoles, teamSummary, type RoleHero } from './roles.ts';

function hero(name: string, role: HeroRole, opts: Partial<RoleHero> = {}): RoleHero {
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  return { id: name, slug, name, role, roleAlt: null, type: role === 'Ranged Assassin' || role === 'Healer' ? 'Ranged' : 'Melee', slots: 1, tags: new Set(), ...opts };
}

const muradin = hero('Muradin', 'Tank');
const diablo = hero('Diablo', 'Tank');
const johanna = hero('Johanna', 'Tank');
const varian = hero('Varian', 'Bruiser', { roleAlt: 'Tank' });
const sonya = hero('Sonya', 'Bruiser');
const malf = hero('Malfurion', 'Healer');
const uther = hero('Uther', 'Healer');
const rehgar = hero('Rehgar', 'Healer', { type: 'Melee' });
const valla = hero('Valla', 'Ranged Assassin');
const liming = hero('Li-Ming', 'Ranged Assassin');
const tracer = hero('Tracer', 'Ranged Assassin');
const zeratul = hero('Zeratul', 'Melee Assassin');
const illidan = hero('Illidan', 'Melee Assassin');
const kerrigan = hero('Kerrigan', 'Melee Assassin');
const zarya = hero('Zarya', 'Support', { tags: new Set(['shield', 'save']) });
const medivh = hero('Medivh', 'Support', { tags: new Set(['heal-ally', 'save']), type: 'Ranged' });
// Tags as the extractor gives them on live data: self-shields read as `shield`, Abathur's hat as heal-ally.
const tlv = hero('The Lost Vikings', 'Support', { tags: new Set(['shield', 'heal-self', 'stun']) });
const abathur = hero('Abathur', 'Support', { tags: new Set(['shield', 'heal-ally', 'stun', 'waveclear']) });
const chogall = hero("Cho'gall", 'Tank', { roleAlt: 'Ranged Assassin', slots: 2 });

const POOL = [muradin, diablo, johanna, varian, sonya, malf, uther, rehgar, valla, liming, tracer, zeratul, illidan, kerrigan, zarya, medivh, tlv, abathur, chogall];
const avail = (...taken: RoleHero[]) => POOL.filter((h) => !taken.includes(h));
const total = (c: RoleHero, team: RoleHero[], left: number, cfg = SL_ROLES) =>
  roleVerdicts(c, team, avail(c, ...team), left, cfg).reduce((s, v) => s + v.value, 0);
const texts = (c: RoleHero, team: RoleHero[], left: number) =>
  roleVerdicts(c, team, avail(c, ...team), left, SL_ROLES).flatMap((v) => v.reasons.map((r) => r.text));

describe('needs', () => {
  it('needs a Healer (or a sustain Support) and a frontline hero', () => {
    expect(openNeeds([], POOL)).toEqual(['healer', 'frontline']);
    expect(openNeeds([varian], POOL)).toEqual(['healer']);
    expect(openNeeds([zarya, sonya], POOL)).toEqual([]);
    expect(openNeeds([tlv, sonya], POOL)).toEqual(['healer']);
    expect(openNeeds([chogall], POOL)).toEqual(['healer']);
  });

  it('counts only the curated Healer substitutes: Zarya and Medivh, never The Lost Vikings or Abathur', () => {
    expect(isHealerSubstitute(zarya)).toBe(true);
    expect(isHealerSubstitute(medivh)).toBe(true);
    for (const h of [tlv, abathur]) {
      expect(isHealerSubstitute(h)).toBe(false);
      expect(meetsNeed(h, 'healer')).toBe(false);
    }
    expect(openNeeds([abathur, sonya], POOL)).toEqual(['healer']);
    expect(openNeeds([medivh, sonya], POOL)).toEqual([]);
    // A curated tag would count the same, whoever carries it.
    expect(isHealerSubstitute(hero('Tassadar', 'Ranged Assassin', { tags: new Set(['healer-sub']) }))).toBe(true);
  });

  it('drops a need nobody available can meet', () => {
    const noHealers = POOL.filter((h) => h.role !== 'Healer' && h.role !== 'Support');
    expect(openNeeds([valla], noHealers)).toEqual(['frontline']);
  });
});

describe('feasibility (hard guardrails)', () => {
  it('blocks a last pick that leaves the team without a Healer', () => {
    const team = [muradin, valla, liming, zeratul];
    expect(total(tracer, team, 1)).toBeLessThanOrEqual(-SL_ROLES.infeasible);
    expect(texts(tracer, team, 1)[0]).toBe('Leaves your team without a Healer');
    expect(total(malf, team, 1)).toBeGreaterThan(0);
  });

  it('blocks a last pick without a Healer next to The Lost Vikings or Abathur', () => {
    for (const support of [tlv, abathur]) {
      const team = [muradin, support, valla, liming];
      expect(total(tracer, team, 1)).toBeLessThanOrEqual(-SL_ROLES.infeasible);
      expect(texts(tracer, team, 1)[0]).toBe('Leaves your team without a Healer');
      expect(texts(malf, team, 1)).toContain('Gives your team the Healer it still needs');
    }
    // Zarya does stand in.
    expect(texts(tracer, [muradin, zarya, valla, liming], 1).some((t) => t.startsWith('Leaves'))).toBe(false);
  });

  it('counts the picks left against all open needs', () => {
    const team = [valla, liming, zeratul];
    // Two picks left, two needs: a damage pick now makes it impossible.
    expect(texts(tracer, team, 2)[0]).toBe('Leaves 1 pick for a Healer and a frontline hero');
    expect(total(malf, team, 2)).toBeGreaterThan(0.4);
    expect(total(varian, team, 2)).toBeGreaterThan(0.4);
  });

  it("knows Cho'gall takes two slots", () => {
    const team = [valla, liming];
    // Three slots left: Cho'gall fills frontline but leaves 1 slot for the Healer: fine.
    expect(total(chogall, team, 3)).toBeGreaterThan(0);
    // Two slots left and no healer yet: Cho'gall would use both.
    expect(texts(chogall, [valla, liming, zeratul], 2)[0]).toBe('Leaves your team without a Healer');
  });

  it('is gentler in ARAM', () => {
    const team = [muradin, valla, liming, zeratul];
    const verdict = roleVerdicts(tracer, team, avail(tracer, ...team), 1, ARAM_ROLES).find((v) => v.reasons[0]?.text.startsWith('Leaves'));
    expect(verdict?.value).toBeCloseTo(-ARAM_ROLES.infeasible, 5);
    expect(ARAM_ROLES.infeasible).toBeLessThan(SL_ROLES.infeasible);
  });
});

describe('soft guardrails', () => {
  it('penalises a second main tank but not a flex hero', () => {
    expect(texts(diablo, [muradin], 4)).toContain('Second tank next to your Muradin');
    expect(texts(varian, [muradin], 4).some((t) => t.startsWith('Second tank'))).toBe(false);
    expect(texts(diablo, [varian], 4).some((t) => t.startsWith('Second tank'))).toBe(false);
    expect(texts(diablo, [chogall], 3)).toContain("Second tank next to your Cho'gall");
  });

  it('warns on a second healer, a third melee assassin and a fourth melee hero', () => {
    expect(texts(uther, [malf], 4)).toContain('Second Healer: less damage for your team');
    expect(texts(kerrigan, [zeratul, illidan], 3)).toContain('Third melee assassin: hard to keep them all alive');
    expect(texts(rehgar, [muradin, zeratul, illidan], 2)).toContain('Fourth melee hero: little damage from range');
  });

  it('warns when the final team has no ranged damage', () => {
    expect(texts(sonya, [muradin, malf, zeratul, illidan], 1)).toContain('Last pick and your team has no ranged assassin');
  });

  it('second support', () => {
    expect(texts(zarya, [abathur], 4)).toContain('Second Support on your team');
  });

  it('weighs soft penalties more on the last two picks', () => {
    const early = roleVerdicts(uther, [malf], avail(uther, malf), 4, SL_ROLES).find((v) => v.reasons[0]?.text.startsWith('Second Healer'))!;
    const late = roleVerdicts(uther, [malf, muradin, valla], avail(uther, malf, muradin, valla), 2, SL_ROLES).find((v) => v.reasons[0]?.text.startsWith('Second Healer'))!;
    expect(early.value).toBeCloseTo(-SL_ROLES.secondHealer, 10);
    expect(late.value).toBeCloseTo(-SL_ROLES.secondHealer * SL_ROLES.late, 10);
  });

  it('warns on a last pick that leaves no waveclear or little hard crowd control, naming who has it', () => {
    const wave = (h: RoleHero, extra: string[] = []) => ({ ...h, tags: new Set([...h.tags, 'waveclear', ...extra]) });
    const stunner = (h: RoleHero) => ({ ...h, tags: new Set([...h.tags, 'stun']) });
    const pool = [...POOL, wave(hero('Jaina', 'Ranged Assassin'), ['root'])];
    const team = [stunner(muradin), malf, zeratul, valla];
    const out = roleVerdicts(tracer, team, pool.filter((h) => ![tracer, ...team].some((t) => t.id === h.id)), 1, SL_ROLES).flatMap((v) => v.reasons.map((r) => r.text));
    expect(out).toContain('Last pick and no hero on your team has waveclear');
    expect(out).toContain('Last pick and only Muradin (stun) brings hard crowd control');
    // Not before the last pick.
    expect(roleVerdicts(tracer, team.slice(0, 3), pool, 2, SL_ROLES).some((v) => v.reasons[0]?.text.includes('waveclear'))).toBe(false);
  });

  it('rewards filling a need more when it is urgent', () => {
    const early = total(malf, [], 5);
    const late = total(malf, [muradin, valla, liming], 2);
    expect(late).toBeGreaterThan(early);
  });
});

describe('team summary', () => {
  it('counts roles and explains gaps in words', () => {
    const s = teamSummary([zarya, sonya, valla], avail(zarya, sonya, valla), 2);
    expect(s.needs.find((n) => n.need === 'healer')).toMatchObject({ met: true, by: ['Zarya'] });
    expect(s.notes).toContain('No Healer: Zarya provides the sustain.');
    // An explanation, not a problem.
    expect(s.problems).not.toContain('No Healer: Zarya provides the sustain.');
    expect(teamRoles([chogall]).slots).toBe(2);
    const none = teamSummary([valla], [valla, liming], 4);
    expect(none.notes).toContain('No Healer left to pick.');
  });

  it('reviews a finished team: missing roles, waveclear and hard crowd control', () => {
    const done = teamSummary([tlv, sonya, valla, liming, tracer], [], 0);
    expect(done.problems).toEqual(['No Healer.', 'No waveclear: no hero here has a waveclear tag.', 'Little hard crowd control: only The Lost Vikings (stun).']);
    const sound = teamSummary([{ ...muradin, tags: new Set(['stun']) }, malf, { ...valla, tags: new Set(['waveclear', 'stun']) }, liming, zeratul], [], 0);
    expect(sound.problems).toEqual([]);
  });
});
