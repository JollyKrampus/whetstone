/**
 * Client half of FreshnessBadge/StaleBanner: rewrites absolute build-time dates into "3 h ago"
 * and re-grades data age against the visitor's clock, because a static page can be read days
 * after it was built. Never upgrades a server-side 'broken'/'unknown' verdict (it can't see
 * per-source status). Imported by both components; Vite runs it once per page.
 */
import { formatDateTimeUTC, hoursBetween, relativeTime } from '../core/format.ts';
import { levelForAge } from '../core/freshness.ts';
import { STATE_WORD } from './freshness.ts';

function refresh() {
  const now = Date.now();

  for (const el of document.querySelectorAll<HTMLTimeElement>('time[data-rel-time]')) {
    const iso = el.dateTime;
    if (!iso) continue;
    el.textContent = relativeTime(iso, now);
    el.title = formatDateTimeUTC(iso);
  }

  for (const badge of document.querySelectorAll<HTMLElement>('[data-fresh]')) {
    const at = badge.dataset.generatedAt;
    if (!at || badge.dataset.state === 'broken' || badge.dataset.state === 'unknown') continue;
    const level = levelForAge(hoursBetween(at, now));
    badge.dataset.state = level;
    const word = badge.querySelector<HTMLElement>('[data-fresh-label]');
    if (word) {
      word.textContent = STATE_WORD[level];
      word.hidden = STATE_WORD[level] === '';
    }
  }

  for (const banner of document.querySelectorAll<HTMLElement>('[data-stale-age]')) {
    const at = banner.dataset.generatedAt;
    banner.hidden = !at || levelForAge(hoursBetween(at, now)) !== 'stale';
  }
}

refresh();
// A tab left open across a refresh window should not keep claiming "just now".
setInterval(refresh, 60_000);
