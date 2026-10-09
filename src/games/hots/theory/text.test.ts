import { describe, expect, it } from 'vitest';
import { blank, maskPhrase, normalizeText, SNIPPET_MAX, snippetAround, splitSentences, stripScaling } from './text.ts';

describe('text helpers', () => {
  it('strips per-level scaling and normalises typography', () => {
    expect(stripScaling('Deals 153 (+4% per level) damage.')).toBe('Deals 153 damage.');
    expect(normalizeText('Dragon’s Breath  hits')).toBe("Dragon's Breath hits");
  });

  it('splits sentences on line breaks and sentence ends but not abbreviations or decimals', () => {
    expect(splitSentences('Lt. Morales heals for 0.5 seconds. Then stops!\nQuest: Do it.')).toEqual(['Lt. Morales heals for 0.5 seconds.', 'Then stops!', 'Quest: Do it.']);
  });

  it('blanks and masks without changing length', () => {
    const s = 'Snow Blind blinds them.';
    expect(blank(s, /blinds/g)).toHaveLength(s.length);
    expect(maskPhrase(s, 'Snow Blind')).toBe('§§§§§§§§§§ blinds them.');
    expect(maskPhrase("Snow Blind's cooldown", 'Snow Blind')).toBe("§§§§§§§§§§'s cooldown");
  });

  it('keeps short snippets whole and cuts long ones around the match', () => {
    expect(snippetAround('Short sentence.', 0)).toBe('Short sentence.');
    const long = `${'word '.repeat(40)}TARGET${' tail'.repeat(40)}`;
    const snip = snippetAround(long, long.indexOf('TARGET'), 6);
    expect(snip.length).toBeLessThanOrEqual(SNIPPET_MAX);
    expect(snip).toContain('TARGET');
    expect(snip.startsWith('…')).toBe(true);
    expect(snip.endsWith('…')).toBe(true);
  });
});
