/**
 * Theory hook: runs the theory engine (src/games/hots/theory/index.ts, SPEC §5.1) over the
 * freshly built heroes and maps, or falls back to last-good output when the engine is missing
 * or fails. The engine is imported dynamically so the data pipeline keeps working while it is
 * absent or broken; its output is schema-checked here before it can reach a data file.
 *
 * Contract (implemented by the theory module):
 *   RULES_VERSION: string
 *   extractMechanics(hero: HeroInput): Mechanic[]
 *   loadCurated(repoRoot: string): CuratedBundle
 *   applyCuratedTraits(heroes: Hero[], curated: CuratedBundle): Hero[]
 *   buildTheory({ heroes, maps, curated }): Theory      (heroes = draftable entities with mechanics)
 */
import type { ValidationIssue } from '../../../core/game.ts';
import { MechanicSchema, TheorySchema, type GameMap, type Hero, type Mechanic, type Theory } from '../schema.ts';
import type { HeroInput } from './transform/heroes.ts';
import { compareStrings, errorMessage, warn } from './util.ts';

export interface TheoryModule {
  RULES_VERSION: string;
  extractMechanics(hero: HeroInput): Mechanic[];
  loadCurated(repoRoot: string): unknown;
  applyCuratedTraits(heroes: Hero[], curated: unknown): Hero[];
  buildTheory(input: { heroes: Hero[]; maps: GameMap[]; curated: unknown }): Theory;
}

export type TheoryLoader = () => Promise<TheoryModule>;

/** Default loader: `../theory/index.ts` relative to this pipeline directory. */
export const loadTheoryModule: TheoryLoader = async () => {
  const url = new URL('../theory/index.ts', import.meta.url);
  const mod = (await import(/* @vite-ignore */ url.href)) as Partial<TheoryModule>;
  for (const fn of ['extractMechanics', 'loadCurated', 'applyCuratedTraits', 'buildTheory'] as const) {
    if (typeof mod[fn] !== 'function') throw new Error(`theory module does not export ${fn}()`);
  }
  if (typeof mod.RULES_VERSION !== 'string') throw new Error('theory module does not export RULES_VERSION');
  return mod as TheoryModule;
};

export const EMPTY_THEORY: Theory = { rulesVersion: 'none', counters: [], synergies: [], mapFit: [] };

export interface TheoryResult {
  /** Every hero record with mechanics (members, composites). */
  heroes: Hero[];
  theory: Theory;
  /** Engine status for logs/meta: 'ok' | 'fallback'. */
  state: 'ok' | 'fallback';
  issues: ValidationIssue[];
}

export interface TheoryHookInput {
  heroes: readonly HeroInput[];
  maps: readonly GameMap[];
  root: string;
  previousHeroes: readonly Hero[] | null;
  previousTheory: Theory | null;
  load?: TheoryLoader;
}

/** Union of member mechanics for a composite (evidence concatenated, duplicates dropped). */
export function mergeMechanics(lists: readonly Mechanic[][]): Mechanic[] {
  const byTag = new Map<string, Mechanic['evidence']>();
  for (const list of lists) {
    for (const m of list) {
      const ev = byTag.get(m.tag) ?? [];
      for (const e of m.evidence) if (!ev.some((x) => x.kind === e.kind && x.name === e.name && x.snippet === e.snippet)) ev.push({ ...e });
      byTag.set(m.tag, ev);
    }
  }
  return [...byTag].map(([tag, evidence]) => ({ tag: tag as Mechanic['tag'], evidence })).sort((a, b) => compareStrings(a.tag, b.tag));
}

function withMechanics(heroes: readonly HeroInput[], mech: (h: HeroInput) => Mechanic[]): Hero[] {
  const base = new Map<string, Mechanic[]>();
  for (const h of heroes) if (!h.members) base.set(h.id, mech(h));
  return heroes.map((h) => ({ ...h, mechanics: h.members ? mergeMechanics(h.members.map((m) => base.get(m) ?? [])) : (base.get(h.id) ?? []) }));
}

function fallback(input: TheoryHookInput, why: string): TheoryResult {
  const prev = new Map((input.previousHeroes ?? []).map((h) => [h.id, h.mechanics]));
  const heroes = withMechanics(input.heroes, (h) => prev.get(h.id) ?? []);
  // Composites keep their own last-good mechanics (they may include curated traits).
  for (const h of heroes) if (h.members && prev.has(h.id)) h.mechanics = prev.get(h.id) ?? h.mechanics;
  const prevTheory = input.previousTheory && TheorySchema.safeParse(input.previousTheory).success ? input.previousTheory : null;
  const ids = new Set(heroes.filter((h) => !h.memberOf).map((h) => h.id));
  const maps = new Set(input.maps.map((m) => m.id));
  const theory: Theory = prevTheory
    ? {
        rulesVersion: prevTheory.rulesVersion,
        counters: prevTheory.counters.filter((e) => ids.has(e.a) && ids.has(e.b)),
        synergies: prevTheory.synergies.filter((e) => ids.has(e.a) && ids.has(e.b)),
        mapFit: prevTheory.mapFit.filter((f) => ids.has(f.hero) && maps.has(f.map)),
      }
    : { ...EMPTY_THEORY };
  const detail = prevTheory ? 'kept last-good theory.json and mechanics' : 'no last-good theory; emitted an empty theory.json and no mechanics';
  return { heroes, theory, state: 'fallback', issues: [warn(`theory engine unavailable (${why}); ${detail}`)] };
}

export async function runTheory(input: TheoryHookInput): Promise<TheoryResult> {
  let mod: TheoryModule;
  try {
    mod = await (input.load ?? loadTheoryModule)();
  } catch (err) {
    return fallback(input, `import failed: ${errorMessage(err)}`);
  }
  try {
    const curated = mod.loadCurated(input.root);
    const extracted = withMechanics(input.heroes, (h) => mod.extractMechanics(h));
    // Only `mechanics` is taken from the engine; every other hero field stays ours.
    const traited = new Map(mod.applyCuratedTraits(extracted, curated).map((h) => [h.id, h.mechanics]));
    const heroes = extracted.map((h) => ({ ...h, mechanics: [...(traited.get(h.id) ?? h.mechanics)].sort((a, b) => compareStrings(a.tag, b.tag)) }));
    for (const h of heroes) {
      for (const m of h.mechanics) {
        const r = MechanicSchema.safeParse(m);
        if (!r.success) throw new Error(`invalid mechanic on ${h.id}: ${r.error.issues[0]?.message ?? 'schema mismatch'}`);
      }
    }
    const entities = heroes.filter((h) => !h.memberOf);
    const theory = mod.buildTheory({ heroes: entities, maps: [...input.maps], curated });
    const parsed = TheorySchema.safeParse(JSON.parse(JSON.stringify(theory)));
    if (!parsed.success) throw new Error(`theory output does not match TheorySchema: ${parsed.error.issues[0]?.message ?? ''}`);
    return { heroes, theory: parsed.data, state: 'ok', issues: [] };
  } catch (err) {
    return fallback(input, errorMessage(err));
  }
}
