import { describe, expect, it } from 'vitest';
import { repoRoot } from '../../../lib/datadir.ts';
import { TheorySchema, type GameMap, type Hero, type HeroTag, type Mechanic, type Rule } from '../schema.ts';
import { loadCurated } from './curated.ts';
import { RULES_VERSION, applyCuratedTraits, buildTheory, conditionsText, heroProfile, matchSide, mergeMechanics, onlyWhen, orList, renderTemplate, ruleSum, tagLabel, theoryRulesVersion } from './engine.ts';
import { extractMechanics } from './extract.ts';
import type { CuratedBundle, MergedPair } from './types.ts';
import { CONFIDENCE_WEIGHT, OPTIONAL_FACTOR, RULE_CAP, negligible, theoryScore } from './weights.ts';
import { fixtureHeroInputs } from './__fixtures__/kits.ts';

// ---- builders --------------------------------------------------------------------------

const ICON = 'img/icons/x.webp';
const NO_TALENTS: Hero['talents'] = { '1': [], '4': [], '7': [], '10': [], '13': [], '16': [], '20': [] };

type Tagged = HeroTag | [HeroTag, 'talent' | 'heroic' | 'curated'];

/** A hero whose mechanics are given directly; tags come from a basic ability unless marked. */
function hero(id: string, name: string, tagList: Tagged[], extra: Partial<Hero> = {}): Hero {
  const mechanics: Mechanic[] = tagList.map((t) => {
    const [tag, from] = Array.isArray(t) ? t : [t, 'ability' as const];
    const evidence =
      from === 'talent'
        ? { kind: 'talent' as const, name: `${name} ${tag} talent`, snippet: 'x' }
        : from === 'heroic'
          ? { kind: 'ability' as const, name: `${name} Heroic A`, snippet: 'x' }
          : from === 'curated'
            ? { kind: 'curated' as const, name: 'curated/hots/traits.yaml', snippet: 'x' }
            : { kind: 'ability' as const, name: `${name} ${tag}`, snippet: 'x' };
    return { tag, evidence: [evidence] };
  });
  const abilities: Hero['abilities'] = [
    ...tagList.filter((t) => !Array.isArray(t)).map((t, i) => ({ id: `${id}-q${i}`, name: `${name} ${t as string}`, hotkey: 'Q', kind: 'basic' as const, text: 'x', icon: ICON })),
    { id: `${id}-r1`, name: `${name} Heroic A`, hotkey: 'R', kind: 'heroic', text: 'x', icon: ICON },
    { id: `${id}-r2`, name: `${name} Heroic B`, hotkey: 'R', kind: 'heroic', text: 'x', icon: ICON },
  ];
  return {
    id,
    slug: name.toLowerCase(),
    name,
    title: name,
    role: 'Ranged Assassin',
    type: 'Ranged',
    franchise: 'Classic',
    difficulty: 'Easy',
    ratings: { damage: 5, utility: 5, survivability: 5, complexity: 5 },
    aliases: [],
    portrait: ICON,
    abilities,
    talents: NO_TALENTS,
    mechanics: mergeMechanics(mechanics),
    isNew: false,
    ...extra,
  };
}

function rule(id: string, a: string[], b: string[], weight: number, why = '{a} beats {b} with {aTag} ({evidence}).'): Rule {
  return { id, a, b, weight, why };
}

function bundle(over: Partial<Pick<CuratedBundle, 'counters' | 'synergies' | 'traits'>> & { counterRules?: Rule[]; synergyRules?: Rule[]; fit?: CuratedBundle['maps']['fit'] } = {}): CuratedBundle {
  return {
    rules: { version: 1, counters: over.counterRules ?? [], synergies: over.synergyRules ?? [] },
    maps: {
      version: 1,
      maps: {
        'big-map': { name: 'Big Map', kind: 'standard', size: 'large', lanes: 3, objective: 'x', tags: ['large', 'three-lane'] },
        'small-map': { name: 'Small Map', kind: 'aram', size: 'small', lanes: 1, objective: 'x', tags: ['single-lane'] },
      },
      fit: over.fit ?? [],
    },
    traits: over.traits ?? {},
    counters: over.counters ?? [],
    synergies: over.synergies ?? [],
    aliases: {},
    files: [],
    warnings: [],
  };
}

function curatedPair(a: string, b: string, weight = CONFIDENCE_WEIGHT.medium, why = ['A handwritten reason for the pair.']): MergedPair {
  return { a, b, why, whyConditions: why.map(() => []), evidence: ['Some Ability'], conditions: [], confidence: 'medium', weight, reviewedFor: '2.57', sources: ['heroes/x.yaml'] };
}

const MAPS: GameMap[] = [
  { id: 'big-map', name: 'Big Map', kind: 'standard', ranked: true, rankedSource: 'curated', image: 'img/maps/big.webp', profile: { size: 'large', lanes: 3, objective: 'x', tags: ['large', 'three-lane'] } },
  { id: 'small-map', name: 'Small Map', kind: 'aram', ranked: false, rankedSource: 'curated', image: 'img/maps/small.webp', profile: { size: 'small', lanes: 1, objective: 'x', tags: ['single-lane'] } },
];

const counterOf = (t: ReturnType<typeof buildTheory>, a: string, b: string) => t.counters.find((e) => e.a === a && e.b === b);

// ---- scoring -----------------------------------------------------------------------------

describe('theoryScore', () => {
  it('maps x through 50 + 50·tanh(x) with the documented calibration', () => {
    expect(theoryScore(0)).toBe(50);
    expect(theoryScore(0.2)).toBe(60);
    expect(theoryScore(0.3)).toBe(65);
    expect(theoryScore(0.35)).toBe(67);
    expect(theoryScore(0.4)).toBe(69);
    expect(theoryScore(RULE_CAP)).toBe(77);
    expect(theoryScore(-0.3)).toBe(35);
  });

  it('clamps x to ±2 (scores 2..98)', () => {
    expect(theoryScore(5)).toBe(98);
    expect(theoryScore(-5)).toBe(2);
  });
});

describe('renderTemplate', () => {
  it('fills placeholders and quotes at most two evidence names', () => {
    expect(renderTemplate('{a} vs {b}: {aTag}/{bTag} ({evidence}).', { a: 'A', b: 'B', aTag: 'blind', bTag: 'Basic Attack damage' }, ['One', 'Two', 'Three'])).toBe(
      'A vs B: blind/Basic Attack damage (One, Two).',
    );
  });

  it('drops " ({evidence})" when there is no evidence', () => {
    expect(renderTemplate('{a} can dive onto {b} ({evidence}), who is slow.', { a: 'A', b: 'B' }, [])).toBe('A can dive onto B, who is slow.');
  });

  it('labels tags for players', () => {
    expect(tagLabel('aa-reliant')).toBe('Basic Attack damage');
    expect(tagLabel('stun')).toBe('stun');
    expect(tagLabel('role:tank')).toBe('Tank frontline');
  });
});

describe('heroProfile', () => {
  const kit = (h: Hero) => ({ abilities: h.abilities, talentNames: new Set<string>() });

  it('gives talent-only and one-of-several-Heroics tags the optional factor', () => {
    const h = hero('Aaaa', 'Alpha', ['stun', ['blind', 'talent'], ['global', 'heroic'], ['dive', 'curated']]);
    const p = heroProfile(h, [kit(h)]);
    expect(p.atoms.get('stun')?.factor).toBe(1);
    expect(p.atoms.get('blind')?.factor).toBe(OPTIONAL_FACTOR);
    expect(p.atoms.get('global')?.factor).toBe(OPTIONAL_FACTOR);
    expect(p.atoms.get('dive')?.factor).toBe(1);
    expect(p.atoms.get('role:ranged-assassin')?.factor).toBe(1);
    expect(p.atoms.get('type:ranged')?.factor).toBe(1);
  });

  it('treats a tag every Heroic grants as always available', () => {
    const h = hero('Aaaa', 'Alpha', []);
    h.mechanics = [{ tag: 'global', evidence: [{ kind: 'ability', name: 'Alpha Heroic A', snippet: 'x' }, { kind: 'ability', name: 'Alpha Heroic B', snippet: 'x' }] }];
    expect(heroProfile(h, [kit(h)]).atoms.get('global')?.factor).toBe(1);
  });

  it('matches & expressions only when all parts match, with the weakest factor', () => {
    const h = hero('Aaaa', 'Alpha', ['burst', ['immobile', 'talent']]);
    const p = heroProfile(h, [kit(h)]);
    expect(matchSide(['burst&type:ranged'], p)).toMatchObject({ factor: 1, tag: 'burst' });
    expect(matchSide(['burst&immobile'], p)).toMatchObject({ factor: OPTIONAL_FACTOR });
    expect(matchSide(['burst&type:melee'], p)).toBeNull();
    expect(matchSide(['burst&immobile', 'burst'], p)?.factor).toBe(1);
  });
});

// ---- counters ----------------------------------------------------------------------------

describe('buildTheory counters', () => {
  const blind = rule('blind-vs-aa', ['blind'], ['aa-reliant'], 0.4);

  it('scores a single rule and renders its reason with evidence', () => {
    const t = buildTheory({ heroes: [hero('Aaaa', 'Alpha', ['blind']), hero('Bbbb', 'Beta', ['aa-reliant'])], maps: [], curated: bundle({ counterRules: [blind] }) });
    expect(t.counters).toEqual([{ a: 'Aaaa', b: 'Bbbb', score: 69, source: 'theory', reasons: [{ kind: 'theory', text: 'Alpha beats Beta with blind (Alpha blind).' }] }]);
    // The evidence is quoted in the text, so it is not repeated; a template without it keeps the list.
    const quiet = rule('quiet', ['blind'], ['aa-reliant'], 0.4, '{a} beats {b}.');
    const u = buildTheory({ heroes: [hero('Aaaa', 'Alpha', ['blind']), hero('Bbbb', 'Beta', ['aa-reliant'])], maps: [], curated: bundle({ counterRules: [quiet] }) });
    expect(u.counters[0]?.reasons).toEqual([{ kind: 'theory', text: 'Alpha beats Beta.', evidence: ['Alpha blind'] }]);
  });

  it('counts a rule once per pair at 0.6x when either side is talent-only (never compounded)', () => {
    const heroes = [hero('Aaaa', 'Alpha', [['blind', 'talent']]), hero('Bbbb', 'Beta', [['aa-reliant', 'talent']]), hero('Cccc', 'Gamma', ['aa-reliant'])];
    const t = buildTheory({ heroes, maps: [], curated: bundle({ counterRules: [blind] }) });
    expect(counterOf(t, 'Aaaa', 'Bbbb')?.score).toBe(theoryScore(0.4 * OPTIONAL_FACTOR));
    expect(counterOf(t, 'Aaaa', 'Cccc')?.score).toBe(theoryScore(0.4 * OPTIONAL_FACTOR));
  });

  it('adds the curated pair weight, puts curated reasons first and labels the edge curated', () => {
    const heroes = [hero('Aaaa', 'Alpha', ['blind']), hero('Bbbb', 'Beta', ['aa-reliant'])];
    const t = buildTheory({ heroes, maps: [], curated: bundle({ counterRules: [blind], counters: [curatedPair('alpha', 'beta', 0.4, ['First why line.', 'Second why line.'])] }) });
    const e = counterOf(t, 'Aaaa', 'Bbbb');
    expect(e?.score).toBe(theoryScore(0.8));
    expect(e?.source).toBe('curated');
    expect(e?.reasons.map((r) => `${r.kind}:${r.text}`)).toEqual(['curated:First why line.', 'curated:Second why line.', 'theory:Alpha beats Beta with blind (Alpha blind).']);
    expect(e?.reasons[0]?.evidence).toEqual(['Some Ability']);
  });

  it('emits a curated-only edge when no rule matches, and nothing for x = 0', () => {
    const heroes = [hero('Aaaa', 'Alpha', []), hero('Bbbb', 'Beta', [])];
    const t = buildTheory({ heroes, maps: [], curated: bundle({ counters: [curatedPair('beta', 'alpha', 0.2)] }) });
    expect(t.counters.map((e) => [e.a, e.b, e.score])).toEqual([['Bbbb', 'Aaaa', 60]]);
  });

  it('caps the generic rules of one pair at RULE_CAP but lets a curated pair add on top', () => {
    const rules = ['blind', 'stun', 'root', 'silence'].map((tag, i) => rule(`r${i}`, [tag], ['aa-reliant'], 0.4));
    const heroes = [hero('Aaaa', 'Alpha', ['blind', 'stun', 'root', 'silence']), hero('Bbbb', 'Beta', ['aa-reliant'])];
    const generic = buildTheory({ heroes, maps: [], curated: bundle({ counterRules: rules }) });
    expect(counterOf(generic, 'Aaaa', 'Bbbb')?.score).toBe(theoryScore(RULE_CAP));
    expect(counterOf(generic, 'Aaaa', 'Bbbb')?.reasons).toHaveLength(4);
    const curated = buildTheory({ heroes, maps: [], curated: bundle({ counterRules: rules, counters: [curatedPair('alpha', 'beta', 0.6)] }) });
    expect(counterOf(curated, 'Aaaa', 'Bbbb')?.score).toBe(theoryScore(RULE_CAP + 0.6));
    expect(ruleSum([{ value: -2, id: 'x', reason: { kind: 'theory', text: 'x' } }])).toBe(-RULE_CAP);
  });

  it('drops generic edges within PRUNE_MARGIN of 50 but keeps curated pairs, however weak', () => {
    const mild = rule('mild', ['blind'], ['aa-reliant'], 0.1);
    // 0.1 → 55 is kept; 0.1 × 0.6 (talent-only) → 53 is pruned.
    const heroes = [hero('Aaaa', 'Alpha', ['blind']), hero('Bbbb', 'Beta', ['aa-reliant']), hero('Cccc', 'Gamma', [['blind', 'talent']])];
    const t = buildTheory({ heroes, maps: [], curated: bundle({ counterRules: [mild] }) });
    expect(counterOf(t, 'Aaaa', 'Bbbb')?.score).toBe(55);
    expect(counterOf(t, 'Cccc', 'Bbbb')).toBeUndefined();
    expect(negligible(54) && negligible(46) && !negligible(55) && !negligible(45)).toBe(true);
    const withPair = buildTheory({ heroes, maps: [], curated: bundle({ counterRules: [mild], counters: [curatedPair('gamma', 'beta', 0.02)] }) });
    expect(counterOf(withPair, 'Cccc', 'Bbbb')?.source).toBe('curated');
  });

  it('treats a counter rule that matches both ways as a wash, netting the difference', () => {
    // Both Blind and both rely on Basic Attacks: neither counters the other through this rule.
    const mirror = [hero('Aaaa', 'Alpha', ['blind', 'aa-reliant']), hero('Bbbb', 'Beta', ['blind', 'aa-reliant'])];
    expect(buildTheory({ heroes: mirror, maps: [], curated: bundle({ counterRules: [blind] }) }).counters).toEqual([]);
    // Alpha's Blind is always there, Beta's only with a talent: Alpha keeps the difference (0.4 - 0.24).
    const lopsided = [hero('Aaaa', 'Alpha', ['blind', 'aa-reliant']), hero('Bbbb', 'Beta', [['blind', 'talent'], 'aa-reliant'])];
    const t = buildTheory({ heroes: lopsided, maps: [], curated: bundle({ counterRules: [blind] }) });
    expect(counterOf(t, 'Aaaa', 'Bbbb')?.score).toBe(theoryScore(0.4 - 0.4 * OPTIONAL_FACTOR));
    expect(counterOf(t, 'Bbbb', 'Aaaa')).toBeUndefined();
  });

  it('says which talent a match needs', () => {
    const heroes = [hero('Aaaa', 'Alpha', [['blind', 'talent']]), hero('Bbbb', 'Beta', [['aa-reliant', 'talent']])];
    const t = buildTheory({ heroes, maps: [], curated: bundle({ counterRules: [blind] }) });
    expect(counterOf(t, 'Aaaa', 'Bbbb')?.reasons[0]?.text).toBe('Alpha beats Beta with blind (Alpha blind talent). Only when Alpha takes Alpha blind talent. Beta must also take Beta aa-reliant talent.');
    expect(onlyWhen([{ name: 'X', match: { factor: 1, tag: 'blind', evidence: ['Q'] } }])).toBe('');
  });

  it('names every pick that gives an optional tag, not just the first (Lightbomb or Censure)', () => {
    const anduin = hero('Aaaa', 'Alpha', []);
    anduin.mechanics = [
      {
        tag: 'stun',
        evidence: [
          { kind: 'ability', name: 'Alpha Heroic A', snippet: 'x' },
          { kind: 'talent', name: 'Censure', snippet: 'x' },
        ],
      },
    ];
    const stunVsChannel = rule('stun-vs-channel', ['stun'], ['channel'], 0.3, '{a} can interrupt channels with stun ({evidence}).');
    const t = buildTheory({ heroes: [anduin, hero('Bbbb', 'Beta', ['channel'])], maps: [], curated: bundle({ counterRules: [stunVsChannel] }) });
    expect(counterOf(t, 'Aaaa', 'Bbbb')?.reasons[0]?.text).toBe(
      'Alpha can interrupt channels with stun (Alpha Heroic A, Censure). Only when Alpha takes Alpha Heroic A or Censure.',
    );
    expect(orList(['A'])).toBe('A');
    expect(orList(['A', 'B', 'C'])).toBe('A, B or C');
  });

  it('carries each curated line\'s conditions into Reason.conditions, never into the text', () => {
    const heroes = [hero('Aaaa', 'Alpha', []), hero('Bbbb', 'Beta', [])];
    const pair: MergedPair = {
      ...curatedPair('alpha', 'beta', 0.2, ['Needs the talent.', 'Holds anyway.']),
      whyConditions: [['Alpha takes Big Talent (level 16)'], []],
      conditions: ['Alpha takes Big Talent (level 16)'],
    };
    const e = counterOf(buildTheory({ heroes, maps: [], curated: bundle({ counters: [pair] }) }), 'Aaaa', 'Bbbb');
    expect(e?.reasons).toEqual([
      { kind: 'curated', text: 'Needs the talent.', evidence: ['Some Ability'], conditions: ['Alpha takes Big Talent (level 16)'] },
      { kind: 'curated', text: 'Holds anyway.' },
    ]);
    expect(conditionsText(e?.reasons[0]?.conditions)).toBe(' Only when Alpha takes Big Talent (level 16).');
    expect(conditionsText(['A', 'B'])).toBe(' Only when A, and B.');
    expect(conditionsText(undefined)).toBe('');
  });

  it('is directed: the reverse pair only scores with its own rules', () => {
    const t = buildTheory({ heroes: [hero('Aaaa', 'Alpha', ['blind']), hero('Bbbb', 'Beta', ['aa-reliant'])], maps: [], curated: bundle({ counterRules: [blind] }) });
    expect(counterOf(t, 'Bbbb', 'Aaaa')).toBeUndefined();
  });

  it('supports negative weights', () => {
    const t = buildTheory({ heroes: [hero('Aaaa', 'Alpha', ['stun']), hero('Bbbb', 'Beta', ['unstoppable'])], maps: [], curated: bundle({ counterRules: [rule('weak', ['stun'], ['unstoppable'], -0.3)] }) });
    expect(counterOf(t, 'Aaaa', 'Bbbb')?.score).toBe(35);
  });

  it('matches role and type selectors without evidence and drops the evidence group', () => {
    const tank = hero('Tank', 'Tanky', [], { role: 'Tank', type: 'Melee' });
    const t = buildTheory({ heroes: [hero('Aaaa', 'Alpha', ['percent-hp-damage']), tank], maps: [], curated: bundle({ counterRules: [rule('pct', ['percent-hp-damage'], ['role:tank'], 0.35, '{a} hurts {b}, a {bTag} ({evidence}).')] }) });
    expect(counterOf(t, 'Aaaa', 'Tank')?.reasons[0]?.text).toBe('Alpha hurts Tanky, a Tank frontline (Alpha percent-hp-damage).');
    const r = buildTheory({ heroes: [hero('Aaaa', 'Alpha', [], { role: 'Healer' }), hero('Bbbb', 'Beta', ['poke'])], maps: [], curated: bundle({ counterRules: [rule('heal', ['role:healer'], ['poke'], 0.15, '{a} heals through {b} ({evidence}).')] }) });
    expect(counterOf(r, 'Aaaa', 'Bbbb')?.reasons[0]).toEqual({ kind: 'theory', text: 'Alpha heals through Beta.' });
  });
});

// ---- synergies ---------------------------------------------------------------------------

describe('buildTheory synergies', () => {
  const ccBurst = rule('cc-burst', ['stun'], ['burst'], 0.3, "{a}'s {aTag} ({evidence}) sets up {b}.");

  it('matches either way round, counts once and stores a < b', () => {
    const heroes = [hero('Zzzz', 'Zed', ['stun']), hero('Aaaa', 'Alpha', ['burst'])];
    const t = buildTheory({ heroes, maps: [], curated: bundle({ synergyRules: [ccBurst] }) });
    expect(t.synergies).toEqual([{ a: 'Aaaa', b: 'Zzzz', score: 65, source: 'theory', reasons: [{ kind: 'theory', text: "Zed's stun (Zed stun) sets up Alpha." }] }]);
  });

  it('takes the stronger direction when both match', () => {
    const heroes = [hero('Aaaa', 'Alpha', ['stun', 'burst']), hero('Bbbb', 'Beta', [['stun', 'talent'], 'burst'])];
    const t = buildTheory({ heroes, maps: [], curated: bundle({ synergyRules: [ccBurst] }) });
    expect(t.synergies[0]?.score).toBe(65);
    expect(t.synergies[0]?.reasons).toHaveLength(1);
  });

  it('adds curated synergy pairs whichever way they are keyed', () => {
    const heroes = [hero('Zzzz', 'Zed', []), hero('Aaaa', 'Alpha', [])];
    const t = buildTheory({ heroes, maps: [], curated: bundle({ synergies: [curatedPair('alpha', 'zed', 0.4)] }) });
    expect(t.synergies.map((e) => [e.a, e.b, e.score, e.source])).toEqual([['Aaaa', 'Zzzz', 69, 'curated']]);
  });
});

// ---- map fit -----------------------------------------------------------------------------

describe('buildTheory map fit', () => {
  const fit: CuratedBundle['maps']['fit'] = [
    { id: 'global-large', map: ['large'], hero: ['global'], weight: 0.4, why: "{hero}'s {heroTag} ({evidence}) helps on {map} ({mapTag})." },
    { id: 'immobile-large', map: ['large'], hero: ['immobile'], weight: -0.3, why: '{hero} is slow on {map}.' },
  ];

  it('scores matching rules per hero and map and leaves unmatched pairs out', () => {
    const heroes = [hero('Aaaa', 'Alpha', ['global']), hero('Bbbb', 'Beta', [['immobile', 'curated']]), hero('Cccc', 'Gamma', [])];
    const t = buildTheory({ heroes, maps: MAPS, curated: bundle({ fit }) });
    expect(t.mapFit).toEqual([
      { hero: 'Aaaa', map: 'big-map', score: 69, reasons: [{ kind: 'theory', text: "Alpha's global presence (Alpha global) helps on Big Map (large)." }] },
      { hero: 'Bbbb', map: 'big-map', score: 35, reasons: [{ kind: 'theory', text: 'Beta is slow on Big Map.' }] },
    ]);
  });
});

// ---- curated traits and composites ----------------------------------------------------------

describe('applyCuratedTraits', () => {
  const traits: CuratedBundle['traits'] = {
    alpha: [
      { tag: 'dive', why: 'Alpha jumps onto the back line.', op: 'add', source: 'heroes/alpha.yaml' },
      { tag: 'stun', why: 'The extracted stun is only against minions.', op: 'remove', source: 'traits.yaml' },
    ],
  };

  it('adds curated tags with curated evidence and removes wrongly extracted ones', () => {
    const [a] = applyCuratedTraits([hero('Aaaa', 'Alpha', ['stun', 'blind'])], bundle({ traits }));
    expect(a?.mechanics.map((m) => m.tag)).toEqual(['blind', 'dive']);
    expect(a?.mechanics.find((m) => m.tag === 'dive')?.evidence).toEqual([{ kind: 'curated', name: 'curated/hots/heroes/alpha.yaml', snippet: 'Alpha jumps onto the back line.' }]);
  });

  it('is idempotent and keeps hero order', () => {
    const heroes = [hero('Bbbb', 'Beta', ['root']), hero('Aaaa', 'Alpha', ['stun'])];
    const once = applyCuratedTraits(heroes, bundle({ traits }));
    expect(applyCuratedTraits(once, bundle({ traits }))).toEqual(once);
    expect(once.map((h) => h.id)).toEqual(['Bbbb', 'Aaaa']);
  });

  it('gives a composite the union of its members, and the engine scores the composite only', () => {
    const cho = hero('CCho', 'Cho', ['stun'], { memberOf: 'chogall', role: 'Tank', type: 'Melee' });
    const gall = hero('Gall', 'Gall', ['burst'], { memberOf: 'chogall' });
    const chogall = hero('chogall', "Cho'gall", [], { slug: 'chogall', members: ['CCho', 'Gall'], abilities: [], role: 'Tank', roleAlt: 'Ranged Assassin', type: 'Melee' });
    const merged = applyCuratedTraits([cho, gall, chogall], bundle({ traits: { chogall: [{ tag: 'frontline', why: 'Cho stands in front.', op: 'add', source: 'heroes/chogall.yaml' }] } }));
    expect(merged.find((h) => h.id === 'chogall')?.mechanics.map((m) => m.tag)).toEqual(['stun', 'burst', 'frontline']);
    const blinder = hero('Aaaa', 'Alpha', ['blind']);
    const t = buildTheory({
      heroes: [cho, gall, chogall, blinder, hero('Bbbb', 'Beta', ['aa-reliant'])],
      maps: [],
      curated: bundle({ counterRules: [rule('stun-vs-aa', ['stun'], ['aa-reliant'], 0.3)], counters: [curatedPair('cho', 'alpha', 0.2)] }),
    });
    const ids = new Set(t.counters.flatMap((e) => [e.a, e.b]));
    expect(ids.has('CCho')).toBe(false);
    expect(ids.has('Gall')).toBe(false);
    expect(counterOf(t, 'chogall', 'Bbbb')?.score).toBe(65);
    // A curated pair naming a member resolves to the composite.
    expect(counterOf(t, 'chogall', 'Aaaa')?.source).toBe('curated');
  });
});

// ---- whole-output properties -------------------------------------------------------------

describe('buildTheory output', () => {
  const curated = loadCurated(repoRoot());
  const inputs = fixtureHeroInputs();
  const heroes = applyCuratedTraits(
    inputs.map((h) => ({ ...h, mechanics: extractMechanics(h) })),
    curated,
  );
  const maps: GameMap[] = Object.entries(curated.maps.maps).map(([id, m]) => ({
    id,
    name: m.name,
    kind: m.kind,
    ranked: m.kind === 'standard',
    rankedSource: 'curated',
    image: `img/maps/${id}.webp`,
    profile: { size: m.size, lanes: m.lanes, objective: m.objective, tags: m.tags },
  }));
  const theory = buildTheory({ heroes, maps, curated });
  const idOf = (slug: string) => heroes.find((h) => h.slug === slug)?.id ?? slug;

  it('validates against TheorySchema with the versioned rules hash', () => {
    expect(() => TheorySchema.parse(theory)).not.toThrow();
    expect(theory.rulesVersion).toMatch(new RegExp(`^${RULES_VERSION.replace('.', '\\.')}\\+[0-9a-f]{12}$`));
  });

  it('keeps every score inside 1..100 and every edge explained', () => {
    for (const e of [...theory.counters, ...theory.synergies]) {
      expect(e.score).toBeGreaterThanOrEqual(1);
      expect(e.score).toBeLessThanOrEqual(100);
      expect(e.reasons.length).toBeGreaterThan(0);
    }
  });

  it('is sorted and byte-identical whatever the input order', () => {
    const shuffled = buildTheory({ heroes: [...heroes].reverse(), maps: [...maps].reverse(), curated });
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(theory));
    const keys = theory.counters.map((e) => `${e.a}>${e.b}`);
    expect(keys).toEqual([...keys].sort());
  });

  it('gives sensible scores for well-known matchups', () => {
    // Zeratul hunts Abathur (curated in both files, plus stealth and burst rules).
    expect(counterOf(theory, idOf('zeratul'), idOf('abathur'))?.score).toBeGreaterThanOrEqual(80);
    // Johanna's Shield Glare blinds Valla's Basic Attacks.
    const jv = counterOf(theory, idOf('johanna'), idOf('valla'));
    expect(jv?.score).toBeGreaterThanOrEqual(65);
    expect(jv?.reasons.some((r) => r.text.includes('Shield Glare'))).toBe(true);
    // Malthael's percent damage against the composite's large Health pool.
    expect(counterOf(theory, idOf('malthael'), 'chogall')?.score).toBeGreaterThanOrEqual(70);
  });

  it('changes rulesVersion when a curated input changes', () => {
    const edited: CuratedBundle = { ...curated, rules: { ...curated.rules, counters: curated.rules.counters.map((r, i) => (i === 0 ? { ...r, weight: r.weight + 0.05 } : r)) } };
    expect(theoryRulesVersion(edited)).not.toBe(theoryRulesVersion(curated));
    expect(theoryRulesVersion({ ...curated })).toBe(theoryRulesVersion(curated));
  });
});
