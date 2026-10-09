import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readFileSync } from 'node:fs';
import { HOTS_FILES, HOTS_PRIVATE_OVERLAYS } from '../src/games/hots/schema.ts';
import { MTGA_FILES } from '../src/games/mtga/schema.ts';
import { POKEMON_FILES } from '../src/games/pokemon/schema.ts';
import { checkCount, formatPath, hasErrors, registryEntry, validateData, validateFiles, validateOutputs } from './validate.ts';

const Hero = z.object({ id: z.string(), name: z.string(), role: z.enum(['Tank', 'Healer']) });
const Heroes = z.array(Hero);

describe('validate', () => {
  it('returns parsed data when valid', () => {
    const r = validateData(Heroes, [{ id: 'Abat', name: 'Abathur', role: 'Healer' }], { file: 'heroes.json' });
    expect(r.ok).toBe(true);
  });

  it('turns zod issues into readable ValidationIssues with a cap', () => {
    const bad = Array.from({ length: 30 }, (_, i) => ({ id: i, name: 'x', role: 'Tank' }));
    const r = validateData(Heroes, bad, { file: 'heroes.json', source: 'heroes-data2', max: 3 });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.issues).toHaveLength(4);
    expect(r.issues[0]).toEqual({ level: 'error', source: 'heroes-data2', message: expect.stringMatching(/^heroes\.json: \[0\]\.id: /) });
    expect(r.issues[3]?.message).toBe('heroes.json: 27 more schema issue(s)');
    expect(hasErrors(r.issues)).toBe(true);
  });

  it('validates only outputs that have a schema', () => {
    const issues = validateOutputs(
      [
        { path: 'heroes.json', data: [{ id: 'Abat', name: 'Abathur', role: 'Support' }], custody: 'A' },
        { path: 'other.json', data: 'anything', custody: 'A' },
      ],
      { 'heroes.json': Heroes },
      { level: 'warn' },
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.level).toBe('warn');
    expect(issues[0]?.message).toContain('[0].role');
  });

  it('formats paths', () => {
    expect(formatPath([])).toBe('(root)');
    expect(formatPath(['talents', '1', 0, 'name'])).toBe('talents["1"][0].name');
  });

  it('checkCount guards against truncated upstream data', () => {
    expect(checkCount({ name: 'heroes', count: 91, previous: 91, min: 80 })).toEqual([]);
    expect(checkCount({ name: 'heroes', count: 70, previous: 91 })[0]?.message).toMatch(/dropped from 91 to 70/);
    expect(checkCount({ name: 'heroes', count: 10, previous: null, min: 80, source: 'hd2' })[0]).toMatchObject({ level: 'error', source: 'hd2' });
    expect(checkCount({ name: 'heroes', count: 88, previous: 91, maxDropPct: 5 })).toEqual([]);
  });
});

describe('validateFiles (per-game registries)', () => {
  const fixture = (rel: string): unknown => JSON.parse(readFileSync(new URL(`../fixtures/${rel}`, import.meta.url), 'utf8'));

  it('matches exact keys first, then <placeholder> keys within one path segment', () => {
    expect(registryEntry(MTGA_FILES, 'limited/BLB.PremierDraft.json')).toBe(MTGA_FILES['limited/<SET>.<Format>.json']);
    expect(registryEntry(MTGA_FILES, 'limited/index.json')).toBe(MTGA_FILES['limited/index.json']);
    expect(registryEntry(MTGA_FILES, 'limited/x/BLB.PremierDraft.json')).toBeNull();
    expect(registryEntry(POKEMON_FILES, 'usage/gen9championsvgc2026regmc-1760.json')).toBe(POKEMON_FILES['usage/<format>-<cutoff>.json']);
  });

  it('accepts the committed fixtures as pipeline outputs', () => {
    const issues = validateFiles(
      [
        { path: 'heroes.json', data: fixture('hots/heroes.json'), custody: 'A' },
        { path: 'pro.json', data: fixture('hots/pro.json'), custody: 'A-SA' },
        { path: 'public/draft.json', data: fixture('hots/public/draft.json'), custody: 'A' },
        { path: 'img/heroes/abathur.webp', data: null, custody: 'A', bytes: new Uint8Array([1]) },
      ],
      HOTS_FILES,
      { overlays: HOTS_PRIVATE_OVERLAYS },
    );
    expect(issues).toEqual([]);
    expect(validateFiles([{ path: 'limited/BLB.PremierDraft.json', data: fixture('mtga/limited/BLB.PremierDraft.json'), custody: 'A' }], MTGA_FILES)).toEqual([]);
  });

  it('checks a class-B overlay against the overlay schema, not the public shard schema', () => {
    const overlay = { path: 'public/draft.json', data: { stats: 'not a stats block' }, custody: 'B' as const };
    const issues = validateFiles([overlay], HOTS_FILES, { overlays: HOTS_PRIVATE_OVERLAYS, source: 'heroesprofile' });
    expect(hasErrors(issues)).toBe(true);
    expect(issues[0]).toMatchObject({ source: 'heroesprofile' });
    expect(issues[0]?.message).toMatch(/^public\/draft\.json: stats/);
  });

  it('rejects a custody class that differs from the registry and warns on unregistered files', () => {
    const issues = validateFiles(
      [
        { path: 'stats.json', data: {}, custody: 'A' },
        { path: 'mystery.json', data: {}, custody: 'A' },
        { path: 'meta.json', data: {}, custody: 'A' },
      ],
      HOTS_FILES,
    );
    expect(issues.map((i) => [i.level, i.message])).toEqual([
      ['error', 'stats.json: emitted as class A but registered as class B'],
      ['warn', 'mystery.json: no schema registered for this file'],
    ]);
  });
});
