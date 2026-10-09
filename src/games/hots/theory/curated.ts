/**
 * Curated theory inputs (SPEC §5.1.2-5): reads and validates curated/hots/*.yaml and the
 * per-hero files curated/hots/heroes/<slug>.yaml, then merges them into one CuratedBundle.
 *
 * Node-only (fs): the engine and extractor stay browser-safe; only loadCurated touches disk.
 *
 * Per-hero file format (written by curators, one file per draftable hero):
 *
 *   hero: abathur              # draftable slug (chogall for Cho'gall)
 *   reviewedFor: "2.57"        # default for every entry below
 *   traits:    [ { tag, why, op?: add|remove } ]
 *   counters:  [ { a, b, why, evidence: [names], conditions?, confidence, weight?, reviewedFor? } ]
 *   synergies: [ same shape, stored with a < b ]
 *
 * Merge rules: one edge per (kind, a, b); confidence = highest; evidence and conditions = union;
 * up to two distinct `why` lines (file order: counters.yaml / synergies.yaml first, then the
 * per-hero files by name); weight = an explicit weight if any file sets one, else the confidence
 * weight (low .2, medium .4, high .6). A counter curated both ways (a>b and b>a) keeps both
 * directed edges and is reported as a warning.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { checkUnique } from '../../../core/schemas.ts';
import {
  AliasesFileSchema,
  CuratedMapsFileSchema,
  CuratedPairSchema,
  CuratedPairsFileSchema,
  CuratedTraitSchema,
  HeroSlugSchema,
  MajorSchema,
  RulesFileSchema,
  TraitsFileSchema,
  type CuratedPair,
} from '../schema.ts';
import type { CuratedBundle, CuratedTraitEntry, HeroInput, MergedPair } from './types.ts';
import { CONFIDENCE_RANK, CONFIDENCE_WEIGHT, type Confidence } from './weights.ts';

// ---- per-hero file schema --------------------------------------------------------------

/**
 * A pair in a per-hero file: CuratedPair with required evidence, `conditions` as one line or a
 * list, and `reviewedFor` defaulting to the file's.
 */
export const HeroCuratedPairSchema = CuratedPairSchema.extend({
  evidence: z.array(z.string().min(1)).min(1, 'name at least one ability or talent the reason relies on'),
  conditions: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).exactOptional(),
  reviewedFor: MajorSchema.exactOptional(),
});
export type HeroCuratedPair = z.infer<typeof HeroCuratedPairSchema>;

export const HeroCuratedFileSchema = z
  .strictObject({
    hero: HeroSlugSchema,
    reviewedFor: MajorSchema,
    traits: z.array(CuratedTraitSchema).default([]),
    counters: z.array(HeroCuratedPairSchema).default([]),
    synergies: z.array(HeroCuratedPairSchema).default([]),
  })
  .superRefine((f, ctx) => {
    checkUnique(ctx, f.traits.map((t) => `${t.tag}/${t.op}`), 'trait', ['traits']);
    for (const kind of ['counters', 'synergies'] as const) {
      for (const [i, p] of f[kind].entries()) {
        if (p.a === p.b) ctx.addIssue({ code: 'custom', message: 'a and b must differ', path: [kind, i] });
        if (p.a !== f.hero && p.b !== f.hero) {
          ctx.addIssue({ code: 'custom', message: `pair ${p.a}/${p.b} does not involve this file's hero "${f.hero}"`, path: [kind, i] });
        }
        if (kind === 'synergies' && p.a > p.b) {
          ctx.addIssue({ code: 'custom', message: `synergies are stored with a < b: write a: ${p.b}, b: ${p.a}`, path: [kind, i] });
        }
      }
      checkUnique(ctx, f[kind].map((p) => `${p.a}|${p.b}`), `${kind} pair`, [kind]);
    }
  });
export type HeroCuratedFile = z.infer<typeof HeroCuratedFileSchema>;

// ---- issues ----------------------------------------------------------------------------

/** One finding, tied to the file (relative to curated/hots/) it comes from. */
export interface CuratedIssue {
  file: string;
  message: string;
}

export function formatIssue(issue: CuratedIssue): string {
  return `curated/hots/${issue.file}: ${issue.message}`;
}

/** Thrown by loadCurated; `message` lists every error with its file path. */
export class CuratedError extends Error {
  readonly issues: CuratedIssue[];
  constructor(issues: CuratedIssue[]) {
    super(`Invalid curated theory data:\n${issues.map((i) => `  - ${formatIssue(i)}`).join('\n')}`);
    this.name = 'CuratedError';
    this.issues = issues;
  }
}

function zodIssues(file: string, error: z.ZodError): CuratedIssue[] {
  return error.issues.map((i) => ({ file, message: `${i.path.length ? `${i.path.join('.')}: ` : ''}${i.message}` }));
}

// ---- merging (pure) --------------------------------------------------------------------

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Compares majors numerically ("2.10" > "2.9"). */
export function compareMajor(a: string, b: string): number {
  const [a1 = 0, a2 = 0] = a.split('.').map(Number);
  const [b1 = 0, b2 = 0] = b.split('.').map(Number);
  return a1 - b1 || a2 - b2;
}

/** A pair as read from any file, normalised (conditions as a list, reviewedFor filled in). */
export interface PairInput {
  a: string;
  b: string;
  why: string;
  evidence: string[];
  conditions: string[];
  confidence: Confidence;
  weight?: number;
  reviewedFor: string;
  /** File it came from, relative to curated/hots/. */
  source: string;
}

function normalizePair(p: CuratedPair | HeroCuratedPair, source: string, fallbackMajor: string): PairInput {
  const conditions = p.conditions === undefined ? [] : typeof p.conditions === 'string' ? [p.conditions] : [...p.conditions];
  return {
    a: p.a,
    b: p.b,
    why: p.why.trim(),
    evidence: [...(p.evidence ?? [])],
    conditions,
    confidence: p.confidence,
    ...(p.weight === undefined ? {} : { weight: p.weight }),
    reviewedFor: p.reviewedFor ?? fallbackMajor,
    source,
  };
}

/** Most handwritten reasons shown for one merged pair. */
export const MAX_WHY = 2;

/**
 * Merges pairs into one entry per (a, b), in input order. Undirected (synergy) pairs are keyed
 * and stored with a < b. Returns the merged list sorted by (a, b) plus warnings.
 */
export function mergePairs(pairs: readonly PairInput[], kind: 'counters' | 'synergies'): { pairs: MergedPair[]; warnings: CuratedIssue[] } {
  const merged = new Map<string, MergedPair & { explicit: { weight: number; source: string }[] }>();
  const warnings: CuratedIssue[] = [];
  for (const p of pairs) {
    const [a, b] = kind === 'synergies' && p.b < p.a ? [p.b, p.a] : [p.a, p.b];
    const key = `${a}|${b}`;
    let cur = merged.get(key);
    if (!cur) {
      cur = { a, b, why: [], evidence: [], conditions: [], confidence: p.confidence, weight: 0, reviewedFor: p.reviewedFor, sources: [], explicit: [] };
      merged.set(key, cur);
    }
    if (cur.why.length < MAX_WHY && !cur.why.includes(p.why)) cur.why.push(p.why);
    for (const e of p.evidence) if (!cur.evidence.includes(e)) cur.evidence.push(e);
    for (const c of p.conditions) if (!cur.conditions.includes(c)) cur.conditions.push(c);
    if (CONFIDENCE_RANK[p.confidence] > CONFIDENCE_RANK[cur.confidence]) cur.confidence = p.confidence;
    if (compareMajor(p.reviewedFor, cur.reviewedFor) > 0) cur.reviewedFor = p.reviewedFor;
    if (!cur.sources.includes(p.source)) cur.sources.push(p.source);
    if (p.weight !== undefined) cur.explicit.push({ weight: p.weight, source: p.source });
  }
  const out: MergedPair[] = [];
  for (const { explicit, ...pair } of merged.values()) {
    const first = explicit[0];
    if (first && explicit.some((e) => e.weight !== first.weight)) {
      warnings.push({
        file: first.source,
        message: `${kind} ${pair.a}/${pair.b}: files set different weights (${explicit.map((e) => `${e.weight} in ${e.source}`).join(', ')}); using ${first.weight}`,
      });
    }
    out.push({ ...pair, weight: first ? first.weight : CONFIDENCE_WEIGHT[pair.confidence], sources: [...pair.sources].sort(cmp) });
  }
  out.sort((x, y) => cmp(x.a, y.a) || cmp(x.b, y.b));
  if (kind === 'counters') {
    const keys = new Set(out.map((p) => `${p.a}|${p.b}`));
    for (const p of out) {
      if (p.a < p.b && keys.has(`${p.b}|${p.a}`)) {
        warnings.push({ file: p.sources[0] ?? 'counters.yaml', message: `contradiction: ${p.a} counters ${p.b} and ${p.b} counters ${p.a} are both curated; both edges are kept` });
      }
    }
  }
  return { pairs: out, warnings };
}

/** Collects traits per hero in input order; duplicates are dropped with a warning, add+remove of one tag warns. */
export function mergeTraits(entries: readonly (CuratedTraitEntry & { slug: string })[]): { traits: Record<string, CuratedTraitEntry[]>; warnings: CuratedIssue[] } {
  const traits: Record<string, CuratedTraitEntry[]> = {};
  const warnings: CuratedIssue[] = [];
  for (const { slug, ...t } of entries) {
    const list = (traits[slug] ??= []);
    const same = list.find((x) => x.tag === t.tag && x.op === t.op);
    if (same) {
      warnings.push({ file: t.source, message: `${slug}: trait ${t.op} "${t.tag}" is already set in ${same.source}; ignoring the duplicate` });
      continue;
    }
    const opposite = list.find((x) => x.tag === t.tag && x.op !== t.op);
    if (opposite) warnings.push({ file: t.source, message: `${slug}: "${t.tag}" is both added and removed (${opposite.source}, ${t.source}); the later entry wins` });
    list.push(t);
  }
  const sorted: Record<string, CuratedTraitEntry[]> = {};
  for (const slug of Object.keys(traits).sort(cmp)) sorted[slug] = traits[slug] as CuratedTraitEntry[];
  return { traits: sorted, warnings };
}

// ---- reading ---------------------------------------------------------------------------

export interface LoadCuratedOptions {
  /**
   * Draftable hero slugs that pairs and traits may name. Defaults to the per-hero file names
   * plus the hero keys of aliases.yaml (the roster the curators maintain).
   */
  knownSlugs?: Iterable<string>;
}

export interface CuratedReadResult {
  /** Present when there were no errors. */
  bundle: CuratedBundle | null;
  errors: CuratedIssue[];
  warnings: CuratedIssue[];
}

/** Relative path of the curated directory inside the repo. */
export const CURATED_DIR = path.join('curated', 'hots');
const GLOBAL_FILES = ['traits.yaml', 'rules.yaml', 'counters.yaml', 'synergies.yaml', 'maps.yaml', 'aliases.yaml'] as const;

function readYamlFile(abs: string, rel: string, errors: CuratedIssue[]): unknown {
  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    errors.push({ file: rel, message: `cannot read file (${(e as Error).message})` });
    return undefined;
  }
  try {
    return parseYaml(text);
  } catch (e) {
    errors.push({ file: rel, message: `YAML syntax error: ${(e as Error).message.split('\n')[0]}` });
    return undefined;
  }
}

function validate<S extends z.ZodType>(schema: S, value: unknown, rel: string, errors: CuratedIssue[]): z.output<S> | null {
  if (value === undefined) return null;
  const r = schema.safeParse(value);
  if (!r.success) {
    errors.push(...zodIssues(rel, r.error));
    return null;
  }
  return r.data;
}

/**
 * Reads, validates and merges every curated theory file under `<repoRoot>/curated/hots/`,
 * collecting all errors and warnings instead of stopping at the first. Used by loadCurated
 * and the validate CLI.
 */
export function readCurated(repoRoot: string, opts: LoadCuratedOptions = {}): CuratedReadResult {
  const dir = path.join(repoRoot, CURATED_DIR);
  const errors: CuratedIssue[] = [];
  const warnings: CuratedIssue[] = [];
  const read = <S extends z.ZodType>(file: string, schema: S): z.output<S> | null => validate(schema, readYamlFile(path.join(dir, file), file, errors), file, errors);

  const traitsFile = read(GLOBAL_FILES[0], TraitsFileSchema);
  const rules = read(GLOBAL_FILES[1], RulesFileSchema);
  const countersFile = read(GLOBAL_FILES[2], CuratedPairsFileSchema);
  const synergiesFile = read(GLOBAL_FILES[3], CuratedPairsFileSchema);
  const maps = read(GLOBAL_FILES[4], CuratedMapsFileSchema);
  const aliases = read(GLOBAL_FILES[5], AliasesFileSchema);

  const heroDir = path.join(dir, 'heroes');
  const heroFiles = fs.existsSync(heroDir)
    ? fs
        .readdirSync(heroDir)
        .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
        .sort(cmp)
    : [];
  const perHero: { rel: string; data: HeroCuratedFile }[] = [];
  for (const f of heroFiles) {
    const rel = `heroes/${f}`;
    const data = validate(HeroCuratedFileSchema, readYamlFile(path.join(heroDir, f), rel, errors), rel, errors);
    if (!data) continue;
    const expected = f.replace(/\.ya?ml$/, '');
    if (data.hero !== expected) {
      errors.push({ file: rel, message: `hero is "${data.hero}" but the file is named ${f}; name the file ${data.hero}.yaml` });
      continue;
    }
    perHero.push({ rel, data });
  }

  // Known slugs: explicit roster, else the curated roster (per-hero files + aliases.yaml heroes).
  const known = new Set<string>(opts.knownSlugs ?? [...perHero.map((h) => h.data.hero), ...Object.keys(aliases?.heroes ?? {})]);
  const checkSlug = (slug: string, file: string, where: string): void => {
    if (!known.has(slug)) errors.push({ file, message: `${where}: unknown hero slug "${slug}"` });
  };

  const traitEntries: (CuratedTraitEntry & { slug: string })[] = [];
  for (const [slug, list] of Object.entries(traitsFile ?? {}).sort(([x], [y]) => cmp(x, y))) {
    checkSlug(slug, 'traits.yaml', 'traits');
    for (const t of list) traitEntries.push({ slug, tag: t.tag, why: t.why.trim(), op: t.op, source: 'traits.yaml' });
  }
  const counterInputs: PairInput[] = [];
  const synergyInputs: PairInput[] = [];
  for (const [file, data, target] of [
    ['counters.yaml', countersFile, counterInputs],
    ['synergies.yaml', synergiesFile, synergyInputs],
  ] as const) {
    for (const p of data?.pairs ?? []) {
      checkSlug(p.a, file, `pair ${p.a}/${p.b}`);
      checkSlug(p.b, file, `pair ${p.a}/${p.b}`);
      target.push(normalizePair(p, file, p.reviewedFor));
    }
  }
  for (const { rel, data } of perHero) {
    for (const t of data.traits) traitEntries.push({ slug: data.hero, tag: t.tag, why: t.why.trim(), op: t.op, source: rel });
    for (const [list, target] of [
      [data.counters, counterInputs],
      [data.synergies, synergyInputs],
    ] as const) {
      for (const p of list) {
        checkSlug(p.a, rel, `pair ${p.a}/${p.b}`);
        checkSlug(p.b, rel, `pair ${p.a}/${p.b}`);
        target.push(normalizePair(p, rel, data.reviewedFor));
      }
    }
  }

  const traits = mergeTraits(traitEntries);
  const counters = mergePairs(counterInputs, 'counters');
  const synergies = mergePairs(synergyInputs, 'synergies');
  warnings.push(...traits.warnings, ...counters.warnings, ...synergies.warnings);

  const byFile = (x: CuratedIssue, y: CuratedIssue): number => cmp(x.file, y.file) || cmp(x.message, y.message);
  errors.sort(byFile);
  warnings.sort(byFile);
  if (errors.length > 0 || !rules || !maps) return { bundle: null, errors, warnings };
  return {
    bundle: {
      rules,
      maps,
      traits: traits.traits,
      counters: counters.pairs,
      synergies: synergies.pairs,
      aliases: aliases?.heroes ?? {},
      files: perHero.map((h) => h.rel),
      warnings: warnings.map(formatIssue),
    },
    errors,
    warnings,
  };
}

/**
 * Loads curated/hots/{traits,rules,counters,synergies,maps,aliases}.yaml and
 * curated/hots/heroes/*.yaml from `repoRoot`, zod-validates and merges them.
 * Throws a CuratedError listing every problem with its file path.
 */
export function loadCurated(repoRoot: string, opts: LoadCuratedOptions = {}): CuratedBundle {
  const { bundle, errors } = readCurated(repoRoot, opts);
  if (!bundle) throw new CuratedError(errors.length ? errors : [{ file: '.', message: 'curated files could not be loaded' }]);
  return bundle;
}

// ---- checks against game data (pure) ---------------------------------------------------

/** Comparison key for ability/talent names: case, apostrophe style and punctuation ignored. */
export function nameKey(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Cross-checks a bundle against the current heroes: slugs that are not draftable entities and
 * evidence names that are neither an ability nor a talent of either hero in the pair (members
 * of a composite count for it). Returns warnings; the pipeline reports them, curators fix them.
 */
export function checkCuratedAgainstHeroes(bundle: CuratedBundle, heroes: readonly HeroInput[]): CuratedIssue[] {
  const issues: CuratedIssue[] = [];
  const entities = new Map<string, HeroInput>();
  const names = new Map<string, Set<string>>();
  const bySlug = new Map(heroes.map((h) => [h.slug, h]));
  const byId = new Map(heroes.map((h) => [h.id, h]));
  for (const h of heroes) {
    if (h.memberOf) continue;
    entities.set(h.slug, h);
    const set = new Set<string>();
    for (const kit of [h, ...(h.members ?? []).map((id) => byId.get(id)).filter((m): m is HeroInput => m !== undefined)]) {
      for (const a of kit.abilities) set.add(nameKey(a.name));
      for (const tier of Object.values(kit.talents)) for (const t of tier) set.add(nameKey(t.name));
    }
    names.set(h.slug, set);
  }
  const resolve = (slug: string): string => bySlug.get(slug)?.memberOf ?? slug;
  for (const [slug, list] of Object.entries(bundle.traits)) {
    if (!entities.has(resolve(slug))) issues.push({ file: list[0]?.source ?? 'traits.yaml', message: `traits: "${slug}" is not a hero in the current data` });
  }
  for (const [kind, list] of [
    ['counters', bundle.counters],
    ['synergies', bundle.synergies],
  ] as const) {
    for (const p of list) {
      const file = p.sources[0] ?? `${kind}.yaml`;
      const a = resolve(p.a);
      const b = resolve(p.b);
      const missing = [a, b].filter((s) => !entities.has(s));
      if (missing.length) {
        issues.push({ file, message: `${kind} ${p.a}/${p.b}: ${missing.join(', ')} not in the current hero data` });
        continue;
      }
      const known = new Set([...(names.get(a) ?? []), ...(names.get(b) ?? [])]);
      const unknown = p.evidence.filter((e) => !known.has(nameKey(e)));
      if (unknown.length) issues.push({ file, message: `${kind} ${p.a}/${p.b}: evidence not found in either kit: ${unknown.join(', ')}` });
    }
  }
  return issues.sort((x, y) => cmp(x.file, y.file) || cmp(x.message, y.message));
}
