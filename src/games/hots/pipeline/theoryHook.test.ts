import { describe, expect, it } from 'vitest';
import type { Hero, Mechanic, Theory } from '../schema.ts';
import { FIXTURE_NOW, REPO_ROOT, fixtureRelease, testCurated } from './test-helpers.ts';
import { mergeMechanics, runTheory, type TheoryModule } from './theoryHook.ts';
import { buildHeroes } from './transform/heroes.ts';

const inputs = buildHeroes(fixtureRelease('2.57.0.98348'), { aliases: testCurated().aliases, now: FIXTURE_NOW }).heroes;
const ev = (name: string): Mechanic['evidence'] => [{ kind: 'ability', name, snippet: name.toLowerCase() }];

/** Contract stub of src/games/hots/theory/index.ts. */
function stub(over: Partial<TheoryModule> = {}): TheoryModule {
  return {
    RULES_VERSION: 'stub-1',
    extractMechanics: (h) => (h.id === 'CCho' ? [{ tag: 'stun', evidence: ev('Rune Bomb') }] : h.id === 'Gall' ? [{ tag: 'aoe', evidence: ev('Shadow Bolt Volley') }] : [{ tag: 'poke', evidence: ev(h.name) }]),
    loadCurated: () => ({ curated: true }),
    applyCuratedTraits: (heroes) => heroes.map((h) => (h.id === 'Abat' ? { ...h, mechanics: [...h.mechanics, { tag: 'immobile', evidence: [{ kind: 'curated', name: 'traits.yaml', snippet: 'cannot dash' }] }] } : h)),
    buildTheory: ({ heroes }) => ({
      rulesVersion: 'stub-1',
      counters: [{ a: heroes[0]?.id ?? '', b: heroes[1]?.id ?? '', score: 60, source: 'theory', reasons: [{ kind: 'theory', text: 'Stub reason' }] }],
      synergies: [],
      mapFit: [],
    }),
    ...over,
  };
}

const previousTheory: Theory = {
  rulesVersion: 'old',
  counters: [
    { a: 'Abat', b: 'HXAL', score: 40, source: 'theory', reasons: [] },
    { a: 'Gone', b: 'HXAL', score: 40, source: 'theory', reasons: [] },
  ],
  synergies: [],
  mapFit: [],
};

describe('runTheory', () => {
  it('adds extracted and curated mechanics; composites merge their members', async () => {
    const r = await runTheory({ heroes: inputs, maps: [], root: REPO_ROOT, previousHeroes: null, previousTheory: null, load: async () => stub() });
    expect(r.state).toBe('ok');
    expect(r.issues).toEqual([]);
    const by = new Map(r.heroes.map((h) => [h.id, h]));
    expect(by.get('chogall')?.mechanics.map((m) => m.tag)).toEqual(['aoe', 'stun']);
    expect(by.get('Abat')?.mechanics.map((m) => m.tag)).toEqual(['immobile', 'poke']);
    expect(r.theory.rulesVersion).toBe('stub-1');
    // buildTheory sees draftable entities only.
    expect(r.theory.counters[0]?.a).not.toBe('CCho');
  });

  it('falls back to last-good theory and mechanics when the module is missing', async () => {
    const previousHeroes: Hero[] = inputs.map((h) => ({ ...h, mechanics: h.id === 'HXAL' ? [{ tag: 'reveal', evidence: ev('Shadow Mark') }] : [] }));
    const r = await runTheory({
      heroes: inputs,
      maps: [],
      root: REPO_ROOT,
      previousHeroes,
      previousTheory,
      load: async () => {
        throw new Error('Cannot find module');
      },
    });
    expect(r.state).toBe('fallback');
    expect(r.issues[0]?.message).toMatch(/import failed.*kept last-good/);
    expect(r.theory.counters).toEqual([previousTheory.counters[0]]);
    expect(r.heroes.find((h) => h.id === 'HXAL')?.mechanics[0]?.tag).toBe('reveal');
  });

  it('emits an empty, valid theory without last-good data', async () => {
    const r = await runTheory({ heroes: inputs, maps: [], root: REPO_ROOT, previousHeroes: null, previousTheory: null, load: async () => stub({ buildTheory: () => ({ bad: true }) as unknown as Theory }) });
    expect(r.state).toBe('fallback');
    expect(r.theory).toEqual({ rulesVersion: 'none', counters: [], synergies: [], mapFit: [] });
    expect(r.heroes.every((h) => h.mechanics.length === 0)).toBe(true);
    expect(r.issues[0]?.message).toMatch(/TheorySchema/);
  });

  it('rejects mechanics outside the schema', async () => {
    const r = await runTheory({ heroes: inputs, maps: [], root: REPO_ROOT, previousHeroes: null, previousTheory: null, load: async () => stub({ extractMechanics: () => [{ tag: 'flying' as Mechanic['tag'], evidence: ev('x') }] }) });
    expect(r.state).toBe('fallback');
  });
});

describe('mergeMechanics', () => {
  it('unions tags and evidence without duplicates', () => {
    const a: Mechanic[] = [{ tag: 'stun', evidence: ev('A') }];
    const b: Mechanic[] = [
      { tag: 'stun', evidence: [...ev('A'), ...ev('B')] },
      { tag: 'aoe', evidence: ev('C') },
    ];
    expect(mergeMechanics([a, b])).toEqual([
      { tag: 'aoe', evidence: ev('C') },
      { tag: 'stun', evidence: [...ev('A'), ...ev('B')] },
    ]);
  });
});
