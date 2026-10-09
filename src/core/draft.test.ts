import { describe, expect, it } from 'vitest';
import type { Reason } from './game.ts';
import {
  PRESET_IDS,
  WEIGHT_PRESETS,
  applyFree,
  asOpponent,
  bansOf,
  checkFree,
  checkSequential,
  chooseSequential,
  currentStep,
  displayScore,
  freeContext,
  freeTeam,
  legalCandidates,
  parseOrder,
  picksOf,
  remainingSteps,
  removeFree,
  replayFree,
  replaySequential,
  scoreCandidates,
  sequentialContext,
  startFree,
  startSequential,
  swapTeams,
  undoFree,
  undoSequential,
  valueFromDelta,
  valueFromScore,
  type DraftContext,
  type FreeState,
  type Provider,
  type SequentialConfig,
  type SequentialState,
} from './draft.ts';
import { scoreFromDelta } from './stats.ts';

// HotS-like Storm League order (0-based), with a 2-slot entity allowed at 5, 7, 11, 13.
const ORDER = parseOrder(
  'A-ban B-ban A-ban B-ban A-pick B-pick B-pick A-pick A-pick B-ban A-ban B-pick B-pick A-pick A-pick B-pick',
);
const CONFIG: SequentialConfig = { steps: ORDER, rules: { chogall: { slots: 2, allowedSteps: [5, 7, 11, 13] } } };

function play(config: SequentialConfig, choices: (string | null)[]): SequentialState {
  const r = replaySequential(config, choices);
  if (r.error) throw new Error(`illegal at ${r.applied}: ${r.error.message}`);
  return r.state;
}

describe('parseOrder', () => {
  it('parses the 16-step order', () => {
    expect(ORDER).toHaveLength(16);
    expect(ORDER[0]).toEqual({ team: 'A', action: 'ban' });
    expect(ORDER[15]).toEqual({ team: 'B', action: 'pick' });
    const count = (team: string, action: string) => ORDER.filter((s) => s.team === team && s.action === action).length;
    expect([count('A', 'ban'), count('B', 'ban'), count('A', 'pick'), count('B', 'pick')]).toEqual([3, 3, 5, 5]);
  });

  it('accepts commas and colons, rejects junk', () => {
    expect(parseOrder('a:ban, B-PICK')).toEqual([
      { team: 'A', action: 'ban' },
      { team: 'B', action: 'pick' },
    ]);
    expect(() => parseOrder('A-ban C-pick')).toThrow(/C-pick/);
  });

  it('swaps teams', () => {
    expect(swapTeams(ORDER.slice(0, 2))).toEqual([
      { team: 'B', action: 'ban' },
      { team: 'A', action: 'ban' },
    ]);
  });
});

describe('sequential engine', () => {
  const FULL = ['b1', 'b2', 'b3', 'b4', 'a1', 'x1', 'x2', 'a2', 'a3', 'b5', 'b6', 'x3', 'x4', 'a4', 'a5', 'x5'];

  it('runs a full legal draft', () => {
    const s = play(CONFIG, FULL);
    expect(s.complete).toBe(true);
    expect(s.step).toBe(16);
    expect(currentStep(s)).toBeNull();
    expect(picksOf(s, 'A')).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(picksOf(s, 'B')).toEqual(['x1', 'x2', 'x3', 'x4', 'x5']);
    expect(bansOf(s, 'A')).toEqual(['b1', 'b3', 'b6']);
    expect(bansOf(s, 'B')).toEqual(['b2', 'b4', 'b5']);
    expect(checkSequential(s, 'zz')).toMatchObject({ ok: false, reason: 'complete' });
  });

  it('starts at step 0 and reports the step on the clock', () => {
    const s = startSequential(CONFIG);
    expect(currentStep(s)).toEqual({ team: 'A', action: 'ban', index: 0 });
    expect(s.complete).toBe(false);
    expect(startSequential({ steps: [] }).complete).toBe(true);
  });

  it('forbids duplicates across teams and picking banned ids', () => {
    const banned = play(CONFIG, ['abathur']);
    expect(checkSequential(banned, 'abathur')).toMatchObject({ ok: false, reason: 'taken' });
    const picked = play(CONFIG, ['b1', 'b2', 'b3', 'b4', 'muradin']);
    expect(checkSequential(picked, 'muradin')).toMatchObject({ ok: false, reason: 'taken' });
    const r = chooseSequential(picked, 'muradin');
    expect(r.ok).toBe(false);
    expect(checkSequential(picked, '')).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it("allows the 2-slot entity only at 5, 7, 11, 13 and fills both slots", () => {
    const at4 = play(CONFIG, ['b1', 'b2', 'b3', 'b4']);
    expect(checkSequential(at4, 'chogall')).toMatchObject({ ok: false, reason: 'step' });
    const at5 = play(CONFIG, ['b1', 'b2', 'b3', 'b4', 'a1']);
    const r = chooseSequential(at5, 'chogall');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.step).toBe(7);
    expect(r.state.filled.slice(-2).map((f) => [f.step, f.team, f.id, f.choice])).toEqual([
      [5, 'B', 'chogall', 5],
      [6, 'B', 'chogall', 5],
    ]);
    expect(picksOf(r.state, 'B')).toEqual(['chogall']);
    expect(r.state.choices).toEqual(['b1', 'b2', 'b3', 'b4', 'a1', 'chogall']);
    expect(currentStep(r.state)).toEqual({ team: 'A', action: 'pick', index: 7 });

    for (const prefix of [
      ['b1', 'b2', 'b3', 'b4', 'a1', 'x1', 'x2'],
      ['b1', 'b2', 'b3', 'b4', 'a1', 'x1', 'x2', 'a2', 'a3', 'b5', 'b6'],
      ['b1', 'b2', 'b3', 'b4', 'a1', 'x1', 'x2', 'a2', 'a3', 'b5', 'b6', 'x3', 'x4'],
    ]) {
      expect(checkSequential(play(CONFIG, prefix), 'chogall').ok).toBe(true);
    }
    for (const n of [6, 8, 12, 14, 15]) {
      const prefix = FULL.slice(0, n);
      expect(checkSequential(play(CONFIG, prefix), 'chogall')).toMatchObject({ ok: false, reason: 'step' });
    }
  });

  it('checks that a multi-slot pick fits consecutive own picks', () => {
    const loose: SequentialConfig = { steps: ORDER, rules: { chogall: { slots: 2 } } };
    const at4 = play(loose, ['b1', 'b2', 'b3', 'b4']);
    expect(checkSequential(at4, 'chogall')).toMatchObject({ ok: false, reason: 'slots' });
    const at15 = play(loose, FULL.slice(0, 15));
    expect(checkSequential(at15, 'chogall')).toMatchObject({ ok: false, reason: 'slots' });
  });

  it('bans a 2-slot entity with one ban step, ignoring allowedSteps', () => {
    const s = play(CONFIG, ['chogall']);
    expect(s.step).toBe(1);
    expect(bansOf(s, 'A')).toEqual(['chogall']);
  });

  it('undoes one decision at a time, including a 2-slot pick', () => {
    const s = play(CONFIG, ['b1', 'b2', 'b3', 'b4', 'a1', 'chogall']);
    const u = undoSequential(s);
    expect(u.step).toBe(5);
    expect(u.choices).toEqual(['b1', 'b2', 'b3', 'b4', 'a1']);
    expect(u.taken.has('chogall')).toBe(false);
    const empty = startSequential(CONFIG);
    expect(undoSequential(empty)).toBe(empty);
  });

  it('skips bans with null but not picks (unless allowed)', () => {
    const s = play(CONFIG, [null, null, null, null]);
    expect(s.step).toBe(4);
    expect(bansOf(s, 'A')).toEqual([]);
    expect(checkSequential(s, null)).toMatchObject({ ok: false, reason: 'skip' });
    expect(checkSequential({ ...s, config: { ...CONFIG, allowSkip: 'any' } }, null).ok).toBe(true);
    expect(checkSequential(startSequential({ ...CONFIG, allowSkip: 'none' }), null).ok).toBe(false);
  });

  it('replays the longest legal prefix of bad input', () => {
    const r = replaySequential(CONFIG, ['b1', 'b1', 'b2']);
    expect(r.applied).toBe(1);
    expect(r.error?.reason).toBe('taken');
    expect(r.state.choices).toEqual(['b1']);
  });

  it('filters legal candidates in input order', () => {
    const s = play(CONFIG, ['b1', 'b2', 'b3', 'b4']);
    expect(legalCandidates(s, ['zeratul', 'b1', 'chogall', 'abathur'])).toEqual(['zeratul', 'abathur']);
  });

  it('builds the context for the team on the clock', () => {
    const s = play(CONFIG, ['b1', 'b2', 'b3', 'b4', 'a1']);
    expect(remainingSteps(s, 'B', 'pick')).toBe(5);
    expect(remainingSteps(s, 'A', 'pick')).toBe(4);
    const ctx = sequentialContext(s, { map: 'cursed-hollow' });
    expect(ctx).toEqual({
      team: 'B',
      action: 'pick',
      allies: [],
      enemies: ['a1'],
      bans: ['b1', 'b3', 'b2', 'b4'],
      picksLeft: 5,
      enemyPicksLeft: 4,
      step: 5,
      map: 'cursed-hollow',
    });
    expect(sequentialContext(play(CONFIG, FULL))).toBeNull();
    expect(asOpponent(ctx!)).toMatchObject({ team: 'A', allies: ['a1'], enemies: [], picksLeft: 4, enemyPicksLeft: 5 });
  });

  it('never mutates earlier states', () => {
    const s = play(CONFIG, ['b1']);
    const before = JSON.stringify({ c: s.choices, f: s.filled, step: s.step });
    chooseSequential(s, 'b2');
    undoSequential(s);
    expect(JSON.stringify({ c: s.choices, f: s.filled, step: s.step })).toBe(before);
    expect([...s.taken]).toEqual(['b1']);
  });
});

describe('free mode', () => {
  const config = { teamSize: 5, maxBans: 3, rules: { chogall: { slots: 2 } } };
  const apply = (s: FreeState, team: 'A' | 'B', action: 'ban' | 'pick', id: string): FreeState => {
    const r = applyFree(s, { team, action, id });
    if (!r.ok) throw new Error(r.message);
    return r.state;
  };

  it('adds to either team in any order and enforces team size', () => {
    let s = startFree(config);
    s = apply(s, 'B', 'pick', 'e1');
    for (const id of ['a1', 'a2', 'a3', 'a4', 'a5']) s = apply(s, 'A', 'pick', id);
    expect(freeTeam(s, 'A')).toEqual({ picks: ['a1', 'a2', 'a3', 'a4', 'a5'], bans: [], slotsUsed: 5 });
    expect(checkFree(s, { team: 'A', action: 'pick', id: 'a6' })).toMatchObject({ ok: false, reason: 'full' });
    expect(checkFree(s, { team: 'B', action: 'pick', id: 'a1' })).toMatchObject({ ok: false, reason: 'taken' });
  });

  it('charges multi-slot entities their slots', () => {
    let s = startFree(config);
    for (const id of ['a1', 'a2', 'a3', 'a4']) s = apply(s, 'A', 'pick', id);
    expect(checkFree(s, { team: 'A', action: 'pick', id: 'chogall' })).toEqual({
      ok: false,
      reason: 'full',
      message: 'Not enough slots left for chogall.',
    });
    s = apply(s, 'B', 'pick', 'chogall');
    expect(freeTeam(s, 'B').slotsUsed).toBe(2);
  });

  it('limits bans per team and blocks picking banned ids', () => {
    let s = startFree({ ...config, maxBans: 2 });
    s = apply(s, 'A', 'ban', 'x');
    s = apply(s, 'A', 'ban', 'y');
    expect(checkFree(s, { team: 'A', action: 'ban', id: 'z' })).toMatchObject({ ok: false, reason: 'bans' });
    expect(checkFree(s, { team: 'B', action: 'ban', id: 'z' }).ok).toBe(true);
    expect(checkFree(s, { team: 'B', action: 'pick', id: 'x' })).toMatchObject({ ok: false, reason: 'taken' });
  });

  it('removes, undoes and replays', () => {
    let s = startFree(config);
    s = apply(s, 'A', 'pick', 'a1');
    s = apply(s, 'B', 'ban', 'x');
    s = apply(s, 'B', 'pick', 'e1');
    const removed = removeFree(s, 'x');
    expect(removed.moves.map((m) => m.id)).toEqual(['a1', 'e1']);
    expect(removed.taken.has('x')).toBe(false);
    expect(removeFree(s, 'nope')).toBe(s);
    expect(undoFree(s).moves.map((m) => m.id)).toEqual(['a1', 'x']);
    expect(undoFree(startFree(config)).moves).toEqual([]);
    const r = replayFree(config, [...s.moves, { team: 'A', action: 'pick', id: 'e1' }]);
    expect(r.applied).toBe(3);
    expect(r.error?.reason).toBe('taken');
  });

  it('rejects malformed moves', () => {
    const s = startFree(config);
    expect(checkFree(s, { team: 'C' as 'A', action: 'pick', id: 'q' })).toMatchObject({ reason: 'invalid' });
    expect(checkFree(s, { team: 'A', action: 'pick', id: '' })).toMatchObject({ reason: 'invalid' });
  });

  it('builds a context per team', () => {
    let s = startFree(config);
    s = apply(s, 'A', 'pick', 'a1');
    s = apply(s, 'B', 'pick', 'chogall');
    s = apply(s, 'B', 'ban', 'x');
    expect(freeContext(s, 'A')).toEqual({
      team: 'A',
      action: 'pick',
      allies: ['a1'],
      enemies: ['chogall'],
      bans: ['x'],
      picksLeft: 4,
      enemyPicksLeft: 3,
    });
  });
});

describe('scorer', () => {
  const stat = (text: string, delta?: number): Reason => (delta === undefined ? { kind: 'stat', text } : { kind: 'stat', text, delta });
  const winrates: Record<string, number> = { kael: 1.5, jaina: 1.5, muradin: -0.5, uther: 0.2, li: 0 };
  const counters: Record<string, Record<string, number>> = {
    kael: { illidan: -3 },
    jaina: { illidan: 0.5 },
    muradin: { illidan: 4.5, valla: 2 },
    uther: {},
  };
  const winrate: Provider = (id) => {
    const d = winrates[id];
    return d === undefined ? null : { key: 'winrate', value: valueFromDelta(d), reasons: [stat(`WR ${id}`, d)] };
  };
  const counter: Provider = (id, ctx) =>
    ctx.enemies.flatMap((e) => {
      const d = counters[id]?.[e];
      return d === undefined ? [] : [{ key: 'counters' as const, value: valueFromDelta(d), reasons: [stat(`${id} vs ${e}`, d)] }];
    });
  const role: Provider = (id, ctx) =>
    id === 'uther' && ctx.allies.includes('malfurion')
      ? { key: 'role', value: -1, reasons: [{ kind: 'role', text: 'Second healer' }] }
      : null;
  const context: DraftContext = {
    team: 'A',
    action: 'pick',
    allies: ['malfurion'],
    enemies: ['illidan', 'valla'],
    bans: [],
    picksLeft: 4,
    enemyPicksLeft: 3,
  };
  const candidates = ['uther', 'muradin', 'kael', 'jaina', 'li', 'li'];

  it('ranks with the composite preset and explains', () => {
    const ranked = scoreCandidates({ candidates, context }, [winrate, counter, role], WEIGHT_PRESETS.composite);
    expect(ranked.map((r) => r.id)).toEqual(['muradin', 'jaina', 'li', 'kael', 'uther']);
    const muradin = ranked[0]!;
    expect(muradin.raw).toBeCloseTo(valueFromDelta(-0.5) + valueFromDelta(4.5) + valueFromDelta(2), 12);
    expect(muradin.score).toBe(displayScore(muradin.raw));
    expect(muradin.reasons.map((r) => r.text)).toEqual(['muradin vs illidan', 'muradin vs valla']);
    expect(muradin.warning?.text).toBe('WR muradin');
    expect(muradin.byKey).toEqual({ winrate: -0.125, counters: 1.625 });
    const uther = ranked.find((r) => r.id === 'uther')!;
    expect(uther.warning).toEqual({ kind: 'role', text: 'Second healer' });
    expect(uther.reasons.map((r) => r.text)).toEqual(['WR uther']);
    expect(ranked.find((r) => r.id === 'li')).toMatchObject({ score: 50, raw: 0, reasons: [] });
    expect(ranked.find((r) => r.id === 'li')!.warning).toBeUndefined();
  });

  it('switches ordering by preset', () => {
    const byWinrate = scoreCandidates({ candidates, context }, [winrate, counter, role], WEIGHT_PRESETS.winrate);
    // kael and jaina tie on win rate: the id breaks the tie.
    expect(byWinrate.map((r) => r.id)).toEqual(['jaina', 'kael', 'uther', 'li', 'muradin']);
    const byCounters = scoreCandidates({ candidates, context }, [winrate, counter, role], WEIGHT_PRESETS.counters);
    expect(byCounters[0]!.id).toBe('muradin');
    expect(byCounters.at(-1)!.id).toBe('kael');
    expect(byCounters.find((r) => r.id === 'kael')!.warning?.text).toBe('kael vs illidan');
  });

  it('keeps at most three positive reasons, strongest first, deduped', () => {
    const many: Provider = () =>
      [0.1, 0.9, 0.5, 0.7, 0.3].map((v, i) => ({ key: 'theory' as const, value: v, reasons: [{ kind: 'theory' as const, text: `t${i}` }] }));
    const dup: Provider = () => ({ key: 'theory', value: 2, reasons: [{ kind: 'theory', text: 't1' }] });
    const [r] = scoreCandidates({ candidates: ['x'], context }, [many, dup], { theory: 1 });
    expect(r!.reasons.map((x) => x.text)).toEqual(['t1', 't3', 't2']);
    const [two] = scoreCandidates({ candidates: ['x'], context }, [many], { theory: 1 }, { maxReasons: 2 });
    expect(two!.reasons.map((x) => x.text)).toEqual(['t1', 't3']);
  });

  it('ignores non-finite values and unweighted keys', () => {
    const bad: Provider = () => [
      { key: 'map', value: Number.NaN, reasons: [] },
      { key: 'votes', value: 5, reasons: [{ kind: 'votes', text: 'v' }] },
    ];
    const [r] = scoreCandidates({ candidates: ['x'], context }, [bad], WEIGHT_PRESETS.map);
    expect(r!.raw).toBe(0);
    expect(r!.signals).toHaveLength(1);
    expect(r!.signals[0]).toMatchObject({ key: 'votes', weight: 0, contribution: 0 });
    expect(r!.reasons).toEqual([]);
  });

  it('is deterministic for ties regardless of candidate order', () => {
    const flat: Provider = () => ({ key: 'tier', value: 0.3, reasons: [] });
    const a = scoreCandidates({ candidates: ['c', 'a', 'b'], context }, [flat], WEIGHT_PRESETS.tier).map((r) => r.id);
    const b = scoreCandidates({ candidates: ['b', 'c', 'a'], context }, [flat], WEIGHT_PRESETS.tier).map((r) => r.id);
    expect(a).toEqual(['a', 'b', 'c']);
    expect(b).toEqual(a);
  });

  it('exposes presets as frozen data', () => {
    expect(PRESET_IDS).toEqual(['composite', 'winrate', 'counters', 'synergy', 'map', 'tier', 'community']);
    expect(Object.isFrozen(WEIGHT_PRESETS.composite)).toBe(true);
  });

  it('maps values to the ring scale consistently', () => {
    expect(displayScore(0)).toBe(50);
    expect(displayScore(Number.NaN)).toBe(50);
    expect(displayScore(10)).toBe(100);
    expect(displayScore(-10)).toBe(0);
    expect(valueFromDelta(4)).toBe(1);
    expect(valueFromScore(50)).toBe(0);
    expect(valueFromScore(scoreFromDelta(4))).toBeCloseTo(1, 1);
    expect(valueFromScore(100)).toBeLessThanOrEqual(3);
    expect(valueFromScore(1)).toBeLessThan(-2);
  });
});
