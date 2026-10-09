/**
 * Validates the curated theory files (SPEC §5.1): schema, merge warnings and, when hero data is
 * available, slugs and evidence names against the current kits.
 *
 *   node src/games/hots/theory/validate.ts [--root <repo>] [--heroes <heroes.json>] [--strict]
 *
 * Hero data: --heroes, else <root>/data/current/hots/heroes.json when a pipeline run left one.
 * (The committed fixtures hold a 15-hero sample, so they are not used for the roster check.)
 * Prints every error and warning; exits 1 on errors (and on warnings with --strict).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { repoRoot } from '../../../lib/datadir.ts';
import type { HeroInput } from './types.ts';
import { checkCuratedAgainstHeroes, formatIssue, readCurated, type CuratedIssue } from './curated.ts';

export interface ValidateResult {
  errors: CuratedIssue[];
  warnings: CuratedIssue[];
  summary: string;
}

/** Runs every check; pure apart from reading the files. */
export function validateCurated(root: string, heroes: readonly HeroInput[] | null): ValidateResult {
  const knownSlugs = heroes ? heroes.map((h) => h.slug) : undefined;
  const { bundle, errors, warnings } = readCurated(root, knownSlugs ? { knownSlugs } : {});
  const all = [...warnings];
  if (bundle && heroes) all.push(...checkCuratedAgainstHeroes(bundle, heroes));
  const summary = bundle
    ? `${bundle.files.length} hero files, ${Object.keys(bundle.traits).length} heroes with traits, ` +
      `${bundle.counters.length} counter pairs, ${bundle.synergies.length} synergy pairs, ` +
      `${bundle.rules.counters.length + bundle.rules.synergies.length} rules, ${bundle.maps.fit.length} map-fit rules`
    : 'curated files could not be loaded';
  return { errors, warnings: all, summary };
}

function readHeroes(file: string): HeroInput[] {
  const data = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!Array.isArray(data)) throw new Error(`${file}: expected an array of heroes`);
  return data as HeroInput[];
}

function main(argv: string[]): number {
  const { values } = parseArgs({
    args: argv,
    options: {
      root: { type: 'string' },
      heroes: { type: 'string' },
      strict: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
  });
  if (values.help) {
    console.log('Usage: node src/games/hots/theory/validate.ts [--root <repo>] [--heroes <heroes.json>] [--strict]');
    return 0;
  }
  const root = path.resolve(values.root ?? repoRoot());
  const heroesFile = values.heroes ?? path.join(root, 'data', 'current', 'hots', 'heroes.json');
  const heroes = fs.existsSync(heroesFile) ? readHeroes(heroesFile) : null;
  const { errors, warnings, summary } = validateCurated(root, heroes);
  for (const e of errors) console.error(`error   ${formatIssue(e)}`);
  for (const w of warnings) console.warn(`warning ${formatIssue(w)}`);
  console.log(`${summary}${heroes ? ` (checked against ${path.relative(root, heroesFile) || heroesFile})` : ' (no heroes.json: roster and evidence checks skipped)'}`);
  console.log(`${errors.length} error(s), ${warnings.length} warning(s)`);
  return errors.length > 0 || (values.strict && warnings.length > 0) ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
