import { describe, expect, it } from 'vitest';
import type { Patch } from '../../schema.ts';
import { majorSince } from './meta.ts';

const patch = (over: Partial<Patch>): Patch => ({
  id: 'x',
  version: '2.57',
  date: '2026-09-28',
  title: 't',
  url: 'https://news.blizzard.com/x',
  kind: 'patch',
  contentHash: '0123456789abcdef',
  notes: 'summary',
  general: [],
  heroes: {},
  ...over,
});

describe('majorSince', () => {
  const builds = [
    { build: '2.57.0.98126_ptr', date: '2026-09-15' },
    { build: '2.57.0.98285', date: '2026-09-29' },
  ];
  it('prefers the first live or balance notes of the major', () => {
    const patches = [patch({ date: '2026-10-05', kind: 'hotfix' }), patch({}), patch({ date: '2026-09-14', kind: 'ptr' })];
    expect(majorSince({ major: '2.57', patches, buildDates: builds, previous: null, today: '2026-10-08' })).toBe('2026-09-28');
  });

  it('falls back to last-good, then the first live release, then today', () => {
    expect(majorSince({ major: '2.57', patches: [], buildDates: builds, previous: { major: '2.57', majorSince: '2026-09-27' }, today: '2026-10-08' })).toBe('2026-09-27');
    expect(majorSince({ major: '2.57', patches: [], buildDates: builds, previous: { major: '2.55', majorSince: '2025-01-01' }, today: '2026-10-08' })).toBe('2026-09-29');
    expect(majorSince({ major: '2.58', patches: [], buildDates: builds, previous: null, today: '2026-10-08' })).toBe('2026-10-08');
  });
});
