import { describe, expect, it } from 'vitest';
import { parseAndResolve } from '../src/core/deck.js';
import { getFormat } from '../src/core/formats.js';
import { buildMeta, type MetaListInput } from '../src/core/meta.js';
import { ratePower } from '../src/core/power.js';
import { createServer } from '../src/server.js';
import { fixtureIndex, readFixture, testContext } from './fixture.js';
import { call, connect } from './helpers.js';

const TIER_DECKS = [
  ['t1-pile', 1],
  ['t2-white-weenie', 2],
  ['t3-gruul', 3],
  ['t4-boros-midrange', 4],
  ['t5-mono-red', 5],
] as const;

const metaLists = (): MetaListInput[] => JSON.parse(readFixture('meta-historic.json')).decks;

async function rate(file: string, withMeta = true) {
  const index = await fixtureIndex();
  const deck = await parseAndResolve(readFixture(`tiers/${file}.txt`), index);
  const meta = withMeta ? await buildMeta(metaLists(), index) : undefined;
  return ratePower(deck, getFormat('historic'), { meta, asOf: '2026-10-08' });
}

describe('rate_power rubric', () => {
  for (const [file, tier] of TIER_DECKS) {
    it(`rates ${file} as tier ${tier}`, async () => {
      const r = await rate(file);
      expect(r.tier).toBe(tier);
      for (const d of r.dimensions) {
        expect(d.reasons.length).toBeGreaterThanOrEqual(1);
        expect(d.reasons.length).toBeLessThanOrEqual(3);
        expect(d.score).toBeGreaterThanOrEqual(0);
        expect(d.score).toBeLessThanOrEqual(100);
      }
      expect(r).toMatchSnapshot();
    });
  }

  it('is deterministic', async () => {
    expect(await rate('t3-gruul')).toEqual(await rate('t3-gruul'));
  });

  it('marks card quality low confidence without meta lists', async () => {
    const r = await rate('t5-mono-red', false);
    const quality = r.dimensions.find((d) => d.name === 'Card quality')!;
    expect(quality.confidence).toBe('low');
    expect((await rate('t5-mono-red')).dimensions.find((d) => d.name === 'Card quality')!.confidence).toBe('normal');
  });

  it('explains mana problems in Karsten terms', async () => {
    const r = await rate('t1-pile');
    const mana = r.dimensions.find((d) => d.name === 'Mana base')!;
    expect(mana.reasons[0]).toMatch(/^Only \d+ \w+ sources for .+; Karsten recommends \d+\.$/);
  });

  it('uses the Brawl rubric for commander formats', async () => {
    const index = await fixtureIndex();
    const deck = await parseAndResolve(readFixture('standardbrawl-krenko.txt'), index);
    const r = ratePower(deck, getFormat('standardbrawl'), { asOf: '2026-10-08' });
    expect(r.rubric).toMatch(/Brawl/);
    expect(r.dimensions.map((d) => d.name)).toEqual([
      'Mana base',
      'Commander synergy',
      'Ramp',
      'Card draw',
      'Interaction',
      'Card quality',
    ]);
    const synergy = r.dimensions.find((d) => d.name === 'Commander synergy')!;
    expect(synergy.reasons[0]).toMatch(/Goblin/);
  });

  it('is exposed as rate_power with inline meta lists', async () => {
    const client = await connect(createServer(testContext()));
    const r = await call(client, 'rate_power', {
      text: readFixture('tiers/t5-mono-red.txt'),
      format: 'historic',
      meta: metaLists(),
    });
    expect(r.isError).toBe(false);
    expect(r.body).toMatchObject({ format: 'historic', tier: 5, label: 'Competitive' });
  });
});
