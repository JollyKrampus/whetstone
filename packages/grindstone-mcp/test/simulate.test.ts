import { describe, expect, it } from 'vitest';
import { parseAndResolve } from '../src/core/deck.js';
import { canPay, dealSampleHand, hypergeometric, rng, type SimCard, simulateHands } from '../src/core/simulate.js';
import { createServer } from '../src/server.js';
import { fixtureIndex, readFixture, testContext } from './fixture.js';
import { call, connect } from './helpers.js';

function choose(n: bigint, k: bigint): bigint {
  let r = 1n;
  for (let i = 1n; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

/** Exact P(at least 2 lands in 7 from a 24-land, 60-card deck), computed with BigInt. */
const P_AT_LEAST_2_OF_24 =
  1 - Number(choose(36n, 7n) + choose(24n, 1n) * choose(36n, 6n)) / Number(choose(60n, 7n));

const land = (produces: SimCard['produces']): SimCard => ({ name: 'L', land: true, produces, mv: 0, pips: { W: 0, U: 0, B: 0, R: 0, G: 0 }, roles: [] });

describe('math', () => {
  it('hypergeometric matches a hand-computed value', () => {
    const viaHelper = 1 - hypergeometric(60, 24, 7, 0) - hypergeometric(60, 24, 7, 1);
    expect(viaHelper).toBeCloseTo(P_AT_LEAST_2_OF_24, 10);
    expect(P_AT_LEAST_2_OF_24).toBeCloseTo(0.8573, 4);
    const total = [0, 1, 2, 3, 4, 5, 6, 7].reduce((s, k) => s + hypergeometric(60, 24, 7, k), 0);
    expect(total).toBeCloseTo(1, 10);
  });

  it('rng is seeded and uniform-ish', () => {
    const a = rng(42);
    const b = rng(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    const r = rng(7);
    const mean = Array.from({ length: 20000 }, () => r()).reduce((s, x) => s + x, 0) / 20000;
    expect(mean).toBeCloseTo(0.5, 2);
  });

  it('canPay assigns each land to one pip', () => {
    const pips = { W: 1, U: 1, B: 0, R: 0, G: 0 };
    expect(canPay(pips, [land(['W', 'U']), land(['U'])])).toBe(true);
    expect(canPay(pips, [land(['W', 'U'])])).toBe(false);
    expect(canPay({ ...pips, W: 2 }, [land(['W', 'U']), land(['U']), land(['W'])])).toBe(true);
  });
});

describe('simulateHands', () => {
  it('matches the hypergeometric land distribution for a 24-land deck', async () => {
    const deck = await parseAndResolve('24 Mountain\n36 Shock', await fixtureIndex());
    const r = simulateHands(deck, { iterations: 20000, seed: 3 });
    const simAtLeast2 = r.openingLands.filter((x) => x.lands >= 2).reduce((s, x) => s + x.simulated, 0);
    expect(Math.abs(simAtLeast2 - P_AT_LEAST_2_OF_24)).toBeLessThan(0.01);
    for (const row of r.openingLands) expect(Math.abs(row.simulated - row.exact)).toBeLessThan(0.012);
    // 2-5 lands with castable 1-drops: keepable equals P(2 <= lands <= 5).
    const exactKeep = r.openingLands.filter((x) => x.lands >= 2 && x.lands <= 5).reduce((s, x) => s + x.exact, 0);
    expect(Math.abs(r.keepable7 - exactKeep)).toBeLessThan(0.01);
    expect(r.mulliganRate).toBeCloseTo(1 - r.keepable7, 3);
  });

  it('is deterministic for a seed', async () => {
    const deck = await parseAndResolve(readFixture('standard-boros.txt'), await fixtureIndex());
    const a = simulateHands(deck, { iterations: 2000, seed: 9 });
    expect(simulateHands(deck, { iterations: 2000, seed: 9 })).toEqual(a);
    expect(simulateHands(deck, { iterations: 2000, seed: 10 })).not.toEqual(a);
  });

  it('reports land drops, colors and custom checks', async () => {
    const deck = await parseAndResolve(readFixture('standard-boros.txt'), await fixtureIndex());
    const r = simulateHands(deck, {
      iterations: 4000,
      checks: [
        { role: 'removal', byTurn: 3 },
        { card: 'Voice of Victory', byTurn: 2 },
      ],
    });
    expect(r.landDrops.turn2).toBeGreaterThan(r.landDrops.turn5);
    expect(r.landDrops.turn2).toBeGreaterThan(0.8);
    expect(r.colors.find((c) => c.card === 'Voice of Victory')!.turn).toBe(2);
    expect(r.checks[0]!.probability).toBeGreaterThan(0.6);
    expect(r.checks[1]!.probability).toBeGreaterThan(0.2);
    expect(r.checks[1]!.probability).toBeLessThan(0.6);
    const kept = r.keptAt['7'] + r.keptAt['6'] + r.keptAt['5'];
    expect(kept).toBeCloseTo(1, 3);
  });

  it('drawing first sees more cards than playing first', async () => {
    const deck = await parseAndResolve(readFixture('standard-boros.txt'), await fixtureIndex());
    const play = simulateHands(deck, { iterations: 4000, playDraw: 'play' });
    const draw = simulateHands(deck, { iterations: 4000, playDraw: 'draw' });
    expect(draw.landDrops.turn3).toBeGreaterThan(play.landDrops.turn3);
  });

  it('Bo1 smoothing pulls opening hands toward the land ratio', async () => {
    const deck = await parseAndResolve('24 Mountain\n36 Shock', await fixtureIndex());
    const plain = simulateHands(deck, { iterations: 20000, seed: 5 });
    const smooth = simulateHands(deck, { iterations: 20000, seed: 5, bo1Smoothing: true });
    const extremes = (r: typeof plain) => r.openingLands.filter((x) => x.lands <= 1 || x.lands >= 5).reduce((s, x) => s + x.simulated, 0);
    expect(extremes(smooth)).toBeLessThan(extremes(plain));
    expect(smooth.keepable7).toBeGreaterThan(plain.keepable7);
    expect(smooth.notes.join(' ')).toMatch(/approximation/);
  });
});

describe('deal_sample_hand', () => {
  it('deals 7 plus 3, reproducibly by seed', async () => {
    const deck = await parseAndResolve(readFixture('standard-boros.txt'), await fixtureIndex());
    const a = dealSampleHand(deck, 123);
    expect(a.hand).toHaveLength(7);
    expect(a.nextDraws).toHaveLength(3);
    expect(dealSampleHand(deck, 123)).toEqual(a);
  });

  it('is exposed with a random seed that it reports back', async () => {
    const client = await connect(createServer(testContext()));
    const text = readFixture('standard-boros.txt');
    const first = await call(client, 'deal_sample_hand', { text });
    const again = await call(client, 'deal_sample_hand', { text, seed: first.body.seed });
    expect(again.body).toEqual(first.body);
    const sim = await call(client, 'simulate_hands', { text, iterations: 500, checks: [{ byTurn: 2 }] });
    expect(sim).toMatchObject({ isError: true, body: { error: 'bad_check' } });
  });
});
