import { describe, expect, it } from 'vitest';
import { averageGihWr, formatSlug, limitedCodec, normColors, normRarities, viewRows, wrBand, type LimitedRow, type LimitedView } from './limited.ts';

function row(name: string, colors: string, rarity: LimitedRow['rarity'], gih: number, gihWr: number | null, extra: Partial<LimitedRow> = {}): LimitedRow {
  return { name, colors, rarity, gih, gp: gih * 2, gpWr: null, gihWr, ohWr: null, gdWr: null, gnsWr: null, iwd: null, alsa: null, ata: null, ...extra };
}

const ROWS: LimitedRow[] = [
  row('Bolt', 'R', 'common', 5000, 0.6, { alsa: 2.1, ata: 1.9 }),
  row('Angel', 'W', 'rare', 800, 0.62, { alsa: 1.2, ata: 1.1 }),
  row('Golem', '', 'uncommon', 3000, 0.55, { alsa: 6.5, ata: 7.2 }),
  row('Boros Charm', 'WR', 'uncommon', 1200, 0.58),
  row('Newcard', 'U', 'mythic', 40, null),
  row('Bear', 'G', 'common', 9000, 0.53),
];

const VIEW: LimitedView = { sort: 'gihWr', dir: 'desc', colors: '', rarities: '', minGames: 0, query: '' };
const names = (v: Partial<LimitedView>) => viewRows(ROWS, { ...VIEW, ...v }).map((r) => r.name);

describe('Limited table view', () => {
  it('sorts by a column with missing numbers always last and name as the tie-break', () => {
    expect(names({})).toEqual(['Angel', 'Bolt', 'Boros Charm', 'Golem', 'Bear', 'Newcard']);
    expect(names({ dir: 'asc' })).toEqual(['Bear', 'Golem', 'Boros Charm', 'Bolt', 'Angel', 'Newcard']);
    expect(names({ sort: 'ata', dir: 'asc' })).toEqual(['Angel', 'Bolt', 'Golem', 'Bear', 'Boros Charm', 'Newcard']);
    expect(names({ sort: 'name', dir: 'asc' })[0]).toBe('Angel');
    expect(names({ sort: 'gih', dir: 'desc' })[0]).toBe('Bear');
    // Rarity descending puts mythic first; colours put colourless last.
    expect(names({ sort: 'rarity', dir: 'desc' })[0]).toBe('Newcard');
    expect(names({ sort: 'colors', dir: 'asc' }).at(-1)).toBe('Golem');
  });

  it('filters to cards castable in the chosen colours, rarities, sample size and name', () => {
    expect(names({ colors: 'R' })).toEqual(['Bolt', 'Golem']);
    expect(names({ colors: 'RW' })).toEqual(['Angel', 'Bolt', 'Boros Charm', 'Golem']);
    expect(names({ rarities: 'u' })).toEqual(['Boros Charm', 'Golem']);
    expect(names({ rarities: 'cm' })).toEqual(['Bolt', 'Bear', 'Newcard']);
    expect(names({ minGames: 1000 })).toEqual(['Bolt', 'Boros Charm', 'Golem', 'Bear']);
    expect(names({ query: 'bo' })).toEqual(['Bolt', 'Boros Charm']);
  });

  it('computes the games-weighted baseline and tint bands', () => {
    const avg = averageGihWr(ROWS)!;
    const expected = (5000 * 0.6 + 800 * 0.62 + 3000 * 0.55 + 1200 * 0.58 + 9000 * 0.53) / (5000 + 800 + 3000 + 1200 + 9000);
    expect(avg).toBeCloseTo(expected, 10);
    expect(averageGihWr([])).toBeNull();
    expect(wrBand(0.6, 0.55)).toBe('hi2');
    expect(wrBand(0.57, 0.55)).toBe('hi1');
    expect(wrBand(0.55, 0.55)).toBe('mid');
    expect(wrBand(0.53, 0.55)).toBe('lo1');
    expect(wrBand(0.5, 0.55)).toBe('lo2');
    expect(wrBand(null, 0.55)).toBe('none');
  });

  it('keeps the view in a short, shareable hash and ignores junk', () => {
    expect(limitedCodec.encode(VIEW)).toBe('#v=1');
    const hash = limitedCodec.encode({ ...VIEW, sort: 'iwd', dir: 'asc', colors: 'WR', rarities: 'cu', minGames: 500, query: 'bolt' });
    expect(limitedCodec.decode(hash)).toEqual({ sort: 'iwd', dir: 'asc', colors: 'WR', rarities: 'cu', minGames: 500, query: 'bolt' });
    expect(limitedCodec.decode('#v=1&s=bogus&c=XYZ&m=-5')).toEqual(VIEW);
    expect(normColors('rgw')).toBe('WRG');
    expect(normRarities('mUc')).toBe('cum');
  });

  it('turns format ids into URL segments', () => {
    expect(formatSlug('PremierDraft')).toBe('premier-draft');
    expect(formatSlug('Sealed')).toBe('sealed');
    expect(formatSlug('PickTwoTradDraft')).toBe('pick-two-trad-draft');
  });
});
