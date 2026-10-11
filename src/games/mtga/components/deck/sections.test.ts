import { describe, expect, it } from 'vitest';
import { legalityLines } from '../CardPeek.tsx';
import { companionText, feelBadText, paperBudget } from './sections.tsx';

describe('analyzer copy helpers', () => {
  it('keeps banned formats out of "Legal in" (COPY-1)', () => {
    const legal = { standard: 'banned', pioneer: 'banned', historic: 'legal', timeless: 'restricted', brawl: 'legal' } as const;
    expect(legalityLines(legal)).toEqual({
      legalIn: ['Historic', 'Timeless (restricted)', 'Brawl'],
      bannedIn: ['Standard', 'Pioneer'],
    });
    expect(legalityLines({})).toEqual({ legalIn: [], bannedIn: [] });
  });

  it('says which feel-bad cards the casual version swaps out and which it only scores down', () => {
    expect(feelBadText([])).toEqual([]);
    const text = feelBadText([
      { name: 'Time Warp', oracleId: 'a', avoid: ['extra turns'], penalize: [] },
      { name: 'Duress', oracleId: 'b', avoid: [], penalize: ['hand attack'] },
      { name: 'Counterspell', oracleId: 'c', avoid: [], penalize: ['counterspells'] },
    ]);
    expect(text).toHaveLength(2);
    expect(text[0]).toContain('Time Warp (extra turns)');
    expect(text[1]).toContain('Duress (hand attack); Counterspell (counterspells)');
  });

  it("states the companion's condition as met, broken (by which cards) or unknown", () => {
    const base = { name: 'Lurrus of the Dream-Den', condition: 'Each permanent card in your starting deck has mana value 2 or less.', inSideboard: true };
    expect(companionText({ ...base, breaking: [] })).toMatch(/^Condition met: Each permanent/);
    const many = Array.from({ length: 10 }, (_, i) => `Card ${i + 1}`);
    const broken = companionText({ ...base, breaking: many });
    expect(broken).toMatch(/^Condition broken: .* Breaking it: Card 1, Card 2, .* and Card 8 and 2 more\.$/);
    expect(companionText({ ...base, condition: null, breaking: [] })).toMatch(/doesn't know a companion condition for Lurrus/);
  });

  it('adds up paper prices per rarity and skips cards without one', () => {
    const prices: Record<string, number> = { Bolt: 0.5, Angel: 12 };
    const cards = [
      { name: 'Bolt', qty: 4, rarity: 'common' as const },
      { name: 'Angel', qty: 2, rarity: 'mythic' as const },
      { name: 'Mystery', qty: 4, rarity: 'rare' as const },
    ];
    expect(paperBudget(cards, (n) => prices[n])).toEqual({ byRarity: { common: 2, uncommon: 0, rare: 0, mythic: 24 }, total: 26, unpriced: 1 });
    // Shards without prices: no paper column at all.
    expect(paperBudget(cards, () => undefined)).toBeNull();
  });
});
