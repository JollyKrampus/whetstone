import { describe, expect, it } from 'vitest';
import type { GameMeta, SourceStatus } from './game.ts';
import { FRESHNESS, freshness, levelForAge } from './freshness.ts';

const NOW = '2026-10-08T12:00:00Z';

function meta(generatedAt: string, sources: SourceStatus[] = []): Pick<GameMeta, 'generatedAt' | 'sources'> {
  return { generatedAt, sources };
}

describe('levelForAge', () => {
  it('uses 30 h / 54 h bands', () => {
    expect(FRESHNESS).toEqual({ freshHours: 30, agingHours: 54 });
    expect(levelForAge(0)).toBe('fresh');
    expect(levelForAge(29.9)).toBe('fresh');
    expect(levelForAge(30)).toBe('aging');
    expect(levelForAge(53.9)).toBe('aging');
    expect(levelForAge(54)).toBe('stale');
    expect(levelForAge(Number.NaN)).toBe('stale');
    expect(levelForAge(10, { freshHours: 5, agingHours: 20 })).toBe('aging');
  });
});

describe('freshness', () => {
  it('is fresh right after the daily run', () => {
    const f = freshness(meta('2026-10-08T10:17:00Z'), NOW);
    expect(f.ageHours).toBeCloseTo(1.7167, 3);
    expect(f.level).toBe('fresh');
    expect(f.label).toBe('Updated 1 h ago');
  });

  it('ages after one missed run and goes stale after two', () => {
    expect(freshness(meta('2026-10-07T04:00:00Z'), NOW)).toMatchObject({ level: 'aging', label: 'Updated 32 h ago' });
    expect(freshness(meta('2026-10-05T10:00:00Z'), NOW)).toMatchObject({
      level: 'stale',
      label: 'Data may be out of date (updated 3 days ago)',
    });
  });

  it('handles bad timestamps and clock skew', () => {
    const bad = freshness(meta('not a date'), NOW);
    expect(bad.ageHours).toBe(Number.POSITIVE_INFINITY);
    expect(bad).toMatchObject({ level: 'stale', label: 'Update time unknown' });
    expect(freshness(meta('2026-10-08T13:00:00Z'), NOW).ageHours).toBe(0);
  });

  it('accepts Date and epoch "now"', () => {
    const at = '2026-10-08T06:00:00Z';
    expect(freshness(meta(at), new Date(NOW)).ageHours).toBe(6);
    expect(freshness(meta(at), Date.parse(NOW)).ageHours).toBe(6);
  });

  it('summarises each source', () => {
    const f = freshness(
      meta('2026-10-08T10:17:00Z', [
        { id: 'heroes-data2', fetchedAt: '2026-10-08T10:15:00Z', status: 'ok' },
        { id: 'blizzard-news', fetchedAt: '2026-10-06T10:00:00Z', status: 'stale', detail: 'HTTP 503' },
        { id: 'heroesprofile', fetchedAt: null, status: 'disabled', detail: 'HP_MODE=off' },
        { id: 'nexuscompendium', fetchedAt: null, status: 'ok' },
      ]),
      NOW,
      { names: { 'heroes-data2': 'heroes-data2', 'blizzard-news': 'Blizzard news' } },
    );
    expect(f.level).toBe('fresh');
    expect(f.sources.map((s) => [s.id, s.level])).toEqual([
      ['heroes-data2', 'fresh'],
      ['blizzard-news', 'aging'],
      ['heroesprofile', 'disabled'],
      ['nexuscompendium', 'stale'],
    ]);
    expect(f.sources[1]).toMatchObject({
      name: 'Blizzard news',
      label: 'Last good data 2 days ago (latest fetch failed)',
      detail: 'HTTP 503',
      ageHours: 50,
    });
    expect(f.sources[2]).toMatchObject({ ageHours: null, label: 'Disabled', detail: 'HP_MODE=off' });
    expect(f.sources[3]!.label).toBe('Never updated');
    expect('detail' in f.sources[0]!).toBe(false);
    expect(f.degraded).toEqual(['blizzard-news']);
    expect(f.disabled).toEqual(['heroesprofile']);
    expect(f.broken).toEqual([]);
  });

  it('never calls a degraded source fresh', () => {
    const f = freshness(meta(NOW, [{ id: 'x', fetchedAt: '2026-10-08T11:00:00Z', status: 'failed' }]), NOW);
    expect(f.sources[0]!.level).toBe('aging');
  });

  it('is broken when a source failed without ever producing data', () => {
    const f = freshness(
      meta('2026-10-08T10:17:00Z', [
        { id: 'liquipedia', fetchedAt: null, status: 'failed', detail: 'HTTP 429' },
        { id: 'heroes-data2', fetchedAt: '2026-10-08T10:15:00Z', status: 'ok' },
      ]),
      NOW,
      { names: { liquipedia: 'Liquipedia' } },
    );
    expect(f.level).toBe('broken');
    expect(f.broken).toEqual(['liquipedia']);
    expect(f.label).toBe('Some data is unavailable: Liquipedia');
    expect(f.sources[0]).toMatchObject({ level: 'broken', label: 'Failed, no data yet' });
  });
});
