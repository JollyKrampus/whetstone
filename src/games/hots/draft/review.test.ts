import { describe, expect, it } from 'vitest';
import { keyMatchups, reviewDraft, reviewText, REVIEW_COUNTERS } from './review.ts';
import { idOf, statsData, theoryData } from './testkit.ts';

const theory = theoryData();
const stats = statsData();
const id = (name: string) => idOf(theory, name);

// The e2e Storm League plan: you end with Muradin, Malfurion, Li-Ming, Varian and Xal'atath.
const OURS = ['Muradin', 'Malfurion', 'Li-Ming', 'Varian', "Xal'atath"].map(id);
const THEIRS = ['chogall', id('Valla'), id('Tracer'), id("Anub'arak")];
const input = { ours: OURS, theirs: THEIRS, oursBans: [id('Abathur'), id('Zeratul')], theirsBans: [id('Diablo')], map: 'cursed-hollow' };

describe('draft review', () => {
  const review = reviewDraft(theory, input);

  it('lists the strongest counters each way, strongest first, with their headline reason', () => {
    for (const side of [review.ours, review.theirs]) {
      expect(side.counters.length).toBeLessThanOrEqual(REVIEW_COUNTERS);
      side.counters.forEach((c, i) => {
        expect(c.value).toBeGreaterThan(0);
        if (i > 0) expect(c.value).toBeLessThanOrEqual(side.counters[i - 1]!.value);
        expect(c.basis).toBe('theory');
      });
    }
    const anub = review.theirs.counters.find((c) => c.a.name === "Anub'arak" && c.b.name === 'Li-Ming');
    expect(anub?.reason.text).toContain('Harden Carapace');
    expect(review.ours.counters.every((c) => OURS.includes(c.a.id) && THEIRS.includes(c.b.id))).toBe(true);
  });

  it('finds the best synergy pair, map fit and the guardrail verdict per team', () => {
    expect(review.ours.synergy).not.toBeNull();
    expect(OURS).toContain(review.ours.synergy!.a.id);
    expect(OURS).toContain(review.ours.synergy!.b.id);
    expect(review.map?.name).toBe('Cursed Hollow');
    for (const side of [review.ours, review.theirs]) {
      side.mapFit.forEach((r, i) => i > 0 && expect(r.value).toBeLessThanOrEqual(side.mapFit[i - 1]!.value));
    }
    // The enemy drafted no Healer.
    expect(review.theirs.sound).toBe(false);
    expect(review.theirs.summary.problems).toContain('No Healer.');
    expect(review.usesStats).toBe(false);
  });

  it('writes a plain-text summary for chat with the key matchups and the link', () => {
    const text = reviewText(review, { url: 'https://example.test/whetstone/hots/draft/#v=1&s=abc' });
    const lines = text.split('\n');
    expect(lines[0]).toBe('Draft review · Cursed Hollow');
    expect(lines[1]).toBe("You: Muradin, Malfurion, Li-Ming, Varian, Xal'atath (bans: Abathur, Zeratul)");
    expect(lines[2]).toBe("Enemy: Cho'gall, Valla, Tracer, Anub'arak (bans: Diablo)");
    expect(lines).toContain('Key matchups:');
    const key = keyMatchups(review);
    expect(key.length).toBe(3);
    expect(lines.filter((l) => l.startsWith('- '))).toHaveLength(3);
    expect(text).toContain('Enemy: No Healer.');
    expect(text).toContain('Theory: rules applied to hero kits, not win rates.');
    expect(lines.at(-1)).toBe('https://example.test/whetstone/hots/draft/#v=1&s=abc');
    expect(text).not.toMatch(/<|>|\*\*/);
  });

  it('uses listable statistics when a block is in use, with the credit in the copied text', () => {
    const r = reviewDraft(stats, input);
    const all = [...r.ours.counters, ...r.theirs.counters];
    for (const c of all.filter((x) => x.basis === 'stat')) {
      expect(c.reason.n).toBeGreaterThanOrEqual(50);
      expect(Math.abs(c.reason.delta!)).toBeGreaterThanOrEqual(1.5);
      expect(c.reason.source).toBe(stats.statsSource);
    }
    if (r.usesStats) {
      const text = reviewText(r, { statsLabel: 'Storm League · test', statsCredit: 'Data provided by a test source.' });
      expect(text).toContain('Match statistics: Storm League · test. Data provided by a test source.');
    }
    expect(reviewDraft(stats, { ...input, useStats: false }).usesStats).toBe(false);
  });
});
