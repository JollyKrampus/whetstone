import { describe, expect, it } from 'vitest';
import {
  catchUp,
  defaultSince,
  isIsoDate,
  majorStarts,
  readSince,
  shiftDate,
  sinceHash,
  type CatchUpData,
  type CatchUpPatch,
} from './catchup.ts';

function patch(p: Partial<CatchUpPatch> & Pick<CatchUpPatch, 'id' | 'date'>): CatchUpPatch {
  return { title: p.id, kind: 'patch', version: '2.57', href: `/p/${p.id}/`, general: [], newHeroes: [], heroes: {}, ...p };
}

const DATA: CatchUpData = {
  heroes: {
    Abat: { id: 'Abat', name: 'Abathur', href: '/h/abathur/', portrait: null },
    HXAL: { id: 'HXAL', name: "Xal'atath", href: '/h/xalatath/', portrait: '/img/x.webp' },
    Tra0: { id: 'Tra0', name: 'Tracer', href: '/h/tracer/', portrait: null },
  },
  // Newest first, like patches.json.
  patches: [
    patch({ id: '2026-10-12-ptr', date: '2026-10-12', kind: 'ptr', heroes: { Tra0: { changes: [{ section: 'Base', text: 'PTR only', dir: 'nerf' }] } } }),
    patch({
      id: '2026-10-05-hotfix',
      date: '2026-10-05',
      kind: 'hotfix',
      general: ['Fixed a bug.'],
      heroes: { HXAL: { verdict: 'nerf', changes: [{ section: 'Abilities', target: 'Void Step', text: 'Range 5 → 2', dir: 'nerf' }] } },
    }),
    patch({
      id: '2026-09-28-patch',
      date: '2026-09-28',
      newHeroes: ['HXAL'],
      heroes: {
        HXAL: { verdict: 'new', changes: [{ section: 'New Hero', text: 'Joins the Nexus.' }] },
        Abat: { verdict: 'rework', changes: [{ section: 'Level 1', text: 'Reworked.', dir: 'rework' }] },
      },
    }),
    patch({ id: '2026-06-01-patch', date: '2026-06-01', version: '2.56', heroes: { Tra0: { changes: [{ section: 'Base', text: 'Health 1 → 2', dir: 'buff' }] } } }),
  ],
};

describe('catch-up dates', () => {
  it('accepts only real calendar dates', () => {
    expect(isIsoDate('2026-09-27')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-9-27')).toBe(false);
    expect(isIsoDate(20260927)).toBe(false);
  });

  it('shifts across month and year boundaries in UTC', () => {
    expect(shiftDate('2026-09-28', -1)).toBe('2026-09-27');
    expect(shiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(defaultSince('2026-09-28')).toBe('2026-09-27');
  });

  it('round-trips the shareable hash and ignores invalid values', () => {
    expect(sinceHash('2026-09-01')).toBe('#since=2026-09-01');
    expect(readSince('#since=2026-09-01')).toBe('2026-09-01');
    expect(readSince('#v=1&since=2026-09-01')).toBe('2026-09-01');
    expect(readSince('#since=yesterday')).toBeNull();
    expect(readSince('')).toBeNull();
  });

  it('lists each live major with its first date, newest first', () => {
    expect(majorStarts(DATA.patches)).toEqual([
      { version: '2.57', date: '2026-09-28' },
      { version: '2.56', date: '2026-06-01' },
    ]);
  });
});

describe('catchUp', () => {
  it('groups live changes after the date by hero, biggest first, with new heroes and reworks flagged', () => {
    const r = catchUp(DATA, '2026-09-27');
    expect(r.patches.map((p) => p.id)).toEqual(['2026-10-05-hotfix', '2026-09-28-patch']);
    expect(r.groups.map((g) => g.hero.id)).toEqual(['HXAL', 'Abat']);
    const [xal, abathur] = r.groups;
    expect(xal?.isNew).toBe(true);
    expect(xal?.lines.map((l) => l.patchId)).toEqual(['2026-10-05-hotfix', '2026-09-28-patch']);
    expect(xal?.latest).toBe('2026-10-05');
    expect(abathur?.rework).toBe(true);
    expect(r.newHeroes.map((h) => h.name)).toEqual(["Xal'atath"]);
    expect(r.general).toEqual([{ patchId: '2026-10-05-hotfix', title: '2026-10-05-hotfix', href: '/p/2026-10-05-hotfix/', date: '2026-10-05', lines: ['Fixed a bug.'] }]);
    expect(r.counts).toEqual({ buff: 0, nerf: 1, change: 1, rework: 1 });
  });

  it('is exclusive of the chosen day and never includes PTR notes', () => {
    expect(catchUp(DATA, '2026-09-28').patches.map((p) => p.id)).toEqual(['2026-10-05-hotfix']);
    expect(catchUp(DATA, '2026-10-06').groups).toEqual([]);
    expect(catchUp(DATA, '2026-10-06').patches).toEqual([]);
  });

  it('reaches back across majors and falls back to the id for unknown heroes', () => {
    const r = catchUp({ ...DATA, heroes: {} }, '2026-01-01');
    expect(r.patches).toHaveLength(3);
    expect(r.groups.find((g) => g.hero.id === 'Tra0')?.hero).toEqual({ id: 'Tra0', name: 'Tra0', href: '', portrait: null });
  });
});
