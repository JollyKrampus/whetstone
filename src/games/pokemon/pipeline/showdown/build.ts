/**
 * Builds a loadable Pokémon Showdown tree at an exact commit and runs the dex exporter on it.
 *
 * Route (why this one): the npm packages (`pokemon-showdown`, `@pkmn/*`) lag the current
 * regulation by weeks, and the client's play.pokemonshowdown.com/data files are a second-hand,
 * partial view that must be eval'd. Showdown's own Dex, by contrast, applies every Champions
 * rule (mod inheritance, the PP rules in scripts.ts init(), format bans) exactly as the
 * simulator does. So:
 *
 *  1. resolve master's commit SHA (GitHub API; git smart-HTTP ref list as a fallback);
 *  2. download the source zip of exactly that commit from codeload.github.com (~7 MB) through
 *     the pipeline's Http (UA, retries, dev cache);
 *  3. extract sim/, lib/, data/ (minus random-battles) and config/formats.ts, and transpile
 *     them to CommonJS with the TypeScript compiler we already depend on (Showdown's own
 *     `node build` needs esbuild and a full `npm ci` of its server dependencies);
 *  4. stub `ts-chacha20`, the only third-party module the Dex/validator path requires (it seeds
 *     the battle PRNG, which the exporter never uses);
 *  5. run export.ts in a child process with an empty environment (no secrets reach code from
 *     the downloaded tree) and validate its JSON.
 *
 * The tree is cached under .cache/showdown/<sha>/ (git-ignored) so local re-runs skip 2–3.
 * The pipeline skips all of this when meta.extra.dexKey is unchanged.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';
import type { Http } from '../../../../core/game.ts';
import { parseData } from '../../../../core/schemas.ts';
import { RawDexExportSchema, type RawDexExport } from './raw.ts';
import type { ExportRequest } from './export.ts';

export const SHOWDOWN_REPO = 'smogon/pokemon-showdown';
export const SHOWDOWN_BRANCH = 'master';
/** Bump when the extraction/transpile step changes, so cached trees are rebuilt. */
export const TREE_VERSION = 1;

const SHA_RE = /^[0-9a-f]{40}$/;
const EXPORT_SCRIPT = fileURLToPath(new URL('./export.ts', import.meta.url));

/** Parse a git smart-HTTP ref advertisement for one ref. */
export function parseRefAdvertisement(text: string, ref: string): string | null {
  for (const line of text.split('\n')) {
    const m = /([0-9a-f]{40}) ([^\s\0]+)/.exec(line);
    if (m && m[2] === ref) return m[1] as string;
  }
  return null;
}

export async function latestSha(http: Http, log: (msg: string) => void = () => {}): Promise<string> {
  try {
    const text = await http.text(`https://api.github.com/repos/${SHOWDOWN_REPO}/commits/${SHOWDOWN_BRANCH}`, {
      headers: { accept: 'application/vnd.github.sha' },
      fixture: 'showdown/commit',
      ttlHours: 1,
    });
    const sha = text.trim();
    if (SHA_RE.test(sha)) return sha;
    throw new Error(`unexpected response ${JSON.stringify(sha.slice(0, 60))}`);
  } catch (err) {
    log(`GitHub API commit lookup failed (${(err as Error).message}); using the git ref advertisement`);
    const refs = await http.text(`https://github.com/${SHOWDOWN_REPO}.git/info/refs?service=git-upload-pack`, { fixture: 'showdown/info-refs', ttlHours: 1 });
    const sha = parseRefAdvertisement(refs, `refs/heads/${SHOWDOWN_BRANCH}`);
    if (!sha) throw new Error(`no refs/heads/${SHOWDOWN_BRANCH} in ${SHOWDOWN_REPO}'s ref advertisement`, { cause: err });
    return sha;
  }
}

export function sourceZipUrl(sha: string): string {
  return `https://codeload.github.com/${SHOWDOWN_REPO}/zip/${sha}`;
}

/** Paths (relative to the repo root) the exporter needs. */
export function isNeededSource(rel: string): boolean {
  if (rel === 'config/formats.ts') return true;
  if (!/^(sim|lib|data)\//.test(rel)) return false;
  if (rel.startsWith('data/random-battles/') || rel.startsWith('sim/examples/') || rel.startsWith('sim/tools/')) return false;
  return /\.(ts|json)$/.test(rel) && !rel.endsWith('.d.ts');
}

/** Files of the zip that the exporter needs, keyed by repo-relative path (the zip's top folder stripped). */
export function extractSources(zip: Uint8Array): Map<string, Uint8Array> {
  const strip = (name: string): string => name.slice(name.indexOf('/') + 1);
  const files = unzipSync(zip, { filter: (f) => !f.name.endsWith('/') && isNeededSource(strip(f.name)) });
  const out = new Map<string, Uint8Array>();
  for (const [name, bytes] of Object.entries(files)) out.set(strip(name), bytes);
  if (!out.has('sim/dex.ts') || !out.has('config/formats.ts')) throw new Error('the Showdown source zip has no sim/dex.ts or config/formats.ts');
  return out;
}

/** Transpile .ts → CommonJS .js (and copy .json) into `outDir`, mirroring Showdown's `node build`. */
export async function transpileTree(files: ReadonlyMap<string, Uint8Array>, outDir: string): Promise<number> {
  const ts = (await import('typescript')).default;
  const options = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    isolatedModules: true,
    jsx: ts.JsxEmit.React,
    sourceMap: false,
  };
  const decoder = new TextDecoder();
  let count = 0;
  for (const [rel, bytes] of files) {
    const isTs = rel.endsWith('.ts');
    const target = path.join(outDir, isTs ? rel.replace(/\.ts$/, '.js') : rel);
    mkdirSync(path.dirname(target), { recursive: true });
    if (isTs) {
      const out = ts.transpileModule(decoder.decode(bytes), { fileName: rel, compilerOptions: options, reportDiagnostics: false });
      writeFileSync(target, out.outputText);
      count++;
    } else {
      writeFileSync(target, bytes);
    }
  }
  const stub = path.join(outDir, 'node_modules', 'ts-chacha20', 'index.js');
  mkdirSync(path.dirname(stub), { recursive: true });
  writeFileSync(
    stub,
    "'use strict';\n// Whetstone stub: the dex exporter never runs battles, so the PRNG cipher is never used.\n" +
      "class Chacha20 { constructor() { throw new Error('ts-chacha20 is not available in the Whetstone dex exporter'); } }\nmodule.exports = { Chacha20 };\n",
  );
  return count;
}

export interface BuildOptions {
  http: Http;
  root: string;
  sha: string;
  log: (msg: string) => void;
}

/** A transpiled tree for `sha`, reused from .cache/showdown/<sha>/ when complete. */
export async function buildTree(o: BuildOptions): Promise<string> {
  const cacheRoot = path.join(o.root, '.cache', 'showdown');
  const dir = path.join(cacheRoot, o.sha);
  const dist = path.join(dir, 'dist');
  const marker = path.join(dir, 'complete.json');
  const done = existsSync(marker) && (JSON.parse(readFileSync(marker, 'utf8')) as { version?: number }).version === TREE_VERSION;
  if (done) {
    o.log(`showdown: reusing transpiled tree ${o.sha.slice(0, 7)}`);
    return dist;
  }
  // Keep only the tree being built; older commits are never needed again.
  if (existsSync(cacheRoot)) for (const entry of readdirSync(cacheRoot)) rmSync(path.join(cacheRoot, entry), { recursive: true, force: true });
  const started = Date.now();
  const zip = await o.http.bytes(sourceZipUrl(o.sha), { timeoutMs: 180_000, ttlHours: 24 * 30, fixture: `showdown/source-${o.sha}` });
  const files = extractSources(zip);
  const count = await transpileTree(files, dist);
  writeFileSync(marker, JSON.stringify({ version: TREE_VERSION, sha: o.sha, files: count }));
  o.log(`showdown: transpiled ${count} files of ${o.sha.slice(0, 7)} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  return dist;
}

const run = promisify(execFile);

/** Run export.ts on a transpiled tree in a child process with no inherited environment. */
export async function exportDex(dist: string, request: ExportRequest, sha: string): Promise<RawDexExport> {
  const work = path.dirname(dist);
  const requestFile = path.join(work, 'request.json');
  const outFile = path.join(work, 'export.json');
  writeFileSync(requestFile, JSON.stringify(request));
  rmSync(outFile, { force: true });
  const env: Record<string, string> = { NODE_ENV: 'production' };
  // Windows needs these to start a process at all; nothing else (no tokens) is passed on.
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT']) {
    const v = process.env[key];
    if (v) env[key] = v;
  }
  try {
    await run(process.execPath, [EXPORT_SCRIPT, dist, outFile, requestFile, sha], { env, cwd: work, timeout: 300_000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  } catch (err) {
    const e = err as Error & { stderr?: string };
    const tail = (e.stderr ?? '').trim().split('\n').slice(-6).join(' | ');
    throw new Error(`dex exporter failed: ${tail || e.message}`, { cause: err });
  }
  return parseData(RawDexExportSchema, JSON.parse(readFileSync(outFile, 'utf8')), `showdown export of ${sha.slice(0, 7)}`, { roundTrip: false });
}
