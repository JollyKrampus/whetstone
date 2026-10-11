import { describe, expect, it } from 'vitest';
import { RotationSchema } from '../../schema.ts';
import { rawJson } from '../test-helpers.ts';
import { searchKey } from '../util.ts';
import { buildRotation, markLagging, stableRotation } from './rotation.ts';

const raw = rawJson<{ RotationHero: { Heroes: { Name: string }[]; StartDate: string; EndDate: string } }>('nexus-compendium/currently.json');
/** Index of every hero the recorded rotation names, as the real roster would provide. */
const index = new Map<string, string[]>(raw.RotationHero.Heroes.map((h, i) => [searchKey(h.Name), [`H${String(i).padStart(3, '0')}`]]));

describe('buildRotation', () => {
  it('maps the recorded rotation to hero ids with dates and the ranked season', () => {
    const r = buildRotation(raw, index, '2026-10-08T10:20:00.000Z', '2026-10-08');
    expect(RotationSchema.safeParse(r.rotation).success).toBe(true);
    expect(r.rotation.heroes).toHaveLength(raw.RotationHero.Heroes.length);
    expect(r.rotation).toMatchObject({ source: 'nexus-compendium', start: raw.RotationHero.StartDate.slice(0, 10), end: raw.RotationHero.EndDate.slice(0, 10), allFree: false });
    expect(r.rotation.ranked).toMatchObject({ id: expect.stringMatching(/season/) });
    expect(r.issues).toEqual([]);
    expect(r.lagging).toBe(false);
  });

  it('flags a window that already ended (the source lags the weekly switch)', () => {
    expect(buildRotation(raw, index, '2026-10-09T10:20:00.000Z', '2026-10-09').lagging).toBe(true);
  });

  it('reports unknown heroes in one warning', () => {
    const r = buildRotation(raw, new Map([[searchKey(raw.RotationHero.Heroes[0]?.Name ?? ''), ['Abat']]]), '2026-10-08T10:20:00.000Z', '2026-10-08');
    expect(r.rotation.heroes).toEqual(['Abat']);
    expect(r.issues).toHaveLength(1);
  });

  it('rejects responses without a rotation', () => {
    expect(() => buildRotation({}, index, '2026-10-08T10:20:00.000Z', '2026-10-08')).toThrow(/RotationHero/);
  });

  it('flags last week on the switch day although its content and "as of" time did not change (two daily runs)', () => {
    // Run 1, inside the window (2026-10-01..2026-10-08): current.
    const day1 = markLagging(stableRotation(buildRotation(raw, index, '2026-10-07T10:20:00.000Z', '2026-10-07').rotation, null), '2026-10-07');
    expect(day1.lagging).toBeUndefined();
    // Run 2, after the switch: the source still reports the same week, so the content-stable
    // fetchedAt stays inside the old window and cannot reveal it; the flag does.
    const day2 = markLagging(stableRotation(buildRotation(raw, index, '2026-10-09T10:20:00.000Z', '2026-10-09').rotation, day1), '2026-10-09');
    expect(day2.fetchedAt).toBe(day1.fetchedAt);
    expect(day2.end < day2.fetchedAt.slice(0, 10)).toBe(false);
    expect(day2.lagging).toBe(true);
    expect(RotationSchema.safeParse(day2).success).toBe(true);
    // Run 3, the source has switched: a new window, no flag.
    const next = { ...raw, RotationHero: { ...raw.RotationHero, StartDate: '2026-10-08', EndDate: '2026-10-15' } };
    const day3 = markLagging(stableRotation(buildRotation(next, index, '2026-10-10T10:20:00.000Z', '2026-10-10').rotation, day2), '2026-10-10');
    expect(day3.lagging).toBeUndefined();
    expect(day3.fetchedAt).toBe('2026-10-10T10:20:00.000Z');
  });

  it('keeps the previous "as of" time when nothing changed', () => {
    const a = buildRotation(raw, index, '2026-10-08T10:20:00.000Z', '2026-10-08').rotation;
    const b = buildRotation(raw, index, '2026-10-09T10:20:00.000Z', '2026-10-08').rotation;
    expect(stableRotation(b, a).fetchedAt).toBe(a.fetchedAt);
    expect(stableRotation({ ...b, end: '2026-10-15' }, a).fetchedAt).toBe(b.fetchedAt);
    expect(stableRotation(b, null)).toBe(b);
  });
});
