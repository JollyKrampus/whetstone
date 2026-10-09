import { describe, expect, it } from 'vitest';
import { asOpponent } from '../../../core/draft.ts';
import { HP_SOURCE, availableHeroes, banProviders, hardCounter, pickProviders } from './providers.ts';
import { ctxOf as ctx, idOf, signalsOf as signals, statsData, theoryData } from './testkit.ts';

const theory = theoryData();
const stats = statsData();
const id = (name: string) => idOf(theory, name);

describe('theory providers', () => {
  const providers = pickProviders({ data: theory });

  it('labels counters as theory, with the edge reason', () => {
    // Anub'arak counters Valla in theory (channel interrupt).
    const s = signals(providers, id("Anub'arak"), ctx({ enemies: [id('Valla')] })).filter((x) => x.key === 'counters');
    const vs = s.find((x) => x.reasons.some((r) => r.text.includes('Valla has channelled abilities')));
    expect(vs?.value).toBeGreaterThan(0);
    expect(vs?.reasons[0]?.kind).toBe('theory');
    expect(vs?.reasons[0]?.source).toBeUndefined();
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

  it('ignores an unknown map', () => {
    const s = signals(providers, id('Abathur'), ctx({ map: 'no-such-map' }));
    expect(s.some((x) => x.key === 'map')).toBe(false);
  });

  it('has no win-rate or tier signals without statistics', () => {
    const s = signals(providers, id('Muradin'), ctx({}));
    expect(s.some((x) => x.key === 'winrate' || x.key === 'tier')).toBe(false);
  });

  it('rewards favourites only for your own picks', () => {
    const fav = pickProviders({ data: theory, favorites: new Set(['muradin']) });
    expect(signals(fav, id('Muradin'), ctx({})).some((x) => x.key === 'pool')).toBe(true);
    expect(signals(fav, id('Muradin'), ctx({ team: 'B' })).some((x) => x.key === 'pool')).toBe(false);
    expect(signals(fav, id('Muradin'), ctx({ action: 'ban' })).some((x) => x.key === 'pool')).toBe(false);
  });

  it('matches favourites by member id for composites', () => {
    const fav = pickProviders({ data: theory, favorites: new Set(['CCho']) });
    expect(signals(fav, 'chogall', ctx({})).some((x) => x.key === 'pool')).toBe(true);
  });
});

describe('blind-pick safety', () => {
  const providers = pickProviders({ data: theory });

  it('counts hard counters still available to the other side', () => {
    const valla = theory.byId.get(id('Valla'))!;
    const counters = availableHeroes(theory, ctx({})).filter((h) => hardCounter(theory, false, h, valla));
    expect(counters.length).toBeGreaterThan(0);
    const open = signals(providers, valla.id, ctx({})).find((x) => x.reasons[0]?.text.includes('can still pick counter it'));
    expect(open?.value).toBeLessThan(0);
    expect(open?.reasons[0]?.kind).toBe('theory');
    // Ban every counter: Valla becomes a safe blind pick.
    const safe = signals(providers, valla.id, ctx({ bans: counters.map((h) => h.id) })).find((x) => x.reasons[0]?.text.startsWith('Safe blind pick'));
    expect(safe?.value).toBeGreaterThan(0);
  });

  it('fades out as the other side runs out of picks, and is off for ARAM', () => {
    const early = signals(providers, id('Valla'), ctx({ enemyPicksLeft: 5 })).find((x) => x.reasons[0]?.text.includes('can still pick'));
    const late = signals(providers, id('Valla'), ctx({ enemyPicksLeft: 1 })).find((x) => x.reasons[0]?.text.includes('can still pick'));
    expect(Math.abs(late!.value)).toBeLessThan(Math.abs(early!.value));
    expect(signals(providers, id('Valla'), ctx({ enemyPicksLeft: 0 })).some((x) => x.reasons[0]?.text.includes('can still pick'))).toBe(false);
    const aram = pickProviders({ data: theory, blindSafety: false });
    expect(signals(aram, id('Valla'), ctx({})).some((x) => x.reasons[0]?.text.includes('can still pick'))).toBe(false);
  });
});

describe('stats providers', () => {
  const providers = pickProviders({ data: stats });

  it('uses statistics for win rate, tier, counters and map, with n and source', () => {
    const c = ctx({ enemies: [id('Muradin')], allies: [id('Malfurion')], map: 'cursed-hollow' });
    const s = signals(providers, id('Valla'), c);
    const wr = s.find((x) => x.key === 'winrate')!;
    expect(wr.reasons[0]).toMatchObject({ kind: 'stat', source: HP_SOURCE });
    expect(wr.reasons[0]?.n).toBeGreaterThanOrEqual(15);
    const counter = s.find((x) => x.key === 'counters' && x.reasons[0]?.kind === 'stat');
    expect(counter?.reasons[0]?.text).toMatch(/(Beats|Struggles against) their Muradin/);
    expect(counter?.reasons[0]?.delta).toBeDefined();
    expect(s.some((x) => x.key === 'map' && x.reasons[0]?.kind === 'stat')).toBe(true);
  });

  it('keeps theory as its own lower-weighted signal when stats cover the pair', () => {
    const s = signals(providers, id("Anub'arak"), ctx({ enemies: [id('Valla')] }));
    expect(s.some((x) => x.key === 'theory' && x.reasons[0]?.kind === 'theory')).toBe(true);
  });

  it('hides early-data tiers but keeps the win rate', () => {
    // Abathur has 195 games: no tier (early data) in the fixture.
    const s = signals(providers, id('Abathur'), ctx({}));
    expect(s.some((x) => x.key === 'tier')).toBe(false);
    expect(s.some((x) => x.key === 'winrate')).toBe(true);
  });

  it('can be switched off (ARAM page with Storm League stats)', () => {
    const off = pickProviders({ data: stats, useStats: false });
    expect(signals(off, id('Valla'), ctx({})).some((x) => x.key === 'winrate')).toBe(false);
  });
});

describe('ban providers', () => {
  it('score a ban as the opponent pick and name what it threatens', () => {
    const prov = banProviders({ data: theory });
    // We have Valla; Anub'arak counters her, so banning him protects our pick.
    const c = asOpponent(ctx({ action: 'ban', allies: [id('Valla')] }));
    const out = signals(prov, id("Anub'arak"), c);
    const vs = out.find((x) => x.key === 'counters' && x.value > 0 && x.reasons.some((r) => r.text.includes('Valla')));
    expect(vs).toBeDefined();
  });

  it('count how many of your remaining options a hero counters, restricted to your pool', () => {
    const c = asOpponent(ctx({ action: 'ban' }));
    const all = signals(banProviders({ data: theory }), id("Anub'arak"), c).find((x) => x.reasons[0]?.text.startsWith('Counters '));
    expect(all?.reasons[0]?.text).toMatch(/you can still pick/);
    expect(all?.value).toBeGreaterThan(0);
    // Your pool holds only heroes Anub'arak does not counter: nothing to protect.
    const pool = new Set([id('Muradin')]);
    const mine = signals(banProviders({ data: theory, ourPool: pool }), id("Anub'arak"), c).find((x) => x.reasons[0]?.text.startsWith('Counters '));
    expect(mine).toBeUndefined();
  });

  it('carry only role penalties over to bans', () => {
    // The enemy already has a main tank: another main tank is less of a threat; filling a need is not a bonus.
    const c = asOpponent(ctx({ action: 'ban', enemies: [id('Muradin')] }));
    const roles = signals(banProviders({ data: theory }), id('Diablo'), c).filter((x) => x.key === 'role');
    expect(roles.length).toBeGreaterThan(0);
    for (const r of roles) expect(r.value).toBeLessThan(0);
    expect(roles[0]!.reasons[0]!.text).toContain('Second tank next to their Muradin');
  });
});
