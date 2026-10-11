import { describe, expect, it } from 'vitest';
import { PatchesFileSchema, type Diff, type Patch } from '../../schema.ts';
import { assemblePatches, assignBuilds, assignIds, buildForRecord, diffDates, diffDirection, diffLine, enrichWithDiff, majorForDate, type BuildDate } from './patchset.ts';
import type { ParsedPatch } from './patches.ts';

const BUILDS: BuildDate[] = [
  { build: '2.55.17.98025', date: '2026-09-13' },
  { build: '2.57.0.98126_ptr', date: '2026-09-15' },
  { build: '2.57.0.98285', date: '2026-09-29' },
  { build: '2.57.0.98304', date: '2026-09-30' },
  { build: '2.57.0.98348', date: '2026-10-05' },
];

const rec = (over: Partial<ParsedPatch>): ParsedPatch => ({
  date: '2026-09-28',
  title: 'Live Patch Notes',
  url: 'https://news.blizzard.com/en-us/article/1/x',
  kind: 'patch',
  contentHash: '0123456789abcdef',
  notes: 'summary',
  general: [],
  heroes: {},
  ...over,
});

const DIFF: Diff = {
  id: '2.55.17.98025..2.57.0.98285',
  from: '2.55.17.98025',
  to: '2.57.0.98285',
  heroes: {
    Alex: [{ kind: 'stat', target: 'Health', old: 1698, new: 1780 }],
    Garr: [{ kind: 'talent', target: 'Unrivaled Strength', level: '1', field: 'damage', old: '125%', new: '75%' }],
    Abat: [{ kind: 'talent', target: 'Bombard Strain', level: '13', field: 'reduction', old: '50%', new: '40%' }],
  },
};

describe('build matching', () => {
  it('assigns the first live build published within 3 days of the notes', () => {
    expect(buildForRecord({ date: '2026-09-28', kind: 'patch' }, BUILDS)).toBe('2.57.0.98285');
    expect(buildForRecord({ date: '2026-10-05', kind: 'hotfix' }, BUILDS)).toBe('2.57.0.98348');
    expect(buildForRecord({ date: '2026-09-14', kind: 'ptr' }, BUILDS)).toBe('2.57.0.98126_ptr');
    expect(buildForRecord({ date: '2026-08-01', kind: 'patch' }, BUILDS)).toBeUndefined();
  });

  it('gives notes on consecutive days consecutive builds (each build used once)', () => {
    const recs = [
      { date: '2026-10-05', kind: 'hotfix', title: 'Hotfix - 10/5/2026' },
      { date: '2026-09-29', kind: 'hotfix', title: 'Hotfix - 9/29/2026' },
      { date: '2026-09-28', kind: 'patch', title: 'Live' },
      { date: '2026-09-14', kind: 'ptr', title: 'PTR' },
    ] as const;
    expect(assignBuilds(recs, BUILDS)).toEqual(['2.57.0.98348', '2.57.0.98304', '2.57.0.98285', '2.57.0.98126_ptr']);
  });

  it('derives the major from the newest build published by then', () => {
    expect(majorForDate('2026-09-20', BUILDS)).toBe('2.57');
    expect(majorForDate('2025-01-27', BUILDS)).toBe('2.55');
  });
});

describe('diff lines', () => {
  it('reads directions from numbers (lower cooldowns and costs are better)', () => {
    expect(diffDirection({ kind: 'stat', target: 'Health', old: 1698, new: 1780 })).toBe('buff');
    expect(diffDirection({ kind: 'ability', target: 'X', field: 'cooldown', old: 60, new: 75 })).toBe('nerf');
    expect(diffDirection({ kind: 'ability', target: 'X', field: 'cost', old: '60 Mana', new: '50 Mana' })).toBe('buff');
    expect(diffDirection({ kind: 'talent-added', target: 'X', level: '4' })).toBe('change');
  });

  it('writes short lines of our own', () => {
    expect(diffLine({ kind: 'stat', target: 'Health', old: 1698, new: 1780 })).toEqual({ section: 'Game data', kind: 'numeric', stat: 'Health', old: 1698, new: 1780, text: 'Health 1698 → 1780', dir: 'buff' });
    expect(diffLine({ kind: 'talent', target: 'Anchored Core', level: '1', field: 'radius', old: '50%', new: '25%' })).toEqual({
      section: 'Game data',
      target: 'Anchored Core',
      level: '1',
      kind: 'numeric',
      stat: 'Radius',
      old: 50,
      new: 25,
      unit: '%',
      text: 'Radius 50% → 25%',
      dir: 'nerf',
    });
    expect(diffLine({ kind: 'talent-added', target: 'New One', level: '4' })).toMatchObject({ kind: 'added', text: 'New level 4 talent.' });
    expect(diffLine({ kind: 'ability', target: 'X', field: 'cooldown', new: 40 })).toMatchObject({ kind: 'changed', text: 'Cooldown — → 40' });
  });
});

describe('enrichWithDiff', () => {
  it('adds numbers to number-less lines and lists heroes the notes skipped', () => {
    const p: Patch = {
      id: '2026-09-28-patch',
      version: '2.57',
      ...rec({
        heroes: {
          Abat: { verdict: 'nerf', changes: [{ section: 'Level 13', target: 'Bombard Strain', kind: 'changed', text: "Effect changed (see Blizzard's notes)", dir: 'nerf' }] },
          Alex: { verdict: 'buff', changes: [{ section: 'Base', kind: 'numeric', stat: 'Health', old: 1698, new: 1780, text: 'Health 1698 → 1780', dir: 'buff' }] },
        },
      }),
    };
    const out = enrichWithDiff(p, DIFF, new Set());
    expect(out.heroes.Abat?.changes[0]?.text).toBe("Effect changed; game data: reduction 50% → 40% (see Blizzard's notes)");
    expect(out.heroes.Alex?.changes).toHaveLength(1);
    expect(out.heroes.Garr).toEqual({
      verdict: 'nerf',
      changes: [{ section: 'Game data', target: 'Unrivaled Strength', level: '1', kind: 'numeric', stat: 'Damage', old: 125, new: 75, unit: '%', text: 'Damage 125% → 75%', dir: 'nerf' }],
    });
    expect(Object.keys(out.heroes)).toEqual(['Abat', 'Alex', 'Garr']);
    // Idempotent: enriching an enriched record changes nothing.
    expect(enrichWithDiff(out, DIFF, new Set())).toEqual(out);
  });

  it('does not repeat numbers a numeric change about the same target already shows', () => {
    const diff: Diff = {
      id: '2.57.0.98304..2.57.0.98348',
      from: '2.57.0.98304',
      to: '2.57.0.98348',
      heroes: {
        HXAL: [
          { kind: 'ability', target: 'Void Volley', field: 'damage', old: 90, new: 72 },
          { kind: 'ability', target: 'Void Volley', field: 'cooldown', old: 12, new: 10 },
        ],
      },
    };
    const p: Patch = {
      id: '2026-10-05-hotfix',
      version: '2.57',
      ...rec({
        heroes: {
          HXAL: {
            verdict: 'nerf',
            changes: [
              { section: 'Abilities', target: 'Void Volley', kind: 'numeric', stat: 'Base damage per missile', old: 90, new: 72, text: 'Base damage per missile 90 → 72', dir: 'nerf' },
              { section: 'Abilities', target: 'Void Volley', kind: 'changed', text: "Effect changed (see Blizzard's notes)", dir: 'change' },
            ],
          },
        },
      }),
    };
    const out = enrichWithDiff(p, diff, new Set());
    expect(out.heroes.HXAL?.changes[1]?.text).toBe("Effect changed; game data: cooldown 12 → 10 (see Blizzard's notes)");
    // Nothing new to add: the line stays our plain template.
    const onlyShown = enrichWithDiff(p, { ...diff, heroes: { HXAL: diff.heroes.HXAL?.slice(0, 1) ?? [] } }, new Set());
    expect(onlyShown.heroes.HXAL?.changes[1]?.text).toBe("Effect changed (see Blizzard's notes)");
  });
});

describe('assemblePatches', () => {
  const diffs: Diff[] = [DIFF, { id: '2.57.0.98304..2.57.0.98348', from: '2.57.0.98304', to: '2.57.0.98348', heroes: { HXAL: [{ kind: 'ability', target: 'Void Volley', field: 'damage', old: 90, new: 72 }] } }];
  const parsed = [
    rec({}),
    rec({ date: '2026-09-14', kind: 'ptr', title: 'PTR Patch Notes', contentHash: 'aaaaaaaaaaaaaaaa' }),
    rec({ date: '2024-12-01', title: 'Too old', contentHash: 'bbbbbbbbbbbbbbbb' }),
  ];
  const patches = assemblePatches(parsed, { builds: BUILDS, diffs, since: '2025-01-01', fallbackMajor: '2.57' });

  it('matches builds, merges diffs, adds undocumented updates and drops old notes', () => {
    expect(patches.map((p) => [p.id, p.build ?? null, p.kind])).toEqual([
      ['2026-10-05-hotfix', '2.57.0.98348', 'hotfix'],
      ['2026-09-28-patch', '2.57.0.98285', 'patch'],
      ['2026-09-14-ptr', '2.57.0.98126_ptr', 'ptr'],
    ]);
    expect(patches[0]?.title).toMatch(/Undocumented game data update/);
    expect(patches[0]?.heroes.HXAL?.changes[0]?.text).toBe('Damage 90 → 72');
    expect(patches[1]?.heroes.Alex).toBeDefined();
    expect(PatchesFileSchema.safeParse(patches).success).toBe(true);
  });

  it('dates diffs by the notes that document them', () => {
    const dated = diffDates(diffs, patches, BUILDS);
    expect(dated.map((d) => d.date)).toEqual(['2026-09-28', '2026-10-05']);
  });

  it('numbers same-day records of one kind', () => {
    const ids = assignIds([
      { ...rec({ contentHash: '1111111111111111', title: 'B' }), version: '2.57' },
      { ...rec({ contentHash: '2222222222222222', title: 'A' }), version: '2.57' },
    ]).map((p) => [p.id, p.title]);
    expect(ids).toEqual([
      ['2026-09-28-patch-2', 'B'],
      ['2026-09-28-patch', 'A'],
    ]);
  });
});
