import { describe, expect, it } from 'vitest';
import {
  applyFree,
  bansOf,
  checkSequential,
  chooseSequential,
  currentStep,
  picksOf,
  replaySequential,
  startFree,
  startSequential,
  type FreeState,
  type SequentialState,
} from '../../../core/draft.ts';
import {
  DOUBLE_PICK_STEPS,
  SL_STEPS,
  availabilityInFree,
  availabilityInSequential,
  entityRules,
  freeConfig,
  humanSteps,
  slConfig,
  slOrder,
  stepTitle,
} from './rules.ts';

const ROSTER = [
  { id: 'Abat', slots: 1 },
  { id: 'Anub', slots: 1 },
  { id: 'chogall', slots: 2 },
  { id: 'Diab', slots: 1 },
  { id: 'Crus', slots: 1 },
  { id: 'Wiza', slots: 1 },
  { id: 'Malf', slots: 1 },
  { id: 'Mura', slots: 1 },
  { id: 'Tra0', slots: 1 },
  { id: 'Demo', slots: 1 },
  { id: 'Vari', slots: 1 },
  { id: 'HXAL', slots: 1 },
  { id: 'Zera', slots: 1 },
];
const RULES = entityRules(ROSTER);
const CHO = { id: 'chogall', name: "Cho'gall", slots: 2 };

function play(choices: (string | null)[], fp: 'a' | 'b' = 'a'): SequentialState {
  const r = replaySequential(slConfig(fp, RULES), choices);
  if (r.error) throw new Error(`step ${r.applied}: ${r.error.message}`);
  return r.state;
}

describe('Storm League order', () => {
  it('is the verified 16-step order with 3 bans per team split 2 + 1', () => {
    const text = SL_STEPS.map((s) => `${s.team}-${s.action}`).join(' ');
    expect(text).toBe(
      'A-ban B-ban A-ban B-ban A-pick B-pick B-pick A-pick A-pick B-ban A-ban B-pick B-pick A-pick A-pick B-pick',
    );
    const bansBefore = SL_STEPS.slice(0, 4).filter((s) => s.action === 'ban');
    expect(bansBefore).toHaveLength(4);
    expect(SL_STEPS.slice(9, 11).map((s) => s.action)).toEqual(['ban', 'ban']);
  });

  it('first-pick toggle swaps who acts at every step', () => {
    const b = slOrder('b');
    expect(b[0]).toEqual({ team: 'B', action: 'ban' });
    expect(b[4]).toEqual({ team: 'B', action: 'pick' });
    expect(b[15]).toEqual({ team: 'A', action: 'pick' });
    expect(b.map((s) => s.action)).toEqual(SL_STEPS.map((s) => s.action));
  });

  it('labels steps from the visitor side', () => {
    expect(stepTitle('A', 'ban')).toBe('Your ban');
    expect(stepTitle('B', 'pick')).toBe('Enemy pick');
    expect(humanSteps(DOUBLE_PICK_STEPS)).toBe('6, 8, 12 or 14');
  });
});

describe("Cho'gall", () => {
  const pickSteps = SL_STEPS.map((s, i) => (s.action === 'pick' ? i : -1)).filter((i) => i >= 0);

  for (const fp of ['a', 'b'] as const) {
    it(`can only start at steps 5, 7, 11, 13 (first pick ${fp})`, () => {
      const filler = ['Abat', 'Anub', 'Diab', 'Crus', 'Wiza', 'Malf', 'Mura', 'Tra0', 'Demo', 'Vari', 'HXAL', 'Zera', 'x1', 'x2', 'x3', 'x4'];
      const legalAt: number[] = [];
      for (const step of pickSteps) {
        // Reach `step` with skipped bans and single-slot filler picks.
        let state = startSequential(slConfig(fp, RULES));
        let f = 0;
        while (state.step < step) {
          const cur = currentStep(state)!;
          const r = chooseSequential(state, cur.action === 'ban' ? null : filler[f++]!);
          if (!r.ok) throw new Error(r.message);
          state = r.state;
        }
        if (checkSequential(state, 'chogall').ok) legalAt.push(step);
      }
      expect(legalAt).toEqual([5, 7, 11, 13]);
    });
  }

  it('fills both consecutive slots of the same team and counts as one decision', () => {
    const s = play([null, null, null, null, 'Mura', 'chogall']);
    expect(s.step).toBe(7);
    expect(s.choices).toEqual([null, null, null, null, 'Mura', 'chogall']);
    expect(s.filled.filter((f) => f.id === 'chogall').map((f) => f.step)).toEqual([5, 6]);
    expect(picksOf(s, 'B')).toEqual(['chogall']);
  });

  it('is explained when not available', () => {
    const s = play([null, null, null, null]);
    const a = availabilityInSequential(s, CHO);
    expect(a.ok).toBe(false);
    expect(a.label).toBe('Needs 2 picks');
    expect(a.why).toContain('6, 8, 12 or 14');
  });

  it('can be banned at any ban step', () => {
    const s = play(['chogall']);
    expect(bansOf(s, 'A')).toEqual(['chogall']);
  });
});

describe('legality', () => {
  it('rejects mirror picks and banned picks, with reasons', () => {
    const s = play(['Mura', null, null, null, 'Malf']);
    expect(checkSequential(s, 'Malf')).toMatchObject({ ok: false, reason: 'taken' });
    expect(checkSequential(s, 'Mura')).toMatchObject({ ok: false, reason: 'taken' });
    const mirror = availabilityInSequential(s, { id: 'Malf', name: 'Malfurion' });
    expect(mirror).toMatchObject({ ok: false, label: 'Your team' });
    expect(mirror.why).toContain('no mirror picks');
    const banned = availabilityInSequential(s, { id: 'Mura', name: 'Muradin' });
    expect(banned).toMatchObject({ ok: false, label: 'Banned by you' });
  });

  it('allows skipped bans but not skipped picks', () => {
    const s = play([null, null, null, null]);
    expect(currentStep(s)).toEqual({ team: 'A', action: 'pick', index: 4 });
    expect(checkSequential(s, null)).toMatchObject({ ok: false, reason: 'skip' });
  });

  it('completes after 16 steps (with a Cho’gall double pick)', () => {
    const s = play([
      'Abat', 'Anub', null, null, // bans
      'Malf', 'chogall', // B takes 5 and 6
      'Wiza', 'Tra0', // A 7, 8
      null, null, // mid bans
      'Demo', 'Vari', // B 11, 12
      'HXAL', 'Zera', // A 13, 14
      'Crus', // B 15
    ]);
    expect(s.complete).toBe(true);
    expect(picksOf(s, 'A')).toEqual(['Malf', 'Wiza', 'Tra0', 'HXAL', 'Zera']);
    expect(picksOf(s, 'B')).toEqual(['chogall', 'Demo', 'Vari', 'Crus']);
    expect(availabilityInSequential(s, { id: 'Mura', name: 'Muradin' })).toMatchObject({ ok: false, label: 'Draft done' });
  });
});

describe('free mode', () => {
  const config = freeConfig(RULES);
  function apply(moves: { team: 'A' | 'B'; action: 'pick' | 'ban'; id: string }[]): FreeState {
    let s = startFree(config);
    for (const m of moves) {
      const r = applyFree(s, m);
      if (!r.ok) throw new Error(r.message);
      s = r.state;
    }
    return s;
  }

  it('takes 5 + 5 picks and up to 3 bans per team in any order', () => {
    const s = apply([
      { team: 'B', action: 'pick', id: 'Mura' },
      { team: 'A', action: 'ban', id: 'Abat' },
      { team: 'A', action: 'ban', id: 'Anub' },
      { team: 'A', action: 'ban', id: 'Diab' },
    ]);
    expect(availabilityInFree(s, { id: 'Crus', name: 'Johanna' }, 'A', 'ban')).toMatchObject({ ok: false, label: 'No bans left' });
    expect(availabilityInFree(s, { id: 'Crus', name: 'Johanna' }, 'B', 'ban').ok).toBe(true);
    expect(availabilityInFree(s, { id: 'Mura', name: 'Muradin' }, 'A', 'pick')).toMatchObject({ ok: false, label: 'Enemy team' });
  });

  it("counts Cho'gall as two slots", () => {
    const s = apply(['Wiza', 'Tra0', 'Demo', 'HXAL'].map((id) => ({ team: 'A' as const, action: 'pick' as const, id })));
    expect(availabilityInFree(s, CHO, 'A', 'pick')).toMatchObject({ ok: false, label: 'Needs 2 slots' });
    expect(availabilityInFree(s, CHO, 'B', 'pick').ok).toBe(true);
    const full = apply([...['Wiza', 'Tra0', 'Demo'].map((id) => ({ team: 'A' as const, action: 'pick' as const, id })), { team: 'A', action: 'pick', id: 'chogall' }]);
    expect(availabilityInFree(full, { id: 'Zera', name: 'Zeratul' }, 'A', 'pick')).toMatchObject({ ok: false, label: 'Team full' });
  });
});
