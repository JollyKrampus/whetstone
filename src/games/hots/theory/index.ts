/**
 * HotS theory layer (SPEC §5.1): the contract the HotS data pipeline calls.
 *
 *   const curated = loadCurated(repoRoot);                       // Node only (reads curated/hots/)
 *   const withTags = heroes.map((h) => ({ ...h, mechanics: extractMechanics(h) }));
 *   const merged = applyCuratedTraits(withTags, curated);        // composite Cho'gall gets Cho + Gall
 *   const theory = buildTheory({ heroes: merged, maps, curated }); // → theory.json
 *
 * This module re-exports loadCurated, which uses node:fs. Browser code that needs the engine or
 * the extractor imports ./engine.ts or ./extract.ts directly; both are pure and browser-safe.
 * How it works and how to contribute: docs/THEORY.md.
 */
export { RULES_VERSION, applyCuratedTraits, buildTheory, theoryRulesVersion, type BuildTheoryInput } from './engine.ts';
export { extractMechanics } from './extract.ts';
export { loadCurated, readCurated, checkCuratedAgainstHeroes, CuratedError, type CuratedIssue, type LoadCuratedOptions } from './curated.ts';
export type { CuratedBundle, CuratedTraitEntry, HeroInput, MergedPair } from './types.ts';
