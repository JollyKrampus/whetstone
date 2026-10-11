/**
 * The Pokémon Showdown commit the dex is exported from, pinned in a tracked file
 * (curated/pokemon/showdown.json) and only ever changed by a reviewed pull request. The daily
 * pipeline never follows Showdown's master on its own: building the dex means running code from
 * that tree, so a new commit must be read before it runs anywhere near the workflow's secrets.
 *
 * The export itself runs in its own workflow job without secrets (export-job.ts), which hands
 * the data job nothing but a JSON file; the data job validates that file here
 * (readExportFile + checkExport) before transforming it.
 *
 * CLI, for the pull request that bumps the pin (reads GitHub only, runs nothing it downloads):
 *
 *   node src/games/pokemon/pipeline/showdown/pin.ts --check              pinned commit vs master, compare link
 *   node src/games/pokemon/pipeline/showdown/pin.ts --set <sha|latest>   rewrite the pin (reviewedOn = today)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Http } from '../../../../core/game.ts';
import { parseData } from '../../../../core/schemas.ts';
import type { RegulationsFile } from '../../schema.ts';
import type { RegulationPlan } from '../regulations.ts';
import type { ExportRequest } from './export.ts';
import { RawDexExportSchema, type RawDexExport } from './raw.ts';

export const SHOWDOWN_PIN_FILE = 'curated/pokemon/showdown.json';
/** Environment variable naming the export JSON produced by the isolated export job. */
export const SHOWDOWN_EXPORT_ENV = 'WHETSTONE_SHOWDOWN_EXPORT';
/** `WHETSTONE_SHOWDOWN_BUILD=local`: a developer's own run may build the pinned tree itself (never on CI). */
export const SHOWDOWN_BUILD_ENV = 'WHETSTONE_SHOWDOWN_BUILD';

const Sha = z.string().regex(/^[0-9a-f]{40}$/, 'expected a full 40-character commit SHA');

export const ShowdownPinSchema = z.strictObject({
  /** smogon/pokemon-showdown commit the dex is built from. */
  sha: Sha,
  /** Day (UTC) someone read the upstream changes up to this commit and pinned it. */
  reviewedOn: z.iso.date(),
  /** Why this commit (new regulation, data fix, …). */
  note: z.string().min(1).max(500).exactOptional(),
});
export type ShowdownPin = z.infer<typeof ShowdownPinSchema>;

export function loadShowdownPin(root: string): ShowdownPin {
  const file = path.join(root, SHOWDOWN_PIN_FILE);
  return parseData(ShowdownPinSchema, JSON.parse(readFileSync(file, 'utf8')), SHOWDOWN_PIN_FILE, { roundTrip: false });
}

/** What the exporter is asked: every listed regulation's format, data from the current one first. */
export function dexRequest(regs: RegulationsFile, plan: RegulationPlan): ExportRequest {
  return {
    regulations: regs.regulations.map((r) => ({ id: r.id, format: r.formats.doubles })),
    dataRegulations: [plan.current.id, ...(plan.previous ? [plan.previous.id] : [])],
  };
}

/** True on CI runners (GitHub Actions sets both). */
export function isCi(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env.CI === 'true' || env.GITHUB_ACTIONS === 'true';
}

/**
 * Throws unless `raw` is the export of exactly the pinned commit for this request: same SHA,
 * the same regulations in the same order, and data taken from one of the requested regulations.
 */
export function checkExport(raw: RawDexExport, sha: string, request: ExportRequest): void {
  if (raw.sha !== sha) throw new Error(`the export is of ${raw.sha.slice(0, 7)}, but ${SHOWDOWN_PIN_FILE} pins ${sha.slice(0, 7)}`);
  const got = raw.regulations.map((r) => r.id).join(', ');
  const want = request.regulations.map((r) => r.id).join(', ');
  if (got !== want) throw new Error(`the export covers regulations [${got}], this run expects [${want}]`);
  if (!request.dataRegulations.includes(raw.dataRegulation)) {
    throw new Error(`the export takes its data from ${raw.dataRegulation}, not one of ${request.dataRegulations.join(', ')}`);
  }
}

/** Read and validate an export written by the isolated job (RawDexExportSchema). */
export function readExportFile(file: string): RawDexExport {
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read the Showdown export ${file}: ${(err as Error).message}`, { cause: err });
  }
  return parseData(RawDexExportSchema, json, `Showdown export ${path.basename(file)}`, { roundTrip: false });
}

/** "https://github.com/smogon/pokemon-showdown/compare/<a>...<b>": what a bump must read. */
export function compareUrl(from: string, to: string): string {
  return `https://github.com/smogon/pokemon-showdown/compare/${from}...${to}`;
}

/** The pin file's text for a commit (stable key order, trailing newline). */
export function pinText(pin: ShowdownPin): string {
  const out: ShowdownPin = { sha: pin.sha, reviewedOn: pin.reviewedOn };
  if (pin.note) out.note = pin.note;
  return `${JSON.stringify(ShowdownPinSchema.parse(out), null, 2)}\n`;
}

async function cli(argv: readonly string[]): Promise<void> {
  const { repoRoot } = await import('../../../../lib/datadir.ts');
  const { createHttp } = await import('../../../../../pipeline/http.ts');
  const { latestSha } = await import('./build.ts');
  const root = repoRoot();
  const pin = loadShowdownPin(root);
  const http: Http = createHttp({ game: 'pokemon', root, cache: false, log: (m) => console.error(m) });
  const head = async () => latestSha(http, (m) => console.error(m));
  const [flag, value] = argv;
  if (flag === '--check') {
    const upstream = await head();
    console.log(`pinned:   ${pin.sha} (reviewed ${pin.reviewedOn})`);
    console.log(`upstream: ${upstream} (master)`);
    console.log(upstream === pin.sha ? 'The pin is at master.' : `Read before bumping: ${compareUrl(pin.sha, upstream)}`);
    return;
  }
  if (flag === '--set' && value) {
    const sha = value === 'latest' ? await head() : value;
    const next: ShowdownPin = { sha, reviewedOn: new Date().toISOString().slice(0, 10) };
    writeFileSync(path.join(root, SHOWDOWN_PIN_FILE), pinText(next));
    console.log(`${SHOWDOWN_PIN_FILE}: ${pin.sha.slice(0, 7)} -> ${sha.slice(0, 7)}. Review ${compareUrl(pin.sha, sha)} in the pull request.`);
    return;
  }
  throw new Error('usage: node src/games/pokemon/pipeline/showdown/pin.ts --check | --set <sha|latest>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli(process.argv.slice(2)).catch((err: unknown) => {
    console.error((err as Error).message);
    process.exitCode = 1;
  });
}
