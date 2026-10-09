import { describe, expect, it } from 'vitest';
import {
  MISSING,
  compact,
  fixed,
  formatDateTimeUTC,
  formatDateUTC,
  formatDayUTC,
  hoursBetween,
  int,
  pct,
  pp,
  relativeTime,
  signed,
  toTime,
} from './format.ts';

describe('numbers', () => {
  it('formats percentages', () => {
    expect(pct(0.5412)).toBe('54.1%');
    expect(pct(0.5)).toBe('50.0%');
    expect(pct(1)).toBe('100.0%');
    expect(pct(0.12345, 2)).toBe('12.35%');
    expect(pct(0.5412, 0)).toBe('54%');
    expect(pct(Number.NaN)).toBe(MISSING);
  });

  it('formats percentage points with a sign', () => {
    expect(pp(1.234)).toBe('+1.2 pp');
    expect(pp(-0.46)).toBe('-0.5 pp');
    expect(pp(0)).toBe('0.0 pp');
    expect(pp(-0.04)).toBe('0.0 pp');
    expect(pp(2.5, 2)).toBe('+2.50 pp');
    expect(pp(Number.POSITIVE_INFINITY)).toBe(MISSING);
  });

  it('formats signed numbers without negative zero', () => {
    expect(signed(3)).toBe('+3');
    expect(signed(-2.5, 1)).toBe('-2.5');
    expect(signed(0)).toBe('0');
    expect(signed(-0.0001, 2)).toBe('0.00');
    expect(fixed(-0.001, 1)).toBe('0.0');
    expect(fixed(Number.NaN)).toBe(MISSING);
  });

  it('formats integers with separators', () => {
    expect(int(0)).toBe('0');
    expect(int(812)).toBe('812');
    expect(int(12345.6)).toBe('12,346');
    expect(int(-1234567)).toBe('-1,234,567');
    expect(int(Number.NaN)).toBe(MISSING);
  });

  it('formats compact counts', () => {
    expect(compact(0)).toBe('0');
    expect(compact(999)).toBe('999');
    expect(compact(999.6)).toBe('1k');
    expect(compact(1000)).toBe('1k');
    expect(compact(1234)).toBe('1.2k');
    expect(compact(12345)).toBe('12.3k');
    expect(compact(123456)).toBe('123k');
    expect(compact(999_950)).toBe('1M');
    expect(compact(2_500_000)).toBe('2.5M');
    expect(compact(3_000_000_000)).toBe('3B');
    expect(compact(-1500)).toBe('-1.5k');
    expect(compact(Number.NaN)).toBe(MISSING);
  });
});

describe('time', () => {
  const now = '2026-10-08T12:00:00Z';

  it('parses moments', () => {
    expect(toTime(new Date(5))).toBe(5);
    expect(toTime(5)).toBe(5);
    expect(toTime('2026-10-08T12:00:00Z')).toBe(Date.parse(now));
    expect(toTime('')).toBeNaN();
    expect(toTime('nope')).toBeNaN();
    expect(toTime(null)).toBeNaN();
    expect(toTime(Number.POSITIVE_INFINITY)).toBeNaN();
    expect(hoursBetween('2026-10-08T06:00:00Z', now)).toBe(6);
  });

  it.each([
    ['2026-10-08T11:59:40Z', 'just now'],
    ['2026-10-08T11:48:00Z', '12 min ago'],
    ['2026-10-08T07:00:00Z', '5 h ago'],
    ['2026-10-07T04:00:00Z', '32 h ago'],
    ['2026-10-05T12:00:00Z', '3 days ago'],
    ['2026-08-20T12:00:00Z', '49 days ago'],
    ['2026-07-01T12:00:00Z', '1 Jul 2026'],
    ['2026-10-08T14:30:00Z', 'in 2 h'],
    ['2026-10-12T12:00:00Z', 'in 4 days'],
  ])('%s → %s', (when, text) => {
    expect(relativeTime(when, now)).toBe(text);
  });

  it('returns a dash for invalid input', () => {
    expect(relativeTime('nope', now)).toBe(MISSING);
    expect(relativeTime(now, 'nope')).toBe(MISSING);
  });

  it('formats UTC dates regardless of the local zone', () => {
    const t = '2026-10-08T23:59:00-05:00';
    expect(formatDateUTC(t)).toBe('2026-10-09');
    expect(formatDateTimeUTC(t)).toBe('2026-10-09 04:59 UTC');
    expect(formatDayUTC('2026-01-05T00:00:00Z')).toBe('5 Jan 2026');
    expect(formatDateUTC('bad')).toBe(MISSING);
    expect(formatDateTimeUTC('bad')).toBe(MISSING);
    expect(formatDayUTC('bad')).toBe(MISSING);
  });
});
