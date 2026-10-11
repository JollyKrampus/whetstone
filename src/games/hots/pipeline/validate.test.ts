import { describe, expect, it } from 'vitest';
import type { OutputFile } from '../../../core/game.ts';
import { crossCheck, validateHots, validateMeta } from './validate.ts';

const counts = { heroes: 91, maps: 19, patches: 27 };

describe('validateHots', () => {
  it('rejects a wrong custody class and a schema violation', () => {
    const files: OutputFile[] = [
      { path: 'pro.json', data: {}, custody: 'A' },
      { path: 'maps.json', data: [{ id: 'Not A Slug' }], custody: 'A' },
      { path: 'img/x.webp', data: null, custody: 'A', bytes: new Uint8Array([1]) },
    ];
    const issues = validateHots({ files, offline: true, previousCounts: null, counts });
    expect(issues.some((i) => i.level === 'error' && /pro\.json: emitted as class A but registered as class A-SA/.test(i.message))).toBe(true);
    expect(issues.some((i) => i.level === 'error' && /^maps\.json/.test(i.message))).toBe(true);
    expect(issues.some((i) => /img/.test(i.message))).toBe(false);
  });

  it('accepts a private overlay of the draft shard only with the overlay schema', () => {
    const ok = validateHots({ files: [{ path: 'public/draft.json', data: { stats: {} }, custody: 'B' }], offline: true, previousCounts: null, counts });
    expect(ok.some((i) => i.level === 'error')).toBe(true);
  });

  it('enforces minimums and drops online only', () => {
    const files: OutputFile[] = [];
    expect(validateHots({ files, offline: true, previousCounts: { heroes: 91 }, counts: { heroes: 5, maps: 1, patches: 0 } })).toEqual([]);
    const online = validateHots({ files, offline: false, previousCounts: { heroes: 91, patches: 27 }, counts: { heroes: 60, maps: 19, patches: 26 } });
    expect(online.map((i) => i.message).join('\n')).toMatch(/heroes: 60 is below the minimum of 80/);
    expect(online.map((i) => i.message).join('\n')).toMatch(/heroes: dropped from 91 to 60/);
    expect(online.some((i) => /patches/.test(i.message))).toBe(false);
  });
});

describe('validateMeta', () => {
  it('checks the meta the runner will write', () => {
    const meta = {
      game: 'hots' as const,
      schema: 1,
      version: { label: '2.57', build: '2.57.0.98348', since: '2026-09-28' },
      sources: [],
      counts: { heroes: 91 },
      extra: { build: '2.57.0.98348', major: '2.57', majorSince: '2026-09-28', builds: ['2.57.0.98348'] },
    };
    expect(validateMeta(meta, '2026-10-08T10:00:00.000Z')).toEqual([]);
    expect(validateMeta({ ...meta, extra: { ...meta.extra, builds: [] } }, '2026-10-08T10:00:00.000Z')[0]?.message).toMatch(/extra\.builds/);
  });
});

describe('crossCheck', () => {
  it('warns about references to unknown heroes and maps', () => {
    const heroes = [{ id: 'Abat', memberOf: undefined, members: undefined }] as never;
    const issues = crossCheck({
      heroes,
      maps: [{ id: 'cursed-hollow' }] as never,
      theory: { rulesVersion: 'x', counters: [{ a: 'Abat', b: 'Nope', score: 50, source: 'theory', reasons: [] }], synergies: [], mapFit: [{ hero: 'Abat', map: 'moon', score: 50, reasons: [] }] } as never,
      links: { heroes: { Ghost: [] }, general: [] },
      rotation: { heroes: ['Abat', 'Gone'] } as never,
    });
    expect(issues.map((i) => i.message)).toEqual([
      'theory.json: 1 edge(s) reference unknown entities',
      'theory.json: 1 map-fit row(s) reference unknown heroes or maps',
      'links.json: unknown hero ids Ghost',
      'rotation.json: unknown hero ids Gone',
    ]);
    expect(issues.every((i) => i.level === 'warn')).toBe(true);
  });
});
