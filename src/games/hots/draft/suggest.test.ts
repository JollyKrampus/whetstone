import { describe, expect, it } from 'vitest';
import {
  WEIGHT_PRESETS,
  asOpponent,
  chooseSequential,
  legalCandidates,
  picksOf,
  replaySequential,
  sequentialContext,
  startSequential,
  type ScoredSignal,
} from '../../../core/draft.ts';
import { decodeShard, type DraftData } from './data.ts';
import { banProviders, type DraftReason } from './providers.ts';
import { teamRoles } from './roles.ts';
import { entityRules, slConfig } from './rules.ts';
import {
  banWeights,
  breakdown,
  compareSuggestions,
  conditionsText,
  disabledNote,
  isFlatTop,
  pickReasons,
  presetInfo,
  reasonLabel,
  sourcesUsed,
  suggest,
  usesStats,
  type Suggestion,
} from './suggest.ts';
import { syntheticShard } from './synthetic.ts';
import { idOf, signalsOf, statsData, theoryData } from './testkit.ts';

const theory = theoryData();
const stats = statsData();
const id = (name: string) => idOf(theory, name);
const ALL = theory.heroes.map((h) => h.id);

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
    const out = signalsOf(banProviders({ data: theory }), anub.id, asOpponent(s.ctx));
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

  it('never shows two lines of one edge, a repeated rule template or a breakdown-only line', () => {
    for (const choices of [
      [null, null, null, null, id('Muradin')],
      [null, null, null, null, id('Valla'), id('Li-Ming'), id('Tracer')],
      [null, null, null, null, id('Malfurion'), id('Valla'), id('Li-Ming'), id("Anub'arak"), id('Diablo'), null, null, id('Tracer')],
    ]) {
      const { ctx: c, candidates } = at(choices);
      for (const s of suggest({ data: theory, ctx: c, candidates, preset: 'composite' })) {
        const keys = s.reasons.map((r) => (r as DraftReason).dedupeKey ?? r.text);
        expect(new Set(keys).size, s.hero.name).toBe(keys.length);
        for (const r of s.reasons) expect((r as DraftReason).detail).toBeUndefined();
        // Each shown theory line belongs to a different signal (edge).
        const owners = s.reasons.map((r) => s.signals.findIndex((sig) => sig.reasons.includes(r)));
        expect(new Set(owners).size).toBe(owners.length);
      }
    }
  });

  it('picks reasons by contribution, skipping details and repeats of a template', () => {
    const sig = (contribution: number, reasons: DraftReason[]): ScoredSignal => ({ key: 'counters', value: contribution, weight: 1, contribution, reasons });
    const out = pickReasons([
      sig(0.9, [{ kind: 'theory', text: 'A beats X', dedupeKey: 'theory:{a} beats {b}' }, { kind: 'theory', text: 'paraphrase', detail: true }]),
      sig(0.8, [{ kind: 'theory', text: 'A beats Y', dedupeKey: 'theory:{a} beats {b}' }]),
      sig(0.5, [{ kind: 'stat', text: 'small', detail: true }]),
      sig(0.4, [{ kind: 'theory', text: 'A pairs with Z' }]),
      sig(-0.3, [{ kind: 'role', text: 'Second tank' }]),
    ]);
    expect(out.reasons.map((r) => r.text)).toEqual(['A beats X', 'A pairs with Z']);
    expect(out.warning?.text).toBe('Second tank');
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

describe('order and flat lists', () => {
  const fake = (name: string, raw: number, tiebreak = 0): Suggestion =>
    ({
      id: name.slice(0, 4),
      raw,
      score: Math.round(50 + 50 * Math.tanh(raw)),
      signals: [{ key: 'counters', value: raw, weight: 1, contribution: raw, reasons: [], tiebreak }],
      byKey: {},
      reasons: [],
      hero: { name },
      keyOf: new Map(),
    }) as unknown as Suggestion;

  it('orders exact ties by the tie-break, then by display name, never by id', () => {
    const list = [fake('Zeratul', 0.3), fake('Abathur', 0.3), fake('Malthael', 0.3, 5), fake('Cassia', 0.4)];
    // Ids would put Abathur ("Abat") before Cassia ("Cass") by raw tie only; names and the tie-break decide here.
    expect([...list].sort(compareSuggestions).map((s) => s.hero.name)).toEqual(['Cassia', 'Malthael', 'Abathur', 'Zeratul']);
  });

  it('knows a flat top when the shown scores sit within two points', () => {
    expect(isFlatTop([fake('A', 0.3), fake('B', 0.29), fake('C', 0.28)], 6)).toBe(true);
    expect(isFlatTop([fake('A', 0.6), fake('B', 0.3), fake('C', 0.28)], 6)).toBe(false);
    expect(isFlatTop([fake('A', 0.3), fake('B', 0.3)], 6)).toBe(false);
  });

  it('opens with a ranked ban list, not ties in id order', () => {
    const list = suggest({ data: theory, ctx: sequentialContext(startSequential(slConfig('a', entityRules(theory.heroes))))!, candidates: ALL, preset: 'composite' });
    const sorted = [...list].sort(compareSuggestions);
    expect(list.map((s) => s.id)).toEqual(sorted.map((s) => s.id));
    // Johanna counters more of the cast than Valla, so she is the bigger blind-ban threat.
    expect(list.findIndex((s) => s.hero.name === 'Johanna')).toBeLessThan(list.findIndex((s) => s.hero.name === 'Valla'));
  });

  it('renders conditions as one sentence run and names the sources in use', () => {
    expect(conditionsText({ kind: 'theory', text: 'x', conditions: ['Anduin takes Lightbomb.', 'Prolific Dispersal at level 4'] })).toBe(
      'Anduin takes Lightbomb. Prolific Dispersal at level 4.',
    );
    expect(conditionsText({ kind: 'theory', text: 'x' })).toBeNull();
    expect(conditionsText({ kind: 'theory', text: 'x', conditions: ['Anduin takes Lightbomb', ' Anduin takes Lightbomb.', ''] })).toBe('Anduin takes Lightbomb.');
    const pro = { source: 'liquipedia', label: 'w', maps: 50, bans: { [id('Valla')]: 20 } };
    const list = suggest({ data: theory, ctx: sequentialContext(startSequential(slConfig('a', entityRules(theory.heroes))))!, candidates: ALL, preset: 'composite', pro });
    expect(sourcesUsed(list)).toContain('liquipedia');
    expect(sourcesUsed(suggest({ data: theory, ctx: sequentialContext(startSequential(slConfig('a', entityRules(theory.heroes))))!, candidates: ALL, preset: 'composite' }))).toEqual([]);
  });
});

describe('regression: strong edges never bury the role guardrails', () => {
  /** Seeded Storm League drafts: team A always takes the #1 composite suggestion, team B picks at random. */
  function run(data: DraftData, seed: number) {
    let x = seed;
    const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
    const ids = data.heroes.map((h) => h.id);
    let state = startSequential(slConfig(rnd() < 0.5 ? 'a' : 'b', entityRules(data.heroes)));
    const map = rnd() < 0.5 ? 'map-one' : undefined;
    let lastSaturated = false;
    while (!state.complete) {
      const c = sequentialContext(state, map ? { map } : {})!;
      const legal = legalCandidates(state, ids);
      let choice: string;
      if (c.team === 'A' && c.action === 'pick') {
        const list = suggest({ data, ctx: c, candidates: legal, preset: 'composite' });
        if (c.picksLeft === 1) lastSaturated = list.slice(0, 6).every((s) => s.score >= 95);
        choice = list[0]!.id;
      } else choice = legal[Math.floor(rnd() * legal.length)]!;
      const r = chooseSequential(state, choice);
      if (!r.ok) throw new Error(r.message);
      state = r.state;
    }
    return { roles: teamRoles(picksOf(state, 'A').map((h) => data.byId.get(h)!)), lastSaturated };
  }

  it('ends with two Healers in at most 5% of drafts, always with a Healer, and a readable last-pick list', () => {
    // Healers get +10 on every synergy: the case where summed edges used to stack a second Healer.
    const shards = [1, 2, 3, 4].map((seed) => decodeShard(syntheticShard({ seed, healerSynergyBonus: 10 })));
    const N = 40;
    const results = Array.from({ length: N }, (_, i) => run(shards[i % shards.length]!, 1000 + i));
    const double = results.filter((r) => r.roles.healers >= 2).length;
    expect(double / N).toBeLessThanOrEqual(0.05);
    expect(results.every((r) => r.roles.healers + r.roles.substitutes.length >= 1)).toBe(true);
    expect(results.every((r) => r.roles.frontline >= 1)).toBe(true);
    expect(results.filter((r) => r.lastSaturated).length / N).toBeLessThanOrEqual(0.1);
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
