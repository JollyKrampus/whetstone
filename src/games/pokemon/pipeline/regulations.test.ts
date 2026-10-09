import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../../lib/datadir.ts';
import {
  candidateRegulations,
  currentRegulation,
  currentSeason,
  daysSinceStart,
  isInWindow,
  loadRegulations,
  nextRegulation,
  previousRegulation,
  regulationPlan,
} from './regulations.ts';
import { WITH_NEXT } from './test-support.ts';

const at = (iso: string): Date => new Date(iso);

describe('curated regulations.yaml', () => {
  it('validates and lists M-C with its Showdown formats and Limitless code', () => {
    const file = loadRegulations(repoRoot());
    const mc = file.regulations.find((r) => r.id === 'M-C');
    expect(mc?.formats).toEqual({ doubles: 'gen9championsvgc2026regmc', doublesBo3: 'gen9championsvgc2026regmcbo3', singles: 'gen9championsbssregmc' });
    expect(mc?.limitlessFormat).toBe('M-C');
    expect(currentRegulation(file, at('2026-10-08T10:17:00Z')).id).toBe('M-C');
  });
});

describe('windows', () => {
  it('starts inclusive and ends inclusive to the minute (01:59 ends)', () => {
    const w = { start: '2026-09-09T02:00:00Z', end: '2026-12-02T01:59:00Z' };
    expect(isInWindow(w, Date.parse('2026-09-09T01:59:59.999Z'))).toBe(false);
    expect(isInWindow(w, Date.parse('2026-09-09T02:00:00Z'))).toBe(true);
    expect(isInWindow(w, Date.parse('2026-12-02T01:59:59.999Z'))).toBe(true);
    expect(isInWindow(w, Date.parse('2026-12-02T02:00:00Z'))).toBe(false);
  });

  it('picks the regulation in force, the latest started one between windows, the first before any', () => {
    expect(currentRegulation(WITH_NEXT, at('2026-08-01T00:00:00Z')).id).toBe('M-B');
    expect(currentRegulation(WITH_NEXT, at('2026-09-09T01:59:30Z')).id).toBe('M-B');
    expect(currentRegulation(WITH_NEXT, at('2026-09-09T02:00:00Z')).id).toBe('M-C');
    expect(currentRegulation(WITH_NEXT, at('2027-06-01T00:00:00Z')).id).toBe('M-D');
    expect(currentRegulation(WITH_NEXT, at('2025-01-01T00:00:00Z')).id).toBe('M-B');
  });

  it('finds seasons, neighbours and the day count', () => {
    const mc = currentRegulation(WITH_NEXT, at('2026-10-08T10:00:00Z'));
    expect(currentSeason(mc, at('2026-10-08T10:00:00Z'))?.id).toBe('M-7');
    expect(currentSeason(mc, at('2026-10-07T01:59:00Z'))?.id).toBe('M-6');
    expect(currentSeason(mc, at('2026-11-20T00:00:00Z'))).toBeUndefined();
    expect(previousRegulation(WITH_NEXT, mc)?.id).toBe('M-B');
    expect(previousRegulation(WITH_NEXT, WITH_NEXT.regulations[0]!)).toBeNull();
    expect(nextRegulation(WITH_NEXT, at('2026-10-08T00:00:00Z'))?.id).toBe('M-D');
    expect(nextRegulation(WITH_NEXT, at('2027-01-01T00:00:00Z'))).toBeNull();
    expect(daysSinceStart(mc, at('2026-09-09T02:00:00Z'))).toBe(0);
    expect(daysSinceStart(mc, at('2026-10-08T10:00:00Z'))).toBe(29);
  });
});

describe('M-C → M-D rollover', () => {
  it('switches the moment the new window opens and offers the previous regulation as fallback', () => {
    const before = regulationPlan(WITH_NEXT, at('2026-12-02T01:59:59Z'));
    expect(before.current.id).toBe('M-C');
    expect(before.next?.id).toBe('M-D');
    expect(candidateRegulations(before).map((r) => r.id)).toEqual(['M-C', 'M-B']);

    const after = regulationPlan(WITH_NEXT, at('2026-12-02T02:00:00Z'));
    expect(after.current.id).toBe('M-D');
    expect(after.previous?.id).toBe('M-C');
    expect(after.next).toBeNull();
    expect(after.season?.id).toBe('M-9');
    expect(candidateRegulations(after).map((r) => r.id)).toEqual(['M-D', 'M-C']);
  });

  it('has no fallback for the first regulation', () => {
    const plan = regulationPlan(WITH_NEXT, at('2026-07-01T00:00:00Z'));
    expect(plan.previous).toBeNull();
    expect(candidateRegulations(plan).map((r) => r.id)).toEqual(['M-B']);
  });
});
