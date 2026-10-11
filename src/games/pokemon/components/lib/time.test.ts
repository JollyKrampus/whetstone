import { describe, expect, it } from 'vitest';
import { countdown, dayTimeUTC, elapsedShare, windowClose, windowText } from './time.ts';

const END = '2026-12-02T01:59:00Z';

describe('countdown', () => {
  it('counts to the end of the inclusive minute', () => {
    expect(windowClose(END)).toBe(Date.parse('2026-12-02T01:59:59.999Z'));
    const c = countdown(END, Date.parse('2026-10-08T10:45:00Z'));
    expect(c).toMatchObject({ ended: false, days: 54, hours: 15, text: '54 d 15 h', long: '54 days and 15 hours' });
  });

  it('switches units near the end and after it', () => {
    expect(countdown(END, Date.parse('2026-12-01T22:00:00Z')).text).toBe('3 h 59 min');
    expect(countdown(END, Date.parse('2026-12-02T01:57:30Z')).text).toBe('2 min');
    expect(countdown(END, Date.parse('2026-12-02T01:59:30Z')).text).toBe('under a minute');
    expect(countdown(END, Date.parse('2026-12-02T02:00:00Z'))).toMatchObject({ ended: true, text: 'ended' });
    expect(countdown('nonsense', 0).ended).toBe(true);
  });

  it('measures how much of the window has passed', () => {
    const start = '2026-09-09T02:00:00Z';
    expect(elapsedShare(start, END, Date.parse(start))).toBe(0);
    expect(elapsedShare(start, END, Date.parse('2027-01-01T00:00:00Z'))).toBe(1);
    expect(elapsedShare(start, END, Date.parse('2026-10-26T02:00:00Z'))).toBeCloseTo(0.56, 2);
  });
});

describe('window dates', () => {
  it('writes both ends of a regulation in one format', () => {
    expect(dayTimeUTC('2026-09-09T02:00:00Z')).toBe('9 Sep 2026, 02:00 UTC');
    expect(windowText('2026-09-09T02:00:00Z', END)).toBe('9 Sep 2026, 02:00 UTC to 2 Dec 2026, 01:59 UTC');
    expect(dayTimeUTC('nonsense')).toBe('—');
  });
});
