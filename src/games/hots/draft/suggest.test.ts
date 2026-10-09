import { describe, expect, it } from 'vitest';
import {
  WEIGHT_PRESETS,
  asOpponent,
  legalCandidates,
  replaySequential,
  sequentialContext,
  type DraftContext,
  type Signal,
} from '../../../core/draft.ts';
import { decodeShard } from './data.ts';
import { availableHeroes, banProviders, hardCounter, pickProviders } from './providers.ts';
import { entityRules, slConfig } from './rules.ts';
import { banWeights, breakdown, disabledNote, presetInfo, reasonLabel, suggest, usesStats } from './suggest.ts';
import { fixtureShard, idOf, statsData, theoryData } from './testkit.ts';

const theory = theoryData();
const stats = statsData();
const id = (name: string) => idOf(theory, name);
const ALL = theory.heroes.map((h) => h.id);

function ctx(partial: Partial<DraftContext>): DraftContext {
  return { team: 'A', action: 'pick', allies: [], enemies: [], bans: [], picksLeft: 5, enemyPicksLeft: 5, ...partial };
}

function signals(list: ReturnType<typeof pickProviders>, candidate: string, c: DraftContext): Signal[] {
  return list.flatMap((p) => {
    const out = p(candidate, c);
    return out ? (Array.isArray(out) ? out : [out]) : [];
  }) as Signal[];
}

describe('decodeShard', () => {
  it('decodes the fixture shard into lookups', () => {
    expect(theory.heroes).toHaveLength(13);
    expect(theory.byId.get('chogall')?.slots).toBe(2);
    expect(theory.stats).toBeNull();
    expect(stats.stats?.mode).toBe('sl');
  });

  it('rejects malformed shards with a readable message', () => {
    expect(() => decodeShard(null)).toThrow(/not a JSON object/);
    expect(() => decodeShard({ ...fixtureShard(), schema: 2 })).toThrow(/unsupported schema/);
    const bad = fixtureShard();
    bad.heroes.name.pop();
    expect(() => decodeShard(bad)).toThrow(/heroes.name has 12 entries/);
  });
});

describe('theory providers', () => {
  const providers = pickProviders({ data: theory });

  it('labels counters as theory, with the edge reason', () => {
    // Anub'arak counters Valla in theory (channel interrupt).
    const s = signals(providers, id("Anub'arak"), ctx({ enemies: [id('Valla')] })).filter((x) => x.key === 'counters');
    const vs = s.find((x) => x.reasons.some((r) => r.text.includes('Valla has channelled abilities')));
    expect(vs?.value).toBeGreaterThan(0);
    expect(vs?.reasons[0]?.kind).toBe('theory');
  });

  it('subtracts reverse counters', () => {
    const s = signals(providers, id('Abathur'), ctx({ enemies: [id("Anub'arak")] }));
    const neg = s.find((x) => x.key === 'counters' && x.value < 0);
    expect(neg?.reasons[0]?.text).toContain('dive onto Abathur');
  });

  it('adds synergy with allies and map fit', () => {
    const s = signals(providers, id('Abathur'), ctx({ allies: [id("Anub'arak")], map: 'dragon-shire' }));
    expect(s.find((x) => x.key === 'synergy')?.value).toBeGreaterThan(0);
    expect(s.filter((x) => x.key === 'map').length).toBe(1);
  });

  it('has no win-rate or tier signals without statistics', () => {
    const s = signals(providers, id('Muradin'), ctx({}));
    expect(s.some((x) => x.key === 'winrate' || x.key === 'tier')).toBe(false);
  });

  it('rewards favourites only for your own picks', () => {
    const fav = pickProviders({ data: theory, favorites: new Set(['muradin']) });
    expect(signals(fav, id('Muradin'), ctx({})).some((x) => x.key === 'pool')).toBe(true);
    expect(signals(fav, id('Muradin'), ctx({ team: 'B' })).some((x) => x.key === 'pool')).toBe(false);
  });

  it('measures blind-pick safety against heroes still available to the enemy', () => {
    const valla = theory.byId.get(id('Valla'))!;
    const counters = availableHeroes(theory, ctx({})).filter((h) => hardCounter(theory, false, h, valla));
    expect(counters.length).toBeGreaterThan(0);
    const open = signals(providers, valla.id, ctx({})).find((x) => x.reasons[0]?.text.includes('can still pick counter it'));
    expect(open?.value).toBeLessThan(0);
    // Ban every counter: Valla becomes a safe blind pick.
    const safe = signals(providers, valla.id, ctx({ bans: counters.map((h) => h.id) })).find((x) => x.reasons[0]?.text.startsWith('Safe blind pick'));
    expect(safe?.value).toBeGreaterThan(0);
  });
});

describe('stats providers', () => {
  const providers = pickProviders({ data: stats });

  it('uses statistics for win rate, tier, counters and map, with n and source', () => {
    const c = ctx({ enemies: [id('Muradin')], allies: [id('Malfurion')], map: 'cursed-hollow' });
    const s = signals(providers, id('Valla'), c);
    const wr = s.find((x) => x.key === 'winrate')!;
    expect(wr.reasons[0]).toMatchObject({ kind: 'stat', source: 'heroesprofile' });
    expect(wr.reasons[0]?.n).toBeGreaterThanOrEqual(15);
    const counter = s.find((x) => x.key === 'counters' && x.reasons[0]?.kind === 'stat');
    expect(counter?.reasons[0]?.text).toMatch(/(Beats|Struggles against) their Muradin/);
    expect(s.some((x) => x.key === 'map' && x.reasons[0]?.kind === 'stat')).toBe(true);
  });

  it('keeps theory as its own lower-weighted signal when stats cover the pair', () => {
    const s = signals(providers, id("Anub'arak"), ctx({ enemies: [id('Valla')] }));
    expect(s.some((x) => x.key === 'theory' && x.reasons[0]?.kind === 'theory')).toBe(true);
  });

  it('hides early-data tiers and low samples', () => {
    // Abathur has 195 games: no tier (early data) in the fixture.
    const s = signals(providers, id('Abathur'), ctx({}));
    expect(s.some((x) => x.key === 'tier')).toBe(false);
    expect(s.some((x) => x.key === 'winrate')).toBe(true);
  });

  it('can be switched off (ARAM page with SL-only stats)', () => {
    const off = pickProviders({ data: stats, useStats: false });
    expect(signals(off, id('Valla'), ctx({})).some((x) => x.key === 'winrate')).toBe(false);
  });
});

describe('suggest', () => {
  const rules = entityRules(theory.heroes);

  function at(choices: (string | null)[]) {
    const state = replaySequential(slConfig('a', rules), choices).state;
    const c = sequentialContext(state, { map: 'cursed-hollow' })!;
    return { state, ctx: c, candidates: legalCandidates(state, ALL) };
  }

  it('ranks deterministically with ≤ 3 reasons and ≤ 1 warning', () => {
    const { ctx: c, candidates } = at([null, null, null, null]);
    const a = suggest({ data: theory, ctx: c, candidates, preset: 'composite' });
    const b = suggest({ data: theory, ctx: c, candidates: [...candidates].reverse(), preset: 'composite' });
    expect(a.map((x) => x.id)).toEqual(b.map((x) => x.id));
    for (const s of a) {
      expect(s.reasons.length).toBeLessThanOrEqual(3);
      expect(s.score).toBeGreaterThanOrEqual(0);
      expect(s.score).toBeLessThanOrEqual(100);
    }
    expect(a.map((x) => x.id)).not.toContain('chogall');
  });

  it('changes after every step', () => {
    const one = at([null, null, null, null]);
    const two = at([null, null, null, null, id('Muradin')]);
    const first = suggest({ data: theory, ctx: one.ctx, candidates: one.candidates, preset: 'composite' }).map((x) => x.id);
    const second = suggest({ data: theory, ctx: two.ctx, candidates: two.candidates, preset: 'composite' }).map((x) => x.id);
    expect(second).not.toEqual(first);
    expect(second).toContain('chogall');
  });

  it('keeps guardrail warnings visible in single-signal sort modes', () => {
    // You have four non-healers; the last pick must be the Healer.
    const picks = at(['Abat', null, null, null, id('Muradin'), id('Zeratul'), id('Tracer'), id('Valla'), id('Li-Ming'), null, null, id('Diablo'), id('Johanna')]);
    expect(picks.ctx).toMatchObject({ team: 'A', action: 'pick', picksLeft: 2 });
    const after = at(['Abat', null, null, null, id('Muradin'), id('Zeratul'), id('Tracer'), id('Valla'), id('Li-Ming'), null, null, id('Diablo'), id('Johanna'), id("Xal'atath")]);
    const list = suggest({ data: theory, ctx: after.ctx, candidates: after.candidates, preset: 'counters' });
    const nonHealer = list.find((s) => s.hero.role !== 'Healer');
    expect(nonHealer?.warning?.text).toBe('Leaves your team without a Healer');
    const composite = suggest({ data: theory, ctx: after.ctx, candidates: after.candidates, preset: 'composite' });
    expect(composite[0]?.hero.name).toBe('Malfurion');
  });

  it('scores bans as threats from the enemy perspective', () => {
    // Our team has Valla; it is our ban (step 10 is A-ban with first pick A).
    const s = at([null, null, null, null, id('Valla'), id('Muradin'), id('Diablo'), id('Malfurion'), id('Li-Ming'), null]);
    expect(s.ctx).toMatchObject({ team: 'A', action: 'ban' });
    const list = suggest({ data: theory, ctx: s.ctx, candidates: s.candidates, preset: 'counters' });
    const anub = list.find((x) => x.hero.name === "Anub'arak")!;
    expect(anub.raw).toBeGreaterThan(0);
    expect(list.indexOf(anub)).toBeLessThan(list.length / 2);
    // Ban weights: roles at half, no pool bonus.
    expect(banWeights('composite')).toMatchObject({ role: 0.5, pool: 0 });
    const prov = banProviders({ data: theory });
    const out = prov.flatMap((p) => {
      const r = p(anub.id, asOpponent(s.ctx));
      return r ? (Array.isArray(r) ? r : [r]) : [];
    }) as Signal[];
    expect(out.some((x) => x.reasons.some((r) => r.text.includes('Valla')))).toBe(true);
  });

  it('phrases enemy-perspective stat reasons as threats to your picks', () => {
    const s = at([null, null, null, null, id('Muradin')]);
    expect(s.ctx).toMatchObject({ team: 'B', action: 'pick' });
    const list = suggest({ data: stats, ctx: s.ctx, candidates: s.candidates, preset: 'composite' });
    const texts = list.flatMap((x) => x.signals.flatMap((sig) => sig.reasons.map((r) => r.text)));
    expect(texts.some((t) => /your Muradin/.test(t))).toBe(true);
    expect(usesStats(list)).toBe(true);
  });

  it('breaks a score down per signal with the mode weights', () => {
    const { ctx: c, candidates } = at([null, null, null, null, id('Muradin')]);
    const [top] = suggest({ data: stats, ctx: c, candidates, preset: 'composite' });
    const rows = breakdown(top!, WEIGHT_PRESETS.composite);
    const sum = rows.reduce((s, r) => s + r.contribution, 0);
    expect(sum).toBeCloseTo(top!.raw, 9);
    for (const r of top!.reasons) expect(['Stat', 'Theory', 'Role', 'Pool', 'Map']).toContain(reasonLabel(r, top!.keyOf.get(r)));
  });
});

describe('presets', () => {
  it('disables stats-only modes without stats and hides Community without votes', () => {
    const list = presetInfo({ stats: false, map: '' });
    expect(list.find((p) => p.id === 'winrate')).toMatchObject({ enabled: false });
    expect(list.find((p) => p.id === 'tier')?.why).toBe('stats');
    expect(list.find((p) => p.id === 'map')).toMatchObject({ enabled: false, why: 'map' });
    expect(disabledNote(list)).toBe('Win rate and Tier need match statistics, which are not available right now. Choose a map to sort by map fit.');
    expect(disabledNote(presetInfo({ stats: true, map: 'x' }))).toBe('');
    expect(list.find((p) => p.id === 'community')?.visible).toBe(false);
    const full = presetInfo({ stats: true, map: 'cursed-hollow' });
    expect(full.filter((p) => p.visible && p.enabled).map((p) => p.id)).toEqual(['composite', 'winrate', 'counters', 'synergy', 'map', 'tier']);
  });

  it('sort modes reorder the same candidates', () => {
    const rules = entityRules(theory.heroes);
    const state = replaySequential(slConfig('a', rules), [null, null, null, null, id('Muradin'), id('Valla')]).state;
    const c = sequentialContext(state, { map: 'dragon-shire' })!;
    const candidates = legalCandidates(state, ALL);
    const byMap = suggest({ data: stats, ctx: c, candidates, preset: 'map' }).map((x) => x.id);
    const byWr = suggest({ data: stats, ctx: c, candidates, preset: 'winrate' }).map((x) => x.id);
    expect(new Set(byMap)).toEqual(new Set(byWr));
    expect(byMap).not.toEqual(byWr);
  });
});
