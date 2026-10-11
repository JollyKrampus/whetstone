/**
 * Countdown and window helpers for regulation and season banners. Pure: callers pass `now`
 * (build time on the server, the visitor's clock after hydration). Regulation ends are inclusive
 * to the minute ("01:59 UTC"), so the window closes at end + 59.999 s.
 */
import { MISSING, formatDayTimeUTC } from '../../../../core/format.ts';

export const MINUTE = 60_000;

/** Exclusive end of a window whose `end` is inclusive to the minute. */
export function windowClose(endIso: string): number {
  return Date.parse(endIso) + MINUTE - 1;
}

export interface Countdown {
  ended: boolean;
  days: number;
  hours: number;
  minutes: number;
  /** "54 d 15 h", "15 h 3 min", "3 min", "under a minute", or "ended". */
  text: string;
  /** Screen-reader friendly long form: "54 days and 15 hours". */
  long: string;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export function countdown(endIso: string, now: number): Countdown {
  const left = windowClose(endIso) - now;
  if (!(left > 0) || !Number.isFinite(left)) return { ended: true, days: 0, hours: 0, minutes: 0, text: 'ended', long: 'ended' };
  const totalMinutes = Math.floor(left / MINUTE);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  let text: string;
  let long: string;
  if (days > 0) {
    text = `${days} d ${hours} h`;
    long = `${plural(days, 'day')} and ${plural(hours, 'hour')}`;
  } else if (hours > 0) {
    text = `${hours} h ${minutes} min`;
    long = `${plural(hours, 'hour')} and ${plural(minutes, 'minute')}`;
  } else if (minutes > 0) {
    text = `${minutes} min`;
    long = plural(minutes, 'minute');
  } else {
    text = 'under a minute';
    long = 'under a minute';
  }
  return { ended: false, days, hours, minutes, text, long };
}

/** Share of the window already elapsed, 0–1. */
export function elapsedShare(startIso: string, endIso: string, now: number): number {
  const start = Date.parse(startIso);
  const end = windowClose(endIso);
  if (!(end > start)) return 1;
  return Math.min(1, Math.max(0, (now - start) / (end - start)));
}

/**
 * "9 Sep 2026, 02:00 UTC": the one date format the regulation banner and the about page use for
 * both ends of a window (the site's formatDayTimeUTC; MISSING for an unparseable time).
 */
export function dayTimeUTC(iso: string): string {
  return Number.isFinite(Date.parse(iso)) ? formatDayTimeUTC(iso) : MISSING;
}

/** "9 Sep 2026, 02:00 UTC to 2 Dec 2026, 01:59 UTC". */
export function windowText(startIso: string, endIso: string): string {
  return `${dayTimeUTC(startIso)} to ${dayTimeUTC(endIso)}`;
}
