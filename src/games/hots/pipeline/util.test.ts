import { describe, expect, it } from 'vitest';
import { addDays, cleanText, compareBuilds, daysBetween, decodeEntities, heroSlug, isPtrBuild, kebabSlug, majorOf, searchKey, status } from './util.ts';

describe('util', () => {
  it('compares builds numerically and reads majors', () => {
    expect(['2.57.0.98348', '2.55.17.98025', '2.57.0.98285', '2.9.0.1'].sort(compareBuilds)).toEqual(['2.9.0.1', '2.55.17.98025', '2.57.0.98285', '2.57.0.98348']);
    expect(compareBuilds('2.57.0.98217_ptr', '2.57.0.98217')).toBe(0);
    expect(majorOf('2.57.0.98348')).toBe('2.57');
    expect(isPtrBuild('2.57.0.98217_ptr')).toBe(true);
  });

  it('makes slugs and search keys', () => {
    expect(heroSlug('Li-Ming')).toBe('liming');
    expect(heroSlug('Lúcio')).toBe('lucio');
    expect(heroSlug("Xal'atath")).toBe('xalatath');
    expect(kebabSlug("Blackheart's Bay")).toBe('blackhearts-bay');
    expect(kebabSlug('Tomb of the Spider Queen')).toBe('tomb-of-the-spider-queen');
    expect(searchKey("Cho'gall")).toBe('chogall');
    expect(searchKey('리밍')).toBe('리밍');
  });

  it('does date arithmetic in UTC', () => {
    expect(addDays('2026-09-28', 3)).toBe('2026-10-01');
    expect(daysBetween('2026-09-28', '2026-10-08')).toBe(10);
  });

  it('decodes entities and cleans text', () => {
    // A no-break space becomes a plain space: change lines are plain text.
    expect(decodeEntities('A&nbsp;&amp;&#39;B&#x2019;&bogus;')).toBe("A &'B\u2019&bogus;");
    expect(cleanText(' a\u200b  b\n c ')).toBe('a b c');
  });

  it('omits an undefined status detail', () => {
    expect(status('tact', 'ok', null)).toEqual({ id: 'tact', fetchedAt: null, status: 'ok' });
  });
});
