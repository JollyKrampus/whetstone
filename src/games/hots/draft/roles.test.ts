import { describe, expect, it } from 'vitest';
import type { HeroRole } from '../schema.ts';
import { ARAM_ROLES, SL_ROLES, openNeeds, roleVerdicts, teamRoles, teamSummary, type RoleHero } from './roles.ts';

function hero(name: string, role: HeroRole, opts: Partial<RoleHero> = {}): RoleHero {
  return { id: name, name, role, roleAlt: null, type: role === 'Ranged Assassin' || role === 'Healer' ? 'Ranged' : 'Melee', slots: 1, tags: new Set(), ...opts };
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
const zarya = hero('Zarya', 'Support', { tags: new Set(['shield']) });
const tlv = hero('The Lost Vikings', 'Support');
const abathur = hero('Abathur', 'Support', { tags: new Set(['shield']) });
const chogall = hero("Cho'gall", 'Tank', { roleAlt: 'Ranged Assassin', slots: 2 });

const POOL = [muradin, diablo, johanna, varian, sonya, malf, uther, rehgar, valla, liming, tracer, zeratul, illidan, kerrigan, zarya, tlv, abathur, chogall];
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
    expect(total(tracer, team, 1, ARAM_ROLES)).toBeCloseTo(-ARAM_ROLES.infeasible, 5);
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
    expect(teamRoles([chogall]).slots).toBe(2);
    const none = teamSummary([valla], [valla, liming], 4);
    expect(none.notes).toContain('No Healer left to pick.');
  });
});
