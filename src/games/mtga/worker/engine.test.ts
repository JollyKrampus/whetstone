import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { repoRoot } from '../../../lib/datadir.ts';
import { Engine, EngineError, arenaName, autoFormat, toArenaText, type ShardData } from './engine.ts';
import { FORMAT_IDS, type LegalityView, type Pool } from './protocol.ts';

const FIXTURES = path.join(repoRoot(), 'fixtures', 'mtga', 'public');
const shard = (pool: Pool): ShardData => JSON.parse(fs.readFileSync(path.join(FIXTURES, `_cards.${pool}.json`), 'utf8')) as ShardData;

const BOROS = `About
Name Boros Test

Deck
4 Emberheart Challenger
4 Slickshot Show-Off
4 Voice of Victory
4 Inti, Seneschal of the Sun
4 Razorkin Needlehead
4 Hired Claw
2 Sunspine Lynx
4 Burst Lightning
4 Lightning Strike
4 Shock
2 Stroke of Midnight
4 Sacred Foundry
4 Inspiring Vantage
2 Sunbillow Verge
2 Elegant Parlor
6 Mountain
2 Plains

Sideboard
3 Abrade
2 Boltwave`;

function engine(onLoad?: (p: Pool) => void) {
  const load = vi.fn(async (p: Pool) => {
    onLoad?.(p);
    return shard(p);
  });
  return { e: new Engine(load), load };
}

describe('Engine pools', () => {
  it('starts with the Standard shard and loads Arena only when a card needs it', async () => {
    const { e, load } = engine();
    const init = await e.init();
    expect(init.pool).toBe('standard');
    expect(load).toHaveBeenCalledTimes(1);

    await e.analyze({ text: BOROS, format: null, meta: null });
    expect(load).toHaveBeenCalledTimes(1);
    expect(e.currentPool).toBe('standard');

    // Thoughtseize is not in the Standard pool: the Arena shard is fetched once.
    const r = await e.analyze({ text: `${BOROS.replace('2 Boltwave', '2 Boltwave\n1 Thoughtseize')}`, format: null, meta: null });
    expect(load.mock.calls.map((c) => c[0])).toEqual(['standard', 'arena']);
    expect(r.pool).toBe('arena');
    expect(r.issues).toEqual([]);
    await e.analyze({ text: BOROS, format: 'historic', meta: null });
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight load between concurrent requests', async () => {
    const { e, load } = engine();
    await Promise.all([e.init(), e.init(), e.search({ query: 'shock', format: 'standard', order: 'name', limit: 5 })]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('Engine.analyze', () => {
  it('reports legality in every Arena format and picks the narrowest legal one', async () => {
    const { e } = engine();
    const r = await e.analyze({ text: BOROS, format: null, meta: null });
    expect(r.name).toBe('Boros Test');
    expect(r.counts).toEqual({ main: 60, side: 5 });
    expect(r.legality.map((l) => l.format)).toEqual([...FORMAT_IDS]);
    expect(r.legality.find((l) => l.format === 'standard')?.legal).toBe(true);
    expect(r.legality.find((l) => l.format === 'brawl')?.legal).toBe(false);
    expect(r.format).toBe('standard');
    expect(r.autoFormat).toBe(true);
    expect(r.analysis.curve['1']).toBeGreaterThan(0);
    expect(r.analysis.landCount).toBe(20);
    expect(r.power.tier).toBeGreaterThanOrEqual(1);
    expect(r.power.dimensions.map((d) => d.name)).toContain('Card quality');
    expect(r.power.lowConfidence).toBe(true);
    expect(r.wildcards.byRarity.rare).toBeGreaterThan(0);
    expect(r.simulation.iterations).toBe(10_000);
    expect(Object.keys(r.cards)).toHaveLength(19);
    expect(r.cards[r.main[0]!.oracleId]?.name).toBe('Emberheart Challenger');
  });

  it('is deterministic for the same input', async () => {
    const a = await engine().e.analyze({ text: BOROS, format: 'standard', meta: null });
    const b = await engine().e.analyze({ text: BOROS, format: 'standard', meta: null });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('keeps unknown lines as issues with suggestions instead of failing', async () => {
    const { e } = engine();
    const r = await e.analyze({ text: `${BOROS}\n1 Lightnig Strike`, format: 'standard', meta: null });
    const issue = r.issues.find((i) => i.code === 'unknown_card');
    expect(issue?.suggestions).toContain('Lightning Strike');
  });

  it('flags banned cards for Standard', async () => {
    const { e } = engine();
    const r = await e.analyze({ text: BOROS.replace('2 Stroke of Midnight', '2 Heartfire Hero'), format: 'standard', meta: null });
    const std = r.legality.find((l) => l.format === 'standard')!;
    expect(std.legal).toBe(false);
    expect(std.issues.some((i) => /banned/i.test(i.message))).toBe(true);
    expect(r.format).toBe('standard');
  });

  it('uses meta lists for card quality and the closest archetype', async () => {
    const { e } = engine();
    const meta = { label: 'Test lists', lists: [{ name: 'Boros', archetype: 'Boros Aggro', list: BOROS, metaShare: 0.2 }] };
    const r = await e.analyze({ text: BOROS, format: 'standard', meta });
    expect(r.power.lowConfidence).toBe(false);
    expect(r.meta?.closest?.archetype).toBe('Boros Aggro');
    expect(r.meta?.closest?.overlapPercent).toBe(100);
  });

  it('rejects an empty paste with a readable error', async () => {
    const { e } = engine();
    await expect(e.analyze({ text: 'Deck\n', format: null, meta: null })).rejects.toBeInstanceOf(EngineError);
    await expect(e.analyze({ text: '4 Not A Real Card', format: null, meta: null })).rejects.toThrow(/None of the lines/);
  });
});

describe('Engine tools', () => {
  it('deals the same sample hand for the same seed', async () => {
    const { e } = engine();
    const a = await e.hand({ text: BOROS, seed: 42 });
    const b = await e.hand({ text: BOROS, seed: 42 });
    expect(a).toEqual(b);
    expect(a.hand).toHaveLength(7);
    expect(a.nextDraws).toHaveLength(3);
    for (const n of [...a.hand, ...a.nextDraws]) expect(a.ids[n]).toMatch(/^[0-9a-f-]{36}$/);
    const c = await e.hand({ text: BOROS, seed: 43 });
    expect(c.hand).not.toEqual(a.hand);
  });

  it('simulates with clamped options and honours seeds', async () => {
    const { e } = engine();
    const opts = { iterations: 2000, seed: 7, playDraw: 'draw' as const, bo1Smoothing: true, checks: [{ role: 'removal' as const, byTurn: 3 }] };
    const a = await e.simulate({ text: BOROS, options: opts });
    const b = await e.simulate({ text: BOROS, options: opts });
    expect(a).toEqual(b);
    expect(a.iterations).toBe(2000);
    expect(a.playDraw).toBe('draw');
    expect(a.checks[0]?.probability).toBeGreaterThan(0.5);
    const clamped = await e.simulate({ text: BOROS, options: { ...opts, iterations: 5, checks: [{ byTurn: 3 }] } });
    expect(clamped.iterations).toBe(100);
    expect(clamped.checks).toEqual([]);
  });

  it('suggests upgrades within the budget and pre-applies them', async () => {
    const { e } = engine();
    const s = await e.suggest({
      text: BOROS,
      format: 'standard',
      profile: 'casual',
      preferPremium: false,
      intensity: 'heavy',
      wildcards: { mythic: 0 },
      keepCards: ['Shock'],
      maxSwaps: 5,
      meta: null,
    });
    expect(s).toMatchObject({ profile: 'casual', preferPremium: false, estimateOnly: true });
    expect(s.totalCost.mythic).toBe(0);
    expect(s.swaps.every((w) => w.cut !== 'Shock')).toBe(true);
    for (const w of s.swaps) {
      expect(s.appliedText).toContain(w.add.split(' // ')[0]);
      expect(s.cards[w.addOracleId]?.name).toBe(w.add);
      expect(s.cards[w.cutOracleId]?.name).toBe(w.cut);
      expect(['spell', 'land']).toContain(w.kind);
    }
    expect(s.appliedText.startsWith('About\nName Boros Test')).toBe(true);
  });

  it('applies only the chosen swaps', async () => {
    const { e } = engine();
    const s = await e.suggest({ text: BOROS, format: 'standard', profile: 'competitive', preferPremium: false, intensity: 'any', wildcards: null, keepCards: [], maxSwaps: 5, meta: null });
    const first = s.swaps[0];
    if (!first) return; // nothing to apply with this tiny pool
    const r = await e.apply({ text: BOROS, swaps: [first] });
    expect(r.text).toContain(first.add.split(' // ')[0]);
    for (const w of s.swaps.slice(1)) if (!BOROS.includes(w.add)) expect(r.text).not.toContain(w.add);
    // Bad swaps are ignored rather than corrupting the list.
    const deck = await e.resolve(BOROS);
    const shock = deck.main.find((x) => x.name === 'Shock')!.oracleId;
    const strike = deck.main.find((x) => x.name === 'Lightning Strike')!.oracleId;
    const unchanged = toArenaText(deck);
    for (const bad of [
      { cut: 'Shock', add: 'Shock', qty: 2, cutOracleId: shock, addOracleId: shock },
      { cut: 'Shock', add: 'Lightning Strike', qty: 99, cutOracleId: shock, addOracleId: strike },
      { cut: 'Shock', add: 'Lightning Strike', qty: 4, cutOracleId: 'not-in-deck', addOracleId: strike },
      { cut: 'Shock', add: '?', qty: 1, cutOracleId: shock, addOracleId: 'unknown' },
    ]) {
      expect((await e.apply({ text: BOROS, swaps: [bad] })).text).toBe(unchanged);
    }
  });

  it('reports the rubric tier scale with the power rating', async () => {
    const { e } = engine();
    const r = await e.analyze({ text: BOROS, format: null, meta: null });
    expect(r.power.scale.map((t) => t.tier)).toEqual([1, 2, 3, 4, 5]);
    expect(r.power.scale.find((t) => t.tier === r.power.tier)?.label).toBe(r.power.label);
    expect(r.power.lowConfidence).toBe(true);
  });

  it('searches with Scryfall syntax and reports query errors', async () => {
    const { e } = engine();
    const r = await e.search({ query: 't:creature c:r mv<=1', format: 'standard', order: 'name', limit: 50 });
    expect(r.total).toBeGreaterThan(0);
    expect(r.cards.every((c) => c.cmc <= 1 && /Creature/.test(c.typeLine))).toBe(true);
    expect(r.pool).toBe('standard');
    const all = await e.search({ query: 'lightning', format: null, order: 'name', limit: 50 });
    expect(all.pool).toBe('arena');
    expect(all.cards.map((c) => c.name)).toContain('Lightning Bolt');
    const bad = await e.search({ query: 'zz:nope', format: null, order: 'name', limit: 5 });
    expect(bad.error).toMatch(/unsupported search key/);
    expect((await e.search({ query: '  ', format: null, order: 'name', limit: 5 })).total).toBe(0);
  });

  it('checks user meta lists for counts, legality and unknown names', async () => {
    const { e } = engine();
    const [ok, bad] = await e.checkLists({
      lists: [
        { list: BOROS, format: 'standard' },
        { list: 'Deck\n4 Shock\n4 Shokc', format: 'standard' },
      ],
    });
    expect(ok).toMatchObject({ main: 60, side: 5, legal: true, problem: null, colors: ['W', 'R'] });
    expect(bad?.legal).toBe(false);
    expect(bad?.issues[0]?.code).toBe('unknown_card');
  });
});

describe('export helpers', () => {
  it('round-trips a deck through the canonical Arena export', async () => {
    const { e } = engine();
    const r = await e.analyze({ text: BOROS, format: 'standard', meta: null });
    const again = await e.analyze({ text: r.arenaText, format: 'standard', meta: null });
    expect(again.arenaText).toBe(r.arenaText);
    expect(again.counts).toEqual(r.counts);
    expect(r.arenaText).toMatch(/^About\nName Boros Test\n\nDeck\n4 Emberheart Challenger/);
    expect(r.arenaText).toMatch(/\n\nSideboard\n3 Abrade\n2 Boltwave$/);
  });

  it('names double-faced and adventure cards by their front face', () => {
    const face = (name: string) => ({ name, manaCost: '', typeLine: '', oracleText: '' });
    expect(arenaName({ name: 'A // B', layout: 'adventure', faces: [face('A'), face('B')] })).toBe('A');
    expect(arenaName({ name: 'Fire // Ice', layout: 'split', faces: [face('Fire'), face('Ice')] })).toBe('Fire // Ice');
  });

  it('applies swaps by oracle id and drops cards that reach zero copies', async () => {
    const { e } = engine();
    await e.init('arena');
    const text = 'Deck\n2 Shock\n2 Lightning Strike\n4 Mountain';
    const deck = await e.resolve(text);
    const id = (name: string) => deck.main.find((x) => x.name === name)!.oracleId;
    const out = await e.apply({ text, swaps: [{ cut: 'Shock', add: 'Lightning Strike', qty: 2, cutOracleId: id('Shock'), addOracleId: id('Lightning Strike') }] });
    expect(out.text).toBe('Deck\n4 Lightning Strike\n4 Mountain');
  });

  it('flags feel-bad cards, checks the companion and carries paper prices', async () => {
    const { e } = engine();
    const r = await e.analyze({ text: `Companion\n1 Sheoldred, the Apocalypse\n\n${BOROS}\n1 Thoughtseize`, format: null, meta: null });
    const seize = r.feelBad.find((f) => f.name === 'Thoughtseize');
    expect(seize?.penalize).toContain('hand attack');
    expect(r.feelBad.every((f) => f.avoid.length + f.penalize.length > 0)).toBe(true);
    // Sheoldred is no companion: grindstone knows no condition for it.
    expect(r.companionCheck).toMatchObject({ name: 'Sheoldred, the Apocalypse', condition: null, breaking: [] });
    const priced = Object.values(r.cards).filter((c) => c.priceUsd !== undefined);
    expect(priced.length).toBeGreaterThan(0);
    for (const c of priced) expect(c.priceUsd).toBeGreaterThan(0);
  });

  it('auto-detects Brawl decks by their commander and otherwise falls back to the fewest errors', () => {
    const lv = (format: LegalityView['format'], legal: boolean, errors: number): LegalityView => ({
      format,
      label: format,
      legal,
      mainCount: 60,
      sideCount: 0,
      issues: Array.from({ length: errors }, () => ({ severity: 'error' as const, code: 'x', message: 'x' })),
    });
    const deck = { main: [], side: [], unresolved: [] };
    expect(autoFormat(deck, [lv('standard', false, 3), lv('pioneer', false, 1), lv('historic', false, 1), lv('timeless', false, 2)])).toBe('pioneer');
    expect(autoFormat(deck, [lv('standard', false, 1), lv('pioneer', true, 0)])).toBe('pioneer');
    const withCommander = { ...deck, commander: { qty: 1, name: 'x', oracleId: 'x', card: {} as never } };
    expect(autoFormat(withCommander, [lv('standardbrawl', false, 2), lv('brawl', true, 0)])).toBe('brawl');
  });
});
