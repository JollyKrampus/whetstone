/**
 * Display formatting shared by every game. Browser-safe and locale-independent on purpose:
 * pages are rendered at build time and hydrated in the browser, so the same input must give
 * the same string on the CI runner and on any visitor's machine (no Intl, no implicit "now").
 */

/** Shown in place of a number that is missing or not finite. */
export const MISSING = '—';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** A moment as a Date, an ISO string or epoch milliseconds. */
export type TimeInput = Date | string | number;

/** Epoch milliseconds, or NaN when the input is not a valid moment. */
export function toTime(value: TimeInput | null | undefined): number {
  if (value === null || value === undefined) return Number.NaN;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (value.trim() === '') return Number.NaN;
  return Date.parse(value);
}

/** Hours from `from` to `to` (positive when `to` is later); NaN when either is invalid. */
export function hoursBetween(from: TimeInput, to: TimeInput): number {
  return (toTime(to) - toTime(from)) / 3_600_000;
}

/** `toFixed` without the "-0.0" artefact. */
export function fixed(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return MISSING;
  const text = value.toFixed(digits);
  return Number(text) === 0 ? (0).toFixed(digits) : text;
}

/** Number with an explicit sign: `+1.2`, `-0.4`, `0.0` (zero carries no sign). */
export function signed(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return MISSING;
  const text = fixed(value, digits);
  return Number(text) > 0 ? `+${text}` : text;
}

/** A proportion as a percentage: `pct(0.5412)` → `"54.1%"`. */
export function pct(proportion: number, digits = 1): string {
  if (!Number.isFinite(proportion)) return MISSING;
  return `${fixed(proportion * 100, digits)}%`;
}

/** A value already in percentage points: `pp(1.234)` → `"+1.2 pp"`, `pp(-0.5)` → `"-0.5 pp"`. */
export function pp(deltaPp: number, digits = 1): string {
  if (!Number.isFinite(deltaPp)) return MISSING;
  return `${signed(deltaPp, digits)} pp`;
}

/** Rounded integer with thousands separators: `int(12345.6)` → `"12,346"`. */
export function int(value: number): string {
  if (!Number.isFinite(value)) return MISSING;
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = String(Math.abs(rounded));
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

const COMPACT_UNITS = [
  { size: 1e3, suffix: 'k' },
  { size: 1e6, suffix: 'M' },
  { size: 1e9, suffix: 'B' },
] as const;

/** Short count for badges: `999` → `"999"`, `1234` → `"1.2k"`, `123456` → `"123k"`, `2.5e6` → `"2.5M"`. */
export function compact(value: number): string {
  if (!Number.isFinite(value)) return MISSING;
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (Math.round(abs) < 1000) return sign + String(Math.round(abs));
  for (let i = 0; i < COMPACT_UNITS.length; i++) {
    const unit = COMPACT_UNITS[i]!;
    const next = COMPACT_UNITS[i + 1];
    const scaled = abs / unit.size;
    const digits = scaled < 100 ? 1 : 0;
    const text = scaled.toFixed(digits);
    // 999,950 must read "1M", not "1000.0k".
    if (Number(text) >= 1000 && next) continue;
    return sign + text.replace(/\.0$/, '') + unit.suffix;
  }
  return sign + String(Math.round(abs));
}

/**
 * Coarse relative time against an explicit `now` (pages pass the build time so SSR and
 * hydration agree): "just now", "12 min ago", "5 h ago", "3 days ago", "in 2 h", and the UTC
 * date once it is more than 60 days away.
 */
export function relativeTime(when: TimeInput, now: TimeInput): string {
  const then = toTime(when);
  const ref = toTime(now);
  if (!Number.isFinite(then) || !Number.isFinite(ref)) return MISSING;
  const diffMs = ref - then;
  const future = diffMs < 0;
  const abs = Math.abs(diffMs);
  const minutes = abs / 60_000;
  const hours = minutes / 60;
  const days = hours / 24;
  let span: string;
  if (minutes < 1) return 'just now';
  if (minutes < 60) span = `${Math.floor(minutes)} min`;
  else if (hours < 48) span = `${Math.floor(hours)} h`;
  else if (days < 60) span = `${Math.floor(days)} days`;
  else return formatDayUTC(then);
  return future ? `in ${span}` : `${span} ago`;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** `2026-10-08` (UTC). */
export function formatDateUTC(value: TimeInput): string {
  const t = toTime(value);
  if (!Number.isFinite(t)) return MISSING;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** `2026-10-08 10:17 UTC`. */
export function formatDateTimeUTC(value: TimeInput): string {
  const t = toTime(value);
  if (!Number.isFinite(t)) return MISSING;
  const d = new Date(t);
  return `${formatDateUTC(t)} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())} UTC`;
}

/** `8 Oct 2026` (UTC), for prose. */
export function formatDayUTC(value: TimeInput): string {
  const t = toTime(value);
  if (!Number.isFinite(t)) return MISSING;
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
