/**
 * Class B/C data between workflow jobs. B (Heroes Profile) and C (Twitch/YouTube) data is never
 * committed (SPEC §1.2); it travels from a data job to the build job as a short-lived workflow
 * artifact. Artifacts of a public repository can be downloaded by any signed-in user, so class-B
 * files are only packed when DATA_ARTIFACT_KEY is set (AES-256-GCM); without the key they are
 * left out and the site simply builds without them.
 *
 *   node pipeline/private.ts pack    --dir data/private/hots --out private-hots.wsb
 *   node pipeline/private.ts unpack  --in private-hots.wsb --dir data/private/hots
 *   node pipeline/private.ts purge   --dir data/private --custody B
 *   node pipeline/private.ts restore --repo owner/name --games hots,mtga,pokemon --dir data/private
 *
 * `purge` is the HP_MODE=off kill switch for the build job: it deletes class-B files (by the
 * _files.json custody index; a game directory without an index is removed entirely).
 * `restore` downloads the newest unexpired private-<game> artifact produced by a scheduled or
 * dispatched data-deploy run of this repository (never a fork or PR run) and unpacks it.
 */
import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';
import type { CustodyClass } from '../src/core/game.ts';
import { compareStrings } from './hash.ts';
import { FILE_INDEX, buildFileIndex, isCustody, type FileIndex } from './manifest.ts';
import { gzipDeterministic, isSafeRelPath, listFiles, readJson, removeTree, resolveRel, syncTree, writeJsonFile } from './store.ts';

const MAGIC = 'WSB1';
const FLAG_PLAIN = 0;
const FLAG_ENCRYPTED = 1;

export interface PackResult {
  bytes: Uint8Array | null;
  included: string[];
  dropped: string[];
  encrypted: boolean;
}

function deriveKey(secret: string, salt: Uint8Array): Buffer {
  return scryptSync(secret, salt, 32);
}

/** Pack a private/<game> directory. Returns bytes=null when there is nothing to ship. */
export function packDir(dir: string, secret?: string): PackResult {
  const all = listFiles(dir).filter((rel) => rel !== FILE_INDEX);
  if (all.length === 0) return { bytes: null, included: [], dropped: [], encrypted: false };
  const index = readJson<FileIndex>(path.join(dir, FILE_INDEX));
  const custodyOf = (rel: string): CustodyClass | null => {
    const c = index?.files[rel]?.custody;
    return isCustody(c) ? c : null;
  };
  const key = secret?.trim() || undefined;
  // Without a key only files positively known to be class C may leave the runner.
  const included = all.filter((rel) => key !== undefined || custodyOf(rel) === 'C');
  const dropped = all.filter((rel) => !included.includes(rel));
  if (included.length === 0) return { bytes: null, included, dropped, encrypted: false };

  const files: Record<string, string> = {};
  const indexInput: Array<{ path: string; bytes: Uint8Array; custody: CustodyClass }> = [];
  for (const rel of included) {
    const bytes = new Uint8Array(readFileSync(resolveRel(dir, rel)));
    files[rel] = Buffer.from(bytes).toString('base64');
    indexInput.push({ path: rel, bytes, custody: custodyOf(rel) ?? 'B' });
  }
  const payload = gzipDeterministic(new TextEncoder().encode(JSON.stringify({ schema: 1, index: buildFileIndex(indexInput), files })));

  if (!key) {
    return { bytes: Buffer.concat([Buffer.from(MAGIC), Buffer.from([FLAG_PLAIN]), payload]), included, dropped, encrypted: false };
  }
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(key, salt), iv);
  const body = Buffer.concat([cipher.update(payload), cipher.final()]);
  const bytes = Buffer.concat([Buffer.from(MAGIC), Buffer.from([FLAG_ENCRYPTED]), salt, iv, cipher.getAuthTag(), body]);
  return { bytes: new Uint8Array(bytes), included, dropped, encrypted: true };
}

/** Decode a bundle into relative path → bytes. Encrypted bundles need the key (and are authenticated). */
export function unpackBundle(bundle: Uint8Array, secret?: string): Map<string, Uint8Array> {
  const buf = Buffer.from(bundle);
  if (buf.subarray(0, 4).toString('latin1') !== MAGIC) throw new Error('Not a Whetstone private bundle');
  const flag = buf[4];
  let payload: Buffer;
  if (flag === FLAG_PLAIN) payload = buf.subarray(5);
  else if (flag === FLAG_ENCRYPTED) {
    const key = secret?.trim();
    if (!key) throw new Error('Bundle is encrypted; set DATA_ARTIFACT_KEY');
    const salt = buf.subarray(5, 21);
    const iv = buf.subarray(21, 33);
    const tag = buf.subarray(33, 49);
    const decipher = createDecipheriv('aes-256-gcm', deriveKey(key, salt), iv);
    decipher.setAuthTag(tag);
    payload = Buffer.concat([decipher.update(buf.subarray(49)), decipher.final()]);
  } else throw new Error(`Unknown bundle flag ${flag}`);
  const parsed = JSON.parse(gunzipSync(payload).toString('utf8')) as { schema: number; index: FileIndex; files: Record<string, string> };
  const out = new Map<string, Uint8Array>();
  for (const rel of Object.keys(parsed.files).sort(compareStrings)) {
    if (!isSafeRelPath(rel) || rel === FILE_INDEX) throw new Error(`Bundle contains an invalid path ${JSON.stringify(rel)}`);
    out.set(rel, new Uint8Array(Buffer.from(parsed.files[rel] as string, 'base64')));
  }
  out.set(FILE_INDEX, new TextEncoder().encode(JSON.stringify(parsed.index, null, 2) + '\n'));
  return out;
}

/** Replace `dir` with the bundle's files. */
export function unpackTo(bundle: Uint8Array, dir: string, secret?: string): string[] {
  const files = unpackBundle(bundle, secret);
  removeTree(dir);
  syncTree(dir, files);
  return [...files.keys()].filter((rel) => rel !== FILE_INDEX);
}

/**
 * Delete files of the given custody classes. `dir` is either one game's private directory (has
 * _files.json) or the private root containing one directory per game.
 */
export function purge(dir: string, classes: readonly CustodyClass[]): string[] {
  if (!existsSync(dir)) return [];
  const gameDirs = existsSync(path.join(dir, FILE_INDEX))
    ? [dir]
    : readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => path.join(dir, e.name));
  const removed: string[] = [];
  for (const gameDir of gameDirs) {
    const index = readJson<FileIndex>(path.join(gameDir, FILE_INDEX));
    if (!index) {
      // Unknown custody: fail closed.
      removed.push(...listFiles(gameDir).map((rel) => `${path.basename(gameDir)}/${rel}`));
      removeTree(gameDir);
      continue;
    }
    const keep = new Map<string, Uint8Array>();
    const keptIndex: Array<{ path: string; bytes: Uint8Array; custody: CustodyClass }> = [];
    for (const rel of listFiles(gameDir)) {
      if (rel === FILE_INDEX) continue;
      const custody = index.files[rel]?.custody;
      if (!isCustody(custody) || classes.includes(custody)) {
        removed.push(`${path.basename(gameDir)}/${rel}`);
        continue;
      }
      const bytes = new Uint8Array(readFileSync(resolveRel(gameDir, rel)));
      keep.set(rel, bytes);
      keptIndex.push({ path: rel, bytes, custody });
    }
    if (keep.size === 0) {
      removeTree(gameDir);
      continue;
    }
    syncTree(gameDir, keep, (rel) => rel === FILE_INDEX);
    writeJsonFile(path.join(gameDir, FILE_INDEX), buildFileIndex(keptIndex));
  }
  return removed.sort(compareStrings);
}

export interface RestoreOptions {
  repo: string;
  games: readonly string[];
  dir: string;
  secret?: string | undefined;
  /** Ignore artifacts older than this (C-class retention, SPEC §1.2). */
  maxAgeHours?: number;
  workflowPath?: string;
  now?: Date;
  /** Runs the gh CLI and returns stdout (injectable for tests). */
  gh?: (args: string[]) => string;
  log?: (line: string) => void;
}

interface ArtifactRow {
  id: number;
  name: string;
  expired: boolean;
  created_at: string;
  workflow_run?: { id: number; repository_id: number; head_repository_id: number; head_branch: string };
}

const defaultGh = (args: string[]): string => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export function restore(o: RestoreOptions): Record<string, number | null> {
  const gh = o.gh ?? defaultGh;
  const log = o.log ?? ((line: string) => console.log(line));
  const now = (o.now ?? new Date()).getTime();
  const maxAgeMs = (o.maxAgeHours ?? 24) * 3_600_000;
  const workflowPath = o.workflowPath ?? '.github/workflows/data-deploy.yml';
  const result: Record<string, number | null> = {};
  for (const game of o.games) {
    result[game] = null;
    const name = `private-${game}`;
    const list = JSON.parse(gh(['api', `repos/${o.repo}/actions/artifacts?name=${name}&per_page=20`])) as { artifacts: ArtifactRow[] };
    const rows = [...list.artifacts].sort((a, b) => compareStrings(b.created_at, a.created_at));
    for (const a of rows) {
      if (a.expired || a.name !== name || !a.workflow_run) continue;
      if (now - Date.parse(a.created_at) > maxAgeMs) break;
      const wr = a.workflow_run;
      if (wr.head_repository_id !== wr.repository_id) continue;
      const run = JSON.parse(gh(['api', `repos/${o.repo}/actions/runs/${wr.id}`])) as { path?: string; event?: string };
      if (!run.path?.startsWith(workflowPath) || (run.event !== 'schedule' && run.event !== 'workflow_dispatch')) continue;
      const tmp = mkdtempSync(path.join(tmpdir(), 'whetstone-private-'));
      try {
        gh(['run', 'download', String(wr.id), '-R', o.repo, '-n', name, '-D', tmp]);
        const file = path.join(tmp, `${name}.wsb`);
        if (!existsSync(file)) {
          log(`[private] ${game}: artifact of run ${wr.id} has no ${name}.wsb; skipped`);
          continue;
        }
        const restored = unpackTo(new Uint8Array(readFileSync(file)), path.join(o.dir, game), o.secret);
        log(`[private] ${game}: restored ${restored.length} file(s) from run ${wr.id} (${a.created_at})`);
        result[game] = wr.id;
      } finally {
        removeTree(tmp);
      }
      break;
    }
    if (result[game] === null) log(`[private] ${game}: no usable private artifact; building without B/C data`);
  }
  return result;
}

function cli(argv: string[], env: NodeJS.ProcessEnv): number {
  const [command, ...rest] = argv;
  const { values } = parseArgs({
    args: rest,
    options: {
      dir: { type: 'string' },
      out: { type: 'string' },
      in: { type: 'string' },
      custody: { type: 'string', default: 'B' },
      repo: { type: 'string' },
      games: { type: 'string', default: 'hots,mtga,pokemon' },
      'max-age-hours': { type: 'string', default: '24' },
    },
    strict: true,
  });
  const secret = env.DATA_ARTIFACT_KEY;
  const warn = (msg: string): void => {
    console.log(env.GITHUB_ACTIONS === 'true' ? `::warning title=private data::${msg}` : `warning: ${msg}`);
  };
  switch (command) {
    case 'pack': {
      if (!values.dir || !values.out) throw new Error('pack needs --dir and --out');
      const r = packDir(values.dir, secret);
      if (r.dropped.length > 0) warn(`not shipped without DATA_ARTIFACT_KEY: ${r.dropped.join(', ')}`);
      if (!r.bytes) {
        console.log(`[private] nothing to pack in ${values.dir}`);
        return 0;
      }
      writeFileSync(values.out, r.bytes);
      console.log(`[private] packed ${r.included.length} file(s) into ${values.out}${r.encrypted ? ' (encrypted)' : ''}`);
      return 0;
    }
    case 'unpack': {
      if (!values.in || !values.dir) throw new Error('unpack needs --in and --dir');
      const files = unpackTo(new Uint8Array(readFileSync(values.in)), values.dir, secret);
      console.log(`[private] unpacked ${files.length} file(s) into ${values.dir}`);
      return 0;
    }
    case 'purge': {
      if (!values.dir) throw new Error('purge needs --dir');
      const classes = values.custody.split(',').map((s) => s.trim());
      if (!classes.every(isCustody)) throw new Error(`Invalid --custody ${values.custody}`);
      const removed = purge(values.dir, classes as CustodyClass[]);
      console.log(`[private] purged ${removed.length} file(s) of class ${classes.join('/')}${removed.length ? `: ${removed.join(', ')}` : ''}`);
      return 0;
    }
    case 'restore': {
      if (!values.repo || !values.dir) throw new Error('restore needs --repo and --dir');
      restore({ repo: values.repo, games: values.games.split(',').map((s) => s.trim()).filter(Boolean), dir: values.dir, secret, maxAgeHours: Number(values['max-age-hours']) });
      return 0;
    }
    default:
      console.error('Usage: node pipeline/private.ts pack|unpack|purge|restore [options]');
      return 2;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = cli(process.argv.slice(2), process.env);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
