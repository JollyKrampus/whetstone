import { describe, expect, it } from 'vitest';
import { applyFree, freeTeam, picksOf, replaySequential, startFree } from '../../../core/draft.ts';
import { entityRules, freeConfig, slConfig } from './rules.ts';
import { buildUniverse, createAramCodec, createDraftCodec, freeHash, restoreFree, restoreSequential, slHash } from './state.ts';

const ENTITIES = [
  { id: 'Zera', releaseDate: '2014-03-13' },
  { id: 'Abat', releaseDate: '2014-03-13' },
  { id: 'Anub', releaseDate: '2014-10-07' },
  { id: 'chogall', releaseDate: '2015-11-17' },
  { id: 'Crus', releaseDate: '2015-06-02' },
  { id: 'Malf', releaseDate: '2014-03-13' },
  { id: 'Mura', releaseDate: '2014-03-13' },
  { id: 'Wiza', releaseDate: '2016-02-02' },
  { id: 'Tra0', releaseDate: '2016-04-19' },
  { id: 'Demo', releaseDate: '2014-03-13' },
  { id: 'Vari', releaseDate: '2016-11-15' },
  { id: 'Diab', releaseDate: '2014-03-13' },
  { id: 'HXAL', releaseDate: '2026-09-28' },
];
const RULES = entityRules([{ id: 'chogall', slots: 2 }]);
const FULL = ['Abat', 'Anub', null, null, 'Malf', 'chogall', 'Wiza', 'Tra0', null, 'Diab', 'Demo', 'Vari', 'HXAL', 'Zera', 'Crus'];

describe('universe', () => {
  it('orders by release date, then id, and ignores input order and duplicates', () => {
    const u = buildUniverse(ENTITIES);
    expect(u.slice(0, 6)).toEqual(['Abat', 'Demo', 'Diab', 'Malf', 'Mura', 'Zera']);
    expect(u.at(-1)).toBe('HXAL');
    expect(buildUniverse([...ENTITIES].reverse())).toEqual(u);
    expect(buildUniverse([...ENTITIES, { id: 'Abat', releaseDate: '2014-03-13' }])).toEqual(u);
  });

  it('puts undated entities last', () => {
    expect(buildUniverse([{ id: 'Zz' }, { id: 'Aa', releaseDate: '2020-01-01' }])).toEqual(['Aa', 'Zz']);
  });
});

describe('Storm League hash', () => {
  const universe = buildUniverse(ENTITIES);
  const codec = createDraftCodec(universe);
  const config = slConfig('b', RULES);
  const state = replaySequential(config, FULL).state;

  it('round-trips a complete draft within the 200-character budget', () => {
    const info = codec.encodeWithInfo(slHash('cursed-hollow', 'b', state));
    expect(info.fits).toBe(true);
    expect(info.dropped).toEqual([]);
    expect(info.hash).toMatch(/^#v=1&m=cursed-hollow&fp=b&s=[0-9a-z-]{30}$/);
    const back = codec.decodeWithInfo(info.hash);
    expect(back.ok).toBe(true);
    expect(back.state.mode).toBe('sl');
    expect(back.state.steps).toEqual(FULL);
    const restored = restoreSequential(slConfig(back.state.firstPick, RULES), back.state.steps);
    expect(restored.error).toBeUndefined();
    expect(restored.state.complete).toBe(true);
    expect(picksOf(restored.state, 'A')).toEqual(picksOf(state, 'A'));
  });

  it('omits defaults, so an empty draft is just the version', () => {
    expect(codec.encode(slHash('', 'a', replaySequential(config, []).state))).toBe('#v=1');
  });

  it('keeps old links valid when a new hero is released (appended to the universe)', () => {
    const hash = codec.encode(slHash('dragon-shire', 'a', state));
    const next = createDraftCodec(buildUniverse([...ENTITIES, { id: 'NEWH', releaseDate: '2027-01-12' }]));
    expect(next.decode(hash).steps).toEqual(FULL);
    // And the new hero gets an index after every existing one.
    expect(next.encode({ steps: ['NEWH'] })).toBe(`#v=1&s=${universe.length.toString(36).padStart(2, '0')}`);
  });

  it('restores the longest legal prefix from a doctored link', () => {
    // Malf twice: the second one is a mirror pick at step 6.
    const hash = codec.encode({ steps: ['Abat', null, null, null, 'Malf', 'Malf', 'Mura'] });
    const back = codec.decode(hash);
    const restored = restoreSequential(slConfig('a', RULES), back.steps);
    expect(restored.applied).toBe(5);
    expect(restored.requested).toBe(7);
    expect(restored.error?.reason).toBe('taken');
  });

  it('degrades unknown indices and garbage to defaults without throwing', () => {
    const back = codec.decodeWithInfo('#v=1&m=Not A Map&fp=z&s=zz00&mode=weird');
    expect(back.ok).toBe(false);
    expect(back.state.map).toBe('');
    expect(back.state.firstPick).toBe('a');
    expect(back.state.mode).toBe('sl');
    expect(back.state.steps).toEqual([null, universe[0]]);
    expect(codec.decode('#nonsense').steps).toEqual([]);
    expect(codec.decode('#v=9&s=00').steps).toEqual([]);
  });
});

describe('free-mode hash', () => {
  const codec = createDraftCodec(buildUniverse(ENTITIES));
  const config = freeConfig(RULES);

  it('round-trips both teams and both ban lists', () => {
    let s = startFree(config);
    for (const m of [
      { team: 'B', action: 'pick', id: 'chogall' },
      { team: 'A', action: 'pick', id: 'Malf' },
      { team: 'A', action: 'ban', id: 'Zera' },
      { team: 'B', action: 'ban', id: 'Tra0' },
      { team: 'A', action: 'pick', id: 'Mura' },
    ] as const) {
      const r = applyFree(s, m);
      if (!r.ok) throw new Error(r.message);
      s = r.state;
    }
    const hash = codec.encode(freeHash('towers-of-doom', s));
    expect(hash).toContain('mode=free');
    const back = codec.decode(hash);
    const restored = restoreFree(config, back);
    expect(restored.error).toBeUndefined();
    expect(freeTeam(restored.state, 'A')).toEqual(freeTeam(s, 'A'));
    expect(freeTeam(restored.state, 'B')).toEqual(freeTeam(s, 'B'));
    expect(back.map).toBe('towers-of-doom');
  });

  it('skips illegal entries but keeps the rest', () => {
    const back = codec.decode(codec.encode({ mode: 'free', ourPicks: ['Malf'], enemyPicks: ['Malf', 'Mura'] }));
    const restored = restoreFree(config, back);
    expect(restored.applied).toBe(2);
    expect(restored.error?.reason).toBe('taken');
    expect(freeTeam(restored.state, 'B').picks).toEqual(['Mura']);
  });
});

describe('ARAM hash', () => {
  it('round-trips options, allies and enemies', () => {
    const codec = createAramCodec(buildUniverse(ENTITIES));
    const s = { map: 'braxis-outpost', options: ['Malf', 'Mura', 'Wiza'], allies: ['Zera'], enemies: ['Malf', 'HXAL'] };
    expect(codec.decode(codec.encode(s))).toEqual(s);
  });
});
