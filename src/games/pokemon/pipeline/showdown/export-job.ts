/**
 * The Showdown dex export as a job of its own, for a workflow job that holds no secrets and no
 * write token:
 *
 *   node src/games/pokemon/pipeline/showdown/export-job.ts --out <file> [--now <ISO time>]
 *
 * It reads the pinned commit (curated/pokemon/showdown.json) and the regulations
 * (curated/pokemon/regulations.yaml), downloads that commit's source zip, transpiles it and runs
 * export.ts on it (build.ts), validates the result with RawDexExportSchema, checks it is the
 * pinned commit's export for this run's regulations, and writes it to <file>. That JSON is the
 * job's only output; the Pokémon data job reads it through WHETSTONE_SHOWDOWN_EXPORT and validates
 * it again, so code from the downloaded tree never runs in a job that can see a secret.
 *
 * Exit code 0 with the file written, 1 otherwise. Logs go to stderr.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHttp } from '../../../../../pipeline/http.ts';
import { repoRoot } from '../../../../lib/datadir.ts';
import { loadRegulations, regulationPlan } from '../regulations.ts';
import { buildTree, exportDex } from './build.ts';
import { checkExport, dexRequest, isCi, loadShowdownPin } from './pin.ts';

interface Args {
  out: string;
  now: Date;
}

function parseArgs(argv: readonly string[]): Args {
  let out: string | undefined;
  let now = new Date();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') out = argv[++i];
    else if (a === '--now') now = new Date(argv[++i] ?? '');
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out) throw new Error('usage: node src/games/pokemon/pipeline/showdown/export-job.ts --out <file> [--now <ISO time>]');
  if (Number.isNaN(now.getTime())) throw new Error('--now is not a valid date');
  return { out, now };
}

export async function runExportJob(args: Args, log: (msg: string) => void = (m) => console.error(m)): Promise<void> {
  const root = repoRoot();
  const pin = loadShowdownPin(root);
  const regs = loadRegulations(root);
  const request = dexRequest(regs, regulationPlan(regs, args.now));
  log(`showdown export: pinned ${pin.sha.slice(0, 7)} (reviewed ${pin.reviewedOn}); regulations ${request.regulations.map((r) => r.id).join(', ')}`);
  const http = createHttp({ game: 'pokemon', root, cache: !isCi(), log });
  const dist = await buildTree({ http, root, sha: pin.sha, log });
  const raw = await exportDex(dist, request, pin.sha);
  checkExport(raw, pin.sha, request);
  const out = path.resolve(args.out);
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(raw));
  log(`showdown export: ${raw.species.length} species/formes, ${raw.moves.length} moves, ${raw.items.length} items; data for ${raw.dataRegulation} -> ${out}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const fail = (err: unknown): void => {
    console.error(`showdown export failed: ${(err as Error).message}`);
    process.exitCode = 1;
  };
  try {
    runExportJob(parseArgs(process.argv.slice(2))).catch(fail);
  } catch (err) {
    fail(err);
  }
}
