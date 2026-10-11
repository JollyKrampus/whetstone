/**
 * Data pipeline runner (SPEC §4, §10).
 *
 *   node pipeline/run.ts [--game <id>|all] [--offline] [--out data] [--only src1,src2]
 *                        [--now 2026-10-08T10:17:00Z] [--history-max-kb 64] [--no-history]
 *
 * For each game: lazily import src/games/<game>/pipeline/index.ts (`export const pipeline`), run
 * it, and then either
 *  - on any `error` issue: leave current/<game> and private/<game> untouched (last-good), record
 *    the failure in status.json and exit non-zero after the remaining games ran; or
 *  - write class A/A-SA files to <out>/current/<game>/ and B/C to <out>/private/<game>/, delete
 *    files the game no longer emits, write meta.json (+ dataHash), the _files.json custody
 *    index and a history summary.
 *
 * img/ rule: images are expensive to regenerate, so games only emit img/** when their asset
 * source changes. If a run emits no img/** file, the existing img/ tree is kept as is. If it
 * emits any img/** file, the emitted set is treated as complete and stale images are removed.
 *
 * private/<game> is replaced wholesale on every successful run: B/C data is fetched fresh and
 * never carried over (SPEC §1.2).
 */
import { appendFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type {
  CustodyClass,
  DataPipeline,
  GameId,
  GameMeta,
  Http,
  OutputFile,
  PipelineResult,
  SourceStatus,
  ValidationIssue,
} from '../src/core/game.ts';
import { bearerTokens, createContext, gameDirs } from './context.ts';
import { compareStrings, hashTree, jsonBytes, sha256 } from './hash.ts';
import { createHttp } from './http.ts';
import {
  FILE_INDEX,
  GAME_IDS,
  IMG_DIR,
  META_FILE,
  RESERVED_PATHS,
  STATUS_FILE,
  buildFileIndex,
  isCommittable,
  isCustody,
  isGameId,
  mergeStatus,
  metaForHash,
  type GameStatus,
  type IndexInput,
  type StatusFile,
} from './manifest.ts';
import {
  gzipDeterministic,
  isSafeRelPath,
  listFiles,
  readBytes,
  readJson,
  removeTree,
  resolveRel,
  serializeOutput,
  syncTree,
  utcParts,
  writeIfChanged,
  writeJsonFile,
} from './store.ts';

/** git hosts refuse files over 100 MB; stay well below. */
const MAX_FILE_BYTES = 95 * 1024 * 1024;
const WARN_FILE_BYTES = 10 * 1024 * 1024;
const MAX_STATUS_ISSUES = 50;

export interface RunOptions {
  /** Repo root (for src/games/<game>/pipeline and fixtures). */
  root: string;
  /** Absolute data directory (holds current/, private/, history/, status.json). */
  out: string;
  games: readonly GameId[];
  offline?: boolean;
  only?: readonly string[] | null;
  env?: Readonly<Record<string, string | undefined>>;
  now?: Date;
  history?: { enabled: boolean; maxBytes: number };
  loadPipeline?: (game: GameId, root: string) => Promise<DataPipeline | null>;
  httpFor?: (game: GameId, log: (msg: string) => void) => Http;
  print?: (line: string) => void;
}

export interface GameReport {
  game: GameId;
  status: GameStatus;
  /** dataHash of the data that was live before this run. */
  previousHash: string | null;
  /** Full issue list (status.json keeps at most MAX_STATUS_ISSUES). */
  issues: ValidationIssue[];
}

export interface RunSummary {
  reports: GameReport[];
  status: StatusFile;
  exitCode: number;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Default loader: src/games/<game>/pipeline/index.ts exporting `pipeline`, or null when absent. */
export async function loadGamePipeline(game: GameId, root: string): Promise<DataPipeline | null> {
  const file = path.join(root, 'src', 'games', game, 'pipeline', 'index.ts');
  if (!existsSync(file)) return null;
  const mod = (await import(pathToFileURL(file).href)) as { pipeline?: DataPipeline };
  if (!mod.pipeline || typeof mod.pipeline.run !== 'function') {
    throw new Error(`${path.relative(root, file)} must export \`const pipeline: DataPipeline\``);
  }
  return mod.pipeline;
}

interface Checked {
  files: OutputFile[];
  issues: ValidationIssue[];
}

/** Structural checks the runner enforces regardless of game-level validation. */
export function checkResult(game: GameId, result: PipelineResult): Checked {
  const issues: ValidationIssue[] = [];
  const err = (m: string): void => {
    issues.push({ level: 'error', message: m });
  };
  const meta = result?.meta as Partial<GameMeta> | undefined;
  if (!meta || typeof meta !== 'object') err('result.meta is missing');
  else {
    if (meta.game !== game) err(`meta.game is ${JSON.stringify(meta.game)}, expected "${game}"`);
    if (typeof meta.schema !== 'number') err('meta.schema must be a number');
    if (!meta.version || typeof meta.version.label !== 'string') err('meta.version.label must be a string');
    if (!Array.isArray(meta.sources)) err('meta.sources must be an array');
    if (!meta.counts || typeof meta.counts !== 'object') err('meta.counts must be an object');
  }
  if (!Array.isArray(result?.issues)) err('result.issues must be an array');
  if (!Array.isArray(result?.files)) {
    err('result.files must be an array');
    return { files: [], issues };
  }

  const seen = new Set<string>();
  const files: OutputFile[] = [];
  for (const f of result.files) {
    if (!f || typeof f.path !== 'string' || !isSafeRelPath(f.path)) {
      err(`invalid output path ${JSON.stringify(f?.path)}`);
      continue;
    }
    if (RESERVED_PATHS.includes(f.path)) {
      err(`${f.path} is written by the runner; games must not emit it`);
      continue;
    }
    if (!isCustody(f.custody)) {
      err(`${f.path}: unknown custody class ${JSON.stringify(f.custody)}`);
      continue;
    }
    if (f.custody === 'P') {
      // Personal records live only in the private hub (SPEC §13.2); a public pipeline must never produce them.
      err(`${f.path}: class P (personal) data must never be emitted by a public pipeline`);
      continue;
    }
    // The same public/*.json path may exist once in current/ and once in private/: the private
    // copy is an overlay that stage.ts merges into the browser shard (e.g. HotS draft + B stats).
    const here = `${isCommittable(f.custody) ? 'current' : 'private'}:${f.path}`;
    const there = `${isCommittable(f.custody) ? 'private' : 'current'}:${f.path}`;
    const overlay = f.path.startsWith('public/') && f.path.endsWith('.json');
    if (seen.has(here) || (seen.has(there) && !overlay)) {
      err(`${f.path} is emitted more than once`);
      continue;
    }
    seen.add(here);
    if (f.bytes !== undefined && !(f.bytes instanceof Uint8Array)) {
      err(`${f.path}: bytes must be a Uint8Array`);
      continue;
    }
    if (f.bytes === undefined && f.data === undefined) {
      err(`${f.path}: neither data nor bytes given`);
      continue;
    }
    files.push(f);
  }
  return { files, issues };
}

/** Ids of sources whose latest fetch failed or went stale while the game itself succeeded. */
export function degradedSources(sources: readonly SourceStatus[]): string[] {
  return sources.filter((s) => s.status === 'failed' || s.status === 'stale').map((s) => s.id);
}

/** Source statuses to report when the run failed and last-good data stays live. */
export function failedSources(previous: GameMeta | null, result: PipelineResult | null, issues: readonly ValidationIssue[]): SourceStatus[] {
  const base = result?.meta?.sources ?? previous?.sources ?? [];
  const lastGood = new Map((previous?.sources ?? []).map((s) => [s.id, s]));
  return base.map((s) => {
    const failure = issues.find((i) => i.level === 'error' && i.source === s.id);
    const fetchedAt = lastGood.get(s.id)?.fetchedAt ?? null;
    if (failure) return { id: s.id, fetchedAt, status: 'failed', detail: failure.message };
    if (s.status === 'disabled') return { ...s };
    return { id: s.id, fetchedAt, status: 'stale', detail: 'run failed; last-good data kept' };
  });
}

interface WriteOutcome {
  meta: GameMeta;
  counts: { current: number; private: number };
}

function writeGame(out: string, game: GameId, result: PipelineResult, files: readonly OutputFile[], now: Date, history: Resolved['history']): WriteOutcome {
  const dirs = gameDirs(out, game);
  const current = new Map<string, Uint8Array>();
  const priv = new Map<string, Uint8Array>();
  const currentCustody = new Map<string, CustodyClass>();
  const privCustody = new Map<string, CustodyClass>();
  for (const f of files) {
    const bytes = serializeOutput(f);
    if (isCommittable(f.custody)) {
      current.set(f.path, bytes);
      currentCustody.set(f.path, f.custody);
    } else {
      priv.set(f.path, bytes);
      privCustody.set(f.path, f.custody);
    }
  }

  const emittedImg = [...current.keys()].some((p) => p.startsWith(IMG_DIR));
  syncTree(dirs.current, current, (rel) => RESERVED_PATHS.includes(rel) || (!emittedImg && rel.startsWith(IMG_DIR)));
  removeTree(dirs.private);
  if (priv.size > 0) syncTree(dirs.private, priv);

  // Hash what is actually on disk so kept img/ files count too.
  const currentEntries: IndexInput[] = listFiles(dirs.current)
    .filter((rel) => !RESERVED_PATHS.includes(rel))
    .map((rel) => ({ path: rel, bytes: readBytes(resolveRel(dirs.current, rel)) as Uint8Array, custody: currentCustody.get(rel) ?? 'A' }));
  const privEntries: IndexInput[] = [...priv.entries()].map(([rel, bytes]) => ({ path: rel, bytes, custody: privCustody.get(rel) as CustodyClass }));
  const dataHash = hashTree(
    [...currentEntries.map((e) => ({ path: `current/${e.path}`, bytes: e.bytes })), ...privEntries.map((e) => ({ path: `private/${e.path}`, bytes: e.bytes }))],
    metaForHash(result.meta),
  );
  const meta: GameMeta = { ...result.meta, generatedAt: now.toISOString(), dataHash };
  writeJsonFile(path.join(dirs.current, META_FILE), meta);
  const index = buildFileIndex(currentEntries);
  writeJsonFile(path.join(dirs.current, FILE_INDEX), index);
  if (privEntries.length > 0) writeJsonFile(path.join(dirs.private, FILE_INDEX), buildFileIndex(privEntries));

  if (history.enabled) writeHistory(out, game, now, meta, files, index.img, history.maxBytes);
  return { meta, counts: { current: currentEntries.length, private: privEntries.length } };
}

/**
 * history/YYYY/MM/DD/<game>.json.gz: meta plus the content of small class-A JSON files; other
 * public files are listed by hash only. A-SA content is never mixed into this (CC-BY-SA must stay
 * in separate files) and B/C never appear at all.
 */
export function writeHistory(
  out: string,
  game: GameId,
  now: Date,
  meta: GameMeta,
  files: readonly OutputFile[],
  img: { files: number; bytes: number; sha256: string } | undefined,
  maxBytes: number,
): string {
  const { yyyy, mm, dd } = utcParts(now);
  const content: Record<string, unknown> = {};
  const omitted: Record<string, { custody: CustodyClass; bytes: number; sha256: string }> = {};
  for (const f of [...files].sort((a, b) => compareStrings(a.path, b.path))) {
    if (!isCommittable(f.custody) || f.path.startsWith(IMG_DIR)) continue;
    const bytes = serializeOutput(f);
    const inline = f.custody === 'A' && f.bytes === undefined && !f.path.startsWith('public/') && bytes.byteLength <= maxBytes;
    if (inline) content[f.path] = f.data;
    else omitted[f.path] = { custody: f.custody, bytes: bytes.byteLength, sha256: sha256(bytes) };
  }
  const summary = { schema: 1, game, date: `${yyyy}-${mm}-${dd}`, meta, files: content, omitted, ...(img ? { img } : {}) };
  const file = path.join(out, 'history', yyyy, mm, dd, `${game}.json.gz`);
  writeIfChanged(file, gzipDeterministic(jsonBytes(summary, false)));
  return file;
}

interface Resolved {
  root: string;
  out: string;
  offline: boolean;
  only: readonly string[] | null;
  env: Readonly<Record<string, string | undefined>>;
  now: Date;
  history: { enabled: boolean; maxBytes: number };
  loadPipeline: (game: GameId, root: string) => Promise<DataPipeline | null>;
  httpFor: RunOptions['httpFor'];
}

async function processGame(game: GameId, o: Resolved, print: (line: string) => void): Promise<GameReport> {
  const started = Date.now();
  const dirs = gameDirs(o.out, game);
  const previous = readJson<GameMeta>(path.join(dirs.current, META_FILE));
  const countFiles = (): { current: number; private: number } => ({
    current: listFiles(dirs.current).filter((r) => !RESERVED_PATHS.includes(r)).length,
    private: listFiles(dirs.private).filter((r) => !RESERVED_PATHS.includes(r)).length,
  });
  const base = {
    checkedAt: o.now.toISOString(),
    generatedAt: previous?.generatedAt ?? null,
    dataHash: previous?.dataHash ?? null,
    changed: false,
  };
  const log = (msg: string, extra?: unknown): void => {
    let tail = '';
    if (extra !== undefined) {
      try {
        tail = ` ${JSON.stringify(extra)}`;
      } catch {
        tail = ` ${String(extra)}`;
      }
    }
    print(`[${game}] ${msg}${tail}`);
  };
  const fail = (issues: ValidationIssue[], result: PipelineResult | null, detail: string): GameReport => ({
    game,
    previousHash: previous?.dataHash ?? null,
    issues,
    status: {
      ...base,
      state: 'failed',
      durationMs: Date.now() - started,
      files: countFiles(),
      sources: failedSources(previous, result, issues),
      issues: issues.slice(0, MAX_STATUS_ISSUES),
      detail,
    },
  });

  let pipeline: DataPipeline | null;
  try {
    pipeline = await o.loadPipeline(game, o.root);
  } catch (err) {
    log(`could not load pipeline: ${message(err)}`);
    return fail([{ level: 'error', message: `could not load pipeline: ${message(err)}` }], null, 'pipeline module failed to load');
  }
  if (!pipeline) {
    log('no pipeline module yet (src/games/' + game + '/pipeline/index.ts); skipped');
    return {
      game,
      previousHash: previous?.dataHash ?? null,
      issues: [],
      status: { ...base, state: 'skipped', durationMs: 0, files: countFiles(), sources: previous?.sources ?? [], issues: [], detail: 'no pipeline module' },
    };
  }

  const http = o.httpFor
    ? o.httpFor(game, (m) => log(m))
    : createHttp({
        game,
        root: o.root,
        offline: o.offline,
        record: o.env.WHETSTONE_RECORD === '1',
        cache: o.env.CI !== 'true' && o.env.WHETSTONE_HTTP_CACHE !== '0',
        contact: o.env.WHETSTONE_CONTACT ?? o.env.LIQUIPEDIA_UA_CONTACT ?? '',
        bearer: bearerTokens(o.env),
        log: (m) => log(m),
      });
  const ctx = createContext({ game, root: o.root, out: o.out, http, env: o.env, now: o.now, offline: o.offline, only: o.only, log });

  let result: PipelineResult | null = null;
  const issues: ValidationIssue[] = [];
  try {
    result = await pipeline.run(ctx);
  } catch (err) {
    log(`pipeline threw: ${err instanceof Error && err.stack ? err.stack : message(err)}`);
    issues.push({ level: 'error', message: `pipeline threw: ${message(err)}` });
  }
  let files: OutputFile[] = [];
  if (result) {
    const checked = checkResult(game, result);
    issues.push(...(Array.isArray(result.issues) ? result.issues : []), ...checked.issues);
    files = checked.files;
    for (const f of files) {
      const size = serializeOutput(f).byteLength;
      if (size > MAX_FILE_BYTES) issues.push({ level: 'error', message: `${f.path} is ${size} bytes (limit ${MAX_FILE_BYTES})` });
      else if (size > WARN_FILE_BYTES) issues.push({ level: 'warn', message: `${f.path} is ${(size / 1048576).toFixed(1)} MB` });
    }
  }
  if (!result || issues.some((i) => i.level === 'error')) {
    return fail(issues, result, 'validation failed; last-good data kept');
  }

  const written = writeGame(o.out, game, result, files, o.now, o.history);
  const degraded = degradedSources(written.meta.sources);
  if (degraded.length > 0) log(`degraded sources (last-good data kept): ${degraded.join(', ')}`);
  return {
    game,
    previousHash: previous?.dataHash ?? null,
    issues,
    status: {
      state: 'ok',
      checkedAt: o.now.toISOString(),
      generatedAt: written.meta.generatedAt,
      dataHash: written.meta.dataHash,
      changed: written.meta.dataHash !== (previous?.dataHash ?? null),
      durationMs: Date.now() - started,
      files: written.counts,
      sources: written.meta.sources,
      issues: issues.slice(0, MAX_STATUS_ISSUES),
      ...(degraded.length > 0 ? { degraded } : {}),
    },
  };
}

export async function runPipelines(opts: RunOptions): Promise<RunSummary> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const o: Resolved = {
    root: opts.root,
    out: opts.out,
    offline: opts.offline ?? false,
    only: opts.only ?? null,
    env: opts.env ?? process.env,
    now: opts.now ?? new Date(),
    history: opts.history ?? { enabled: true, maxBytes: 64 * 1024 },
    loadPipeline: opts.loadPipeline ?? loadGamePipeline,
    httpFor: opts.httpFor,
  };
  const reports: GameReport[] = [];
  // Sequential on purpose: games share hosts (GitHub, Blizzard) and CI runs one game per job anyway.
  for (const game of opts.games) reports.push(await processGame(game, o, print));

  const statusPath = path.join(o.out, STATUS_FILE);
  const updates: Partial<Record<GameId, GameStatus>> = {};
  for (const r of reports) updates[r.game] = r.status;
  const status = mergeStatus(readJson<StatusFile>(statusPath), updates, o.now.toISOString());
  writeJsonFile(statusPath, status);

  const exitCode = reports.some((r) => r.status.state === 'failed') ? 1 : 0;
  return { reports, status, exitCode };
}

function escapeAnnotation(s: string): string {
  return s.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** Plain-text table for the console. */
export function formatSummary(reports: readonly GameReport[]): string {
  const rows = [['game', 'state', 'changed', 'current', 'private', 'issues', 'degraded', 'dataHash', 'time']];
  for (const r of reports) {
    const errors = r.issues.filter((i) => i.level === 'error').length;
    const warns = r.issues.length - errors;
    rows.push([
      r.game,
      r.status.state,
      r.status.changed ? 'yes' : 'no',
      String(r.status.files.current),
      String(r.status.files.private),
      `${errors}E ${warns}W`,
      r.status.degraded?.join(',') || '-',
      r.status.dataHash ? r.status.dataHash.slice(0, 12) : '-',
      `${(r.status.durationMs / 1000).toFixed(1)}s`,
    ]);
  }
  const widths = rows[0]!.map((_, c) => Math.max(...rows.map((row) => row[c]!.length)));
  return rows.map((row) => row.map((cell, c) => cell.padEnd(widths[c]!)).join('  ').trimEnd()).join('\n');
}

/** Lines for $GITHUB_OUTPUT: changed_<game>, changed (any), failed (comma list), degraded (game:source list). */
export function githubOutputs(reports: readonly GameReport[]): string[] {
  const lines = reports.map((r) => `changed_${r.game}=${r.status.changed}`);
  lines.push(`changed=${reports.some((r) => r.status.changed)}`);
  lines.push(`failed=${reports.filter((r) => r.status.state === 'failed').map((r) => r.game).join(',')}`);
  lines.push(`degraded=${reports.flatMap((r) => (r.status.degraded ?? []).map((id) => `${r.game}:${id}`)).join(',')}`);
  return lines;
}

const USAGE = `Usage: node pipeline/run.ts [--game ${GAME_IDS.join('|')}|all] [--offline] [--out data]
                           [--only sourceId,...] [--now ISO] [--history-max-kb 64] [--no-history]`;

function parseCli(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    options: {
      game: { type: 'string', default: 'all' },
      offline: { type: 'boolean', default: false },
      out: { type: 'string', default: 'data' },
      only: { type: 'string' },
      now: { type: 'string' },
      'history-max-kb': { type: 'string', default: '64' },
      'no-history': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  }).values;
}

export async function main(argv: readonly string[] = process.argv.slice(2), env: NodeJS.ProcessEnv = process.env): Promise<number> {
  let values: ReturnType<typeof parseCli>;
  try {
    values = parseCli(argv);
  } catch (err) {
    console.error(`${message(err)}\n${USAGE}`);
    return 2;
  }
  if (values.help) {
    console.log(USAGE);
    return 0;
  }
  const game = values.game;
  if (game !== 'all' && !isGameId(game)) {
    console.error(`Unknown game "${game}".\n${USAGE}`);
    return 2;
  }
  const now = values.now ? new Date(values.now) : new Date();
  if (Number.isNaN(now.getTime())) {
    console.error(`Invalid --now value "${values.now}"`);
    return 2;
  }
  const maxKb = Number(values['history-max-kb']);
  if (!Number.isFinite(maxKb) || maxKb < 0) {
    console.error(`Invalid --history-max-kb value "${values['history-max-kb']}"`);
    return 2;
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const dotenv = path.join(root, '.env');
  // Local convenience for optional credentials (e.g. YT_API_KEY); CI gets them from the workflow environment.
  if (env.CI !== 'true' && existsSync(dotenv)) process.loadEnvFile(dotenv);

  const summary = await runPipelines({
    root,
    out: path.resolve(process.cwd(), values.out),
    games: game === 'all' ? GAME_IDS : [game],
    offline: values.offline,
    only: values.only ? values.only.split(',').map((s) => s.trim()).filter(Boolean) : null,
    env,
    now,
    history: { enabled: !values['no-history'], maxBytes: Math.round(maxKb * 1024) },
  });

  const inActions = env.GITHUB_ACTIONS === 'true';
  for (const r of summary.reports) {
    for (const i of r.issues) {
      const where = i.source ? ` [${i.source}]` : '';
      if (inActions) console.log(`::${i.level === 'error' ? 'error' : 'warning'} title=${r.game}${escapeAnnotation(where)}::${escapeAnnotation(i.message)}`);
      else console.log(`[${r.game}] ${i.level}${where}: ${i.message}`);
    }
  }
  const table = formatSummary(summary.reports);
  console.log(`\n${table}`);
  if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, githubOutputs(summary.reports).join('\n') + '\n');
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `### Data pipeline\n\n\`\`\`\n${table}\n\`\`\`\n`);
  return summary.exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
