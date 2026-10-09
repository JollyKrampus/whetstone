import { describe, expect, it } from 'vitest';
import type { CuratedSnapshotView, MyList } from './metaLists.ts';
import { bytesText, isMetaChoice, metaByFormat, nameIn, progressText, replaceName } from './view.ts';

const mine: MyList[] = [
  { id: 'a', format: 'standard', name: 'Mono-Red', list: 'Deck\n4 Shock', addedAt: '2026-10-01T00:00:00.000Z', metaShare: 0.2 },
  { id: 'b', format: 'pioneer', name: 'Phoenix', list: 'Deck\n4 Opt', addedAt: '2026-10-01T00:00:00.000Z' },
];
const curated: CuratedSnapshotView[] = [
  { format: 'standard', date: '2026-10-08', decks: [{ name: 'Boros', list: 'Deck\n4 Lightning Strike', sourceUrl: 'https://example.org/a' }] },
  { format: 'historic', decks: [{ name: 'Example', list: 'Deck\n4 Opt', example: true }] },
  { format: 'timeless', example: true, decks: [{ name: 'Example 2', list: 'Deck\n4 Opt' }] },
];

describe('meta selections for the analyzer', () => {
  it('prefers the visitor\'s lists and falls back to curated ones in automatic mode', () => {
    const auto = metaByFormat('auto', mine, curated);
    expect(auto.standard?.label).toBe('My Standard lists');
    expect(auto.standard?.lists).toEqual([{ list: 'Deck\n4 Shock', name: 'Mono-Red', metaShare: 0.2 }]);
    expect(auto.pioneer?.lists).toHaveLength(1);
    expect(metaByFormat('auto', [], curated).standard?.label).toBe('Curated Standard lists (2026-10-08)');
  });

  it('never treats example decks as meta and honours explicit choices', () => {
    expect(metaByFormat('auto', [], curated).historic).toBeUndefined();
    expect(metaByFormat('auto', [], curated).timeless).toBeUndefined();
    expect(metaByFormat('curated', mine, curated).standard?.label).toMatch(/^Curated/);
    expect(metaByFormat('curated', mine, curated).pioneer).toBeUndefined();
    expect(metaByFormat('mine', mine, curated).standard?.label).toBe('My Standard lists');
    expect(metaByFormat('none', mine, curated)).toEqual({});
    expect(isMetaChoice('mine')).toBe(true);
    expect(isMetaChoice('everything')).toBe(false);
  });
});

describe('progress text', () => {
  it('describes download, cache and indexing steps', () => {
    expect(progressText(null)).toBe('Analyzing the deck…');
    expect(progressText(null, 'Searching…')).toBe('Searching…');
    expect(progressText({ type: 'progress', stage: 'cache', pool: 'standard' })).toBe('Loading Standard cards from this browser…');
    expect(progressText({ type: 'progress', stage: 'index', pool: 'arena' })).toBe('Indexing every Arena card…');
    expect(progressText({ type: 'progress', stage: 'download', pool: 'arena', loaded: 1_048_576, total: 2_097_152 })).toBe(
      'Downloading every Arena card: 1.0 MB of 2.0 MB…',
    );
    expect(progressText({ type: 'progress', stage: 'download', pool: 'standard', loaded: 524_288 })).toBe('Downloading Standard cards: 0.5 MB…');
  });

  it('formats byte sizes', () => {
    expect(bytesText(829 * 1024)).toBe('829 KB');
    expect(bytesText(2.5 * 1_048_576)).toBe('2.5 MB');
    expect(bytesText(10)).toBe('1 KB');
  });
});

describe('fixing unrecognized lines', () => {
  it('extracts the name from an issue line', () => {
    expect(nameIn('4 Lightnig Strike')).toBe('Lightnig Strike');
    expect(nameIn('4x Lightnig Strike (M21) 152')).toBe('Lightnig Strike');
    expect(nameIn('Lightnig Strike')).toBe('Lightnig Strike');
    expect(nameIn(undefined)).toBeUndefined();
    expect(nameIn('   ')).toBeUndefined();
  });

  it('replaces the name on the reported line, else on the first line holding it', () => {
    const text = 'Deck\n4 Shock\n4 Lightnig Strike (M21) 152\n\nSideboard\n2 Lightnig Strike';
    expect(replaceName(text, 3, 'Lightnig Strike', 'Lightning Strike')).toBe('Deck\n4 Shock\n4 Lightning Strike (M21) 152\n\nSideboard\n2 Lightnig Strike');
    expect(replaceName(text, 6, 'Lightnig Strike', 'Lightning Strike')?.endsWith('2 Lightning Strike')).toBe(true);
    expect(replaceName(text, 2, 'Lightnig Strike', 'Lightning Strike')).toContain('4 Lightning Strike (M21)');
    expect(replaceName(text, undefined, 'Nope', 'Yes')).toBeNull();
  });
});
