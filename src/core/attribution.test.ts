import { describe, expect, it } from 'vitest';
import type { SourceRef } from './game.ts';
import { ATTRIBUTION_RULES, allCredits, creditText, groupCredits, hasCredits } from './attribution.ts';

const src = (id: string, name: string, rule: SourceRef['rule'], extra: Partial<SourceRef> = {}): SourceRef => ({
  id,
  name,
  url: `https://example.org/${id}`,
  attribution: `Data: ${name}`,
  rule,
  custody: 'A',
  ...extra,
});

const HP = src('heroesprofile', 'Heroes Profile', 'inline', { custody: 'B' });
const LANDS = src('17lands', '17Lands', 'top', { license: 'CC BY 4.0' });
const HDP = src('heroes-data2', 'heroes-data2', 'footer', { license: 'MIT' });
const LIQ = src('liquipedia', 'Liquipedia', 'footer', { license: 'CC BY-SA 3.0', custody: 'A-SA' });
const BLIZ = src('blizzard', 'Blizzard Entertainment', 'footer');

describe('groupCredits', () => {
  it('groups by rule and sorts by name', () => {
    const g = groupCredits([LIQ, HP, HDP, BLIZ, LANDS]);
    expect(g.inline).toEqual([HP]);
    expect(g.top).toEqual([LANDS]);
    expect(g.footer.map((s) => s.id)).toEqual(['blizzard', 'heroes-data2', 'liquipedia']);
  });

  it('dedupes by id and ignores empty entries', () => {
    const g = groupCredits([HDP, null, HDP, undefined, { ...HDP }]);
    expect(g.footer).toHaveLength(1);
    expect(g.footer[0]).toBe(HDP);
  });

  it('keeps the strictest rule when components disagree', () => {
    const demoted = { ...HP, rule: 'footer' as const };
    expect(groupCredits([demoted, HP]).inline).toEqual([HP]);
    expect(groupCredits([HP, demoted]).footer).toEqual([]);
  });

  it('is independent of input order', () => {
    const a = groupCredits([HP, LANDS, HDP, LIQ, BLIZ]);
    const b = groupCredits([BLIZ, LIQ, HDP, LANDS, HP]);
    expect(b).toEqual(a);
  });

  it('flattens, detects emptiness and formats text', () => {
    const g = groupCredits([HDP, HP, LANDS]);
    expect(allCredits(g).map((s) => s.id)).toEqual(['heroesprofile', '17lands', 'heroes-data2']);
    expect(hasCredits(g)).toBe(true);
    expect(hasCredits(groupCredits([]))).toBe(false);
    expect(creditText(LANDS)).toBe('Data: 17Lands (CC BY 4.0) https://example.org/17lands');
    expect(creditText(HP)).toBe('Data: Heroes Profile https://example.org/heroesprofile');
    expect(ATTRIBUTION_RULES).toEqual(['inline', 'top', 'footer']);
  });
});
