/**
 * Renders heroes-data2 RawText game strings to plain text (SPEC §5 heroes.json `text`).
 *
 * RawText markup seen in the 2.57 data: `<c val=.. hlt-name=..>…</c>` (coloured numbers),
 * `<s val=..>…</s>` (styled spans), `<n/>` (line break), `<img …/>` (inline quest icons) and
 * per-level scaling written right after a number as `~~0.04~~`. Output: tags removed, `<n/>`
 * as `\n`, scaling as ` (+4% per level)`, at most one blank line in a row, lines trimmed.
 */
import { decodeEntities } from '../util.ts';

const SCALING_RE = /~~\s*(-?\d*\.?\d+)\s*~~/g;

/** `0.04` → `4`, `0.0475` → `4.75` (percent per level, no float noise). */
export function scalingPercent(raw: string): string {
  const pct = Math.round(Number(raw) * 100 * 10000) / 10000;
  return String(pct);
}

export function renderGameText(raw: string | undefined | null): string {
  if (!raw) return '';
  let s = raw;
  s = s.replace(/<n\s*\/>/gi, '\n');
  s = s.replace(/<img\b[^>]*\/?>/gi, '');
  s = s.replace(/<\/?(?:c|s|w|d|a|font|span)\b[^>]*>/gi, '');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(SCALING_RE, (_m, v: string) => ` (+${scalingPercent(v)}% per level)`);
  s = s.replace(/[​-‍﻿]/g, '');
  const lines = s.split('\n').map((line) => line.replace(/[ \t ]+/g, ' ').trim());
  const out: string[] = [];
  for (const line of lines) {
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/** Text with the "(+4% per level)" annotations removed (for number-by-number diffs). */
export function stripScaling(text: string): string {
  return text.replace(/ \(\+-?[\d.]+% per level\)/g, '');
}

/** `Cooldown: 4 seconds`, `Charge Cooldown: 10 seconds` → 4 / 10 (seconds). */
export function parseCooldown(raw: string | undefined | null): number | undefined {
  if (!raw) return undefined;
  const text = renderGameText(raw);
  const m = /cooldown:\s*(\d+(?:\.\d+)?)\s*second/i.exec(text);
  return m ? Number(m[1]) : undefined;
}

/**
 * `Mana: 50` → `50 Mana`; `Mana: 6 per second` → `6 Mana per second`; `Health: 15%` → `15% Health`.
 * Anything unrecognised is returned as rendered text.
 */
export function parseCost(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const text = renderGameText(raw).replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const m = /^([A-Za-z][A-Za-z ]*?):\s*(\d+(?:\.\d+)?%?)(.*)$/.exec(text);
  if (!m) return text;
  const [, kind, amount, rest] = m;
  return `${amount} ${kind}${rest ?? ''}`.replace(/\s+/g, ' ').trim();
}
