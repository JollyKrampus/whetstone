import { describe, expect, it } from 'vitest';
import { asOpponent, type Signal } from '../../../core/draft.ts';
import { isListable } from '../../../core/stats.ts';
import { statPair } from './data.ts';
import {
  BREADTH_MAX,
  KEY_CAP,
  availableHeroes,
  banProviders,
  counterStrength,
  hardCounter,
  pickProviders,
  softCap,
  templateKey,
  type DraftReason,
  type DraftSignal,
  type ProPrior,
} from './providers.ts';
import { ctxOf as ctx, idOf, signalsOf as signals, statsData, theoryData } from './testkit.ts';

const theory = theoryData();
const stats = statsData();
const id = (name: string) => idOf(theory, name);
const STATS_SOURCE = stats.statsSource;

describe('theory providers', () => {
  const providers = pickProviders({ data: theory });

  it('labels counters as theory, with the edge reason', () => {
    // Anub'arak counters Tracer in theory (Spell Armor against her ability burst).
    const s = signals(providers, id("Anub'arak"), ctx({ enemies: [id('Tracer')] })).filter((x) => x.key === 'counters');
    const vs = s.find((x) => x.reasons.some((r) => r.text.includes('Spell Armor') && r.text.includes('Tracer')));
    expect(vs?.value).toBeGreaterThan(0);
    expect(vs?.reasons[0]?.kind).toBe('theory');
    expect(vs?.reasons[0]?.source).toBeUndefined();
  });

  it('subtracts reverse counters', () => {
    // Xal'atath's burst threatens Abathur's body; Abathur has no edge back.
    const s = signals(providers, id('Abathur'), ctx({ enemies: [id("Xal'atath")] }));
    const neg = s.find((x) => x.key === 'counters' && x.value < 0);
    expect(neg?.reasons[0]?.text).toContain("Abathur's small Health pool");
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

  it('shows one headline line per edge, with the rest (paraphrases, more rules) as breakdown detail', () => {
    // Anub'arak > Li-Ming carries a curated line and two rule lines.
    const s = signals(providers, id("Anub'arak"), ctx({ enemies: [id('Li-Ming')] })).find((x) => x.key === 'counters' && x.value > 0)!;
    const reasons = s.reasons as DraftReason[];
    expect(reasons.length).toBeGreaterThan(1);
    expect(reasons[0]!.detail).toBeUndefined();
    expect(reasons[0]!.text).toContain('Harden Carapace');
    for (const r of reasons.slice(1)) expect(r.detail).toBe(true);
    for (const r of reasons) expect(r.dedupeKey).toMatch(/^theory:/);
  });

  it('treats one rule matched through different abilities as the same reason', () => {
    const stun = (ev: string) => templateKey(`{a}'s stun (${ev}) holds targets still for {b}'s burst.`);
    expect(stun('Impale, Burrow Charge')).toBe(stun('Hammer of Justice'));
    expect(templateKey('{a} blinds {b}.')).not.toBe(templateKey('{a} roots {b}.'));
  });

  it('splits talent conditions off the line, to be shown as "Only when …"', () => {
    const s = signals(providers, id('Malfurion'), ctx({ enemies: [id('Li-Ming')] })).find((x) => x.key === 'counters' && x.value > 0)!;
    const channel = s.reasons.find((r) => r.text.includes('interrupt channels'))!;
    expect(channel.text).toBe('Malfurion can interrupt channels with silence (Twilight Dream, Astral Communion), and Li-Ming relies on channelled abilities.');
    expect(channel.conditions).toEqual(['Malfurion takes Twilight Dream or Astral Communion.', 'Li-Ming must also take Disintegrate.']);
    expect(s.reasons[0]!.conditions).toBeUndefined();
  });

  it('soft-caps a key so many edges cannot bury the role guardrails', () => {
    const enemies = ['Li-Ming', 'Tracer', 'Valla', "Xal'atath", 'Zeratul'].map(id);
    const s = signals(providers, id("Anub'arak"), ctx({ enemies })).filter((x) => x.key === 'counters');
    const raw = s.reduce((sum, x) => sum + x.value, 0);
    expect(Math.abs(raw)).toBeLessThan(KEY_CAP);
    // Every edge keeps its reason and sign.
    expect(s.length).toBeGreaterThan(2);
    const one = softCap([{ key: 'synergy', value: 2, reasons: [] }] as Signal[]);
    expect(one[0]!.value).toBeCloseTo(KEY_CAP * Math.tanh(2 / KEY_CAP), 10);
    const small = softCap([{ key: 'synergy', value: 0.05, reasons: [] }] as Signal[]);
    expect(small[0]!.value).toBeCloseTo(0.05, 3);
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
    expect(STATS_SOURCE).toBeTruthy();
    expect(wr.reasons[0]).toMatchObject({ kind: 'stat', source: STATS_SOURCE });
    expect(wr.reasons[0]?.n).toBeGreaterThanOrEqual(15);
    const counter = s.find((x) => x.key === 'counters' && x.reasons[0]?.kind === 'stat');
    expect(counter?.reasons[0]?.text).toMatch(/Muradin/);
    expect(counter?.reasons[0]?.delta).toBeDefined();
    expect(s.some((x) => x.key === 'map' && x.reasons[0]?.kind === 'stat')).toBe(true);
  });

  it('words a statistic as a verdict only when it passes the list bar (n ≥ 50, |Δ| ≥ 1.5 pp)', () => {
    const pairs = stats.heroes.flatMap((a) => stats.heroes.map((b) => ({ a, b, st: statPair(stats, 'counters', a.index, b.index) })));
    const listed = pairs.find((p) => p.st && isListable(p.st.n, p.st.delta) && p.st.delta > 0)!;
    const below = pairs.find((p) => p.st && !isListable(p.st.n, p.st.delta) && p.st.n >= 30)!;
    const reasonOf = (p: typeof listed) =>
      signals(providers, p.a.id, ctx({ enemies: [p.b.id] })).find((x) => x.key === 'counters' && x.reasons[0]?.kind === 'stat')!.reasons[0] as DraftReason;
    expect(reasonOf(listed).text).toBe(`Beats their ${listed.b.name}`);
    expect(reasonOf(listed).detail).toBeUndefined();
    const quiet = reasonOf(below);
    expect(quiet.text).toContain(`against their ${below.b.name}: too small to call`);
    expect(quiet.text).not.toMatch(/^(Beats|Struggles)/);
    expect(quiet.detail).toBe(true);
    // The value stays proportional to the effect.
    const sig = signals(providers, below.a.id, ctx({ enemies: [below.b.id] })).find((x) => x.key === 'counters' && x.reasons[0]?.kind === 'stat')!;
    expect(Math.sign(sig.value)).toBe(Math.sign(below.st!.delta));
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
    // We have Li-Ming; Anub'arak counters her (a curated matchup), so banning him protects our pick.
    const c = asOpponent(ctx({ action: 'ban', allies: [id('Li-Ming')] }));
    const out = signals(prov, id("Anub'arak"), c);
    const vs = out.find((x) => x.key === 'counters' && x.value > 0 && x.reasons.some((r) => r.text.includes('Li-Ming')));
    expect(vs).toBeDefined();
  });

  it('score breadth on a smooth scale: more and harder counters rank higher, with the uncapped sum as tie-break', () => {
    const c = asOpponent(ctx({ action: 'ban' }));
    const prov = banProviders({ data: theory });
    const breadthOf = (name: string) => signals(prov, id(name), c).find((x) => x.reasons[0]?.text.startsWith('Counters ')) as DraftSignal | undefined;
    const strength = (name: string) =>
      availableHeroes(theory, c)
        .filter((u) => u.id !== id(name))
        .reduce((sum, u) => sum + (counterStrength(theory, false, theory.byId.get(id(name))!, u)?.strength ?? 0), 0);
    // Johanna counters three heroes, Valla one: Johanna's breadth is larger, and neither is capped.
    const johanna = breadthOf('Johanna')!;
    const valla = breadthOf('Valla')!;
    expect(johanna.value).toBeGreaterThan(valla.value);
    expect(johanna.value).toBeLessThan(BREADTH_MAX);
    expect(johanna.tiebreak).toBeCloseTo(strength('Johanna'), 10);
    expect(johanna.reasons[0]!.text).toMatch(/^Counters 3 heroes you can still pick/);
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

describe('pro ban prior', () => {
  const pro: ProPrior = { source: 'liquipedia', label: 'Test window', maps: 100, bans: { [id('Valla')]: 40, [id('Muradin')]: 2 } };

  it('ranks often-banned heroes as bigger threats in theory mode, with its source', () => {
    const c = asOpponent(ctx({ action: 'ban' }));
    const prov = banProviders({ data: theory, pro });
    const of = (name: string) => signals(prov, id(name), c).find((x) => x.reasons[0]?.kind === 'pro');
    const valla = of('Valla')!;
    expect(valla.key).toBe('tier');
    expect(valla.value).toBeGreaterThan(of('Muradin')!.value);
    expect(valla.reasons[0]).toMatchObject({ kind: 'pro', source: 'liquipedia', n: 100, text: 'Banned in 40% of 100 pro maps' });
    // Shrunk toward the mean: a hero never banned is only a little below it.
    expect(of('Li-Ming')!.value).toBeLessThan(0);
    expect(of('Li-Ming')!.value).toBeGreaterThan(-0.5);
  });

  it('stays out of picks and of statistics mode, and says when the numbers are a sample', () => {
    expect(signals(pickProviders({ data: theory, pro }), id('Valla'), ctx({})).some((x) => x.reasons[0]?.kind === 'pro')).toBe(false);
    const c = asOpponent(ctx({ action: 'ban' }));
    expect(signals(banProviders({ data: stats, pro }), id('Valla'), c).some((x) => x.reasons[0]?.kind === 'pro')).toBe(false);
    const sample = signals(banProviders({ data: theory, pro: { ...pro, synthetic: true } }), id('Valla'), c).find((x) => x.reasons[0]?.kind === 'pro');
    expect(sample?.reasons[0]?.text).toBe('Banned in 40% of 100 pro maps (sample data)');
  });
});
