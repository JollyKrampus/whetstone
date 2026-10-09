/**
 * npm run data:pull — copy the published `data` branch into data/ so a local build uses real data:
 *   <remote>/data:current/<game>/** → data/current/<game>/**   (each game on the branch is replaced)
 *   <remote>/data:status.json       → data/status.json
 *
 *   node scripts/data-pull.ts [--remote origin] [--branch data] [--out data]
 *
 * The branch is fetched shallowly into a separate bare cache repository (.cache/data-branch.git)
 * and blobs are read with ls-tree + cat-file, so your own clone gets no new refs, no shallow
 * marker and no index or working-tree changes. Class B/C data is never on the branch; run
 * `npm run data` with your own keys to get it.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { removeTree, resolveRel } from '#pipeline/store.ts';

interface GitResult {
  status: number;
  stdout: Buffer;
  stderr: string;
}

function git(root: string, args: string[], input?: string): GitResult {
  const r = spawnSync('git', args, { cwd: root, input, maxBuffer: 1024 * 1024 * 1024 });
  if (r.error) throw r.error;
  return { status: r.status ?? 1, stdout: r.stdout, stderr: r.stderr.toString('utf8').trim() };
}

export interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  path: string;
}

/** Parse `git ls-tree -r -z` output. */
export function parseLsTree(out: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  for (const record of out.toString('utf8').split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    const [mode, type, sha] = record.slice(0, tab).split(' ');
    if (mode && type && sha) entries.push({ mode, type, sha, path: record.slice(tab + 1) });
  }
  return entries;
}

/** Parse `git cat-file --batch` output into sha → content. */
export function parseCatFileBatch(out: Buffer): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  let pos = 0;
  while (pos < out.length) {
    const nl = out.indexOf(0x0a, pos);
    if (nl < 0) break;
    const header = out.subarray(pos, nl).toString('utf8');
    const [sha, type, size] = header.split(' ');
    if (!sha || type === 'missing' || size === undefined) throw new Error(`git cat-file: unexpected header "${header}"`);
    const start = nl + 1;
    const end = start + Number(size);
    blobs.set(sha, out.subarray(start, end));
    pos = end + 1;
  }
  return blobs;
}

function main(): number {
  const { values } = parseArgs({
    options: {
      remote: { type: 'string', default: 'origin' },
      branch: { type: 'string', default: 'data' },
      out: { type: 'string', default: 'data' },
    },
    strict: true,
  });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const { remote, branch } = values;
  const out = path.resolve(process.cwd(), values.out);

  const remoteUrl = git(root, ['remote', 'get-url', remote]);
  if (remoteUrl.status !== 0) {
    console.log(`No git remote "${remote}" yet, so there is no published data to pull.`);
    console.log('Until the repo is on GitHub (docs/OWNER-ACTIONS.md), use `npm run data` (live) or `npm run data:offline` (recorded fixtures); the build falls back to fixtures/ automatically.');
    return 0;
  }
  const probe = git(root, ['ls-remote', '--exit-code', '--heads', remote, branch]);
  if (probe.status === 2) {
    console.log(`The remote "${remote}" has no "${branch}" branch yet. It is created by the first data-deploy run (docs/OWNER-ACTIONS.md).`);
    return 0;
  }
  if (probe.status !== 0) {
    console.error(`Could not reach "${remote}": ${probe.stderr}`);
    return 1;
  }

  const cache = path.join(root, '.cache', 'data-branch.git');
  if (!existsSync(cache)) {
    mkdirSync(path.dirname(cache), { recursive: true });
    const init = git(root, ['init', '--bare', '-q', cache]);
    if (init.status !== 0) {
      console.error(`git init failed: ${init.stderr}`);
      return 1;
    }
  }
  const inCache = (args: string[], input?: string): GitResult => git(root, [`--git-dir=${cache}`, ...args], input);
  const ref = `refs/heads/${branch}`;
  // Shallow: the branch keeps daily history snapshots that a local build does not need.
  const fetched = inCache(['fetch', '--depth=1', '--no-tags', '-q', remoteUrl.stdout.toString('utf8').trim(), `+${ref}:${ref}`]);
  if (fetched.status !== 0) {
    console.error(`git fetch failed: ${fetched.stderr}`);
    return 1;
  }
  const commit = inCache(['log', '-1', '--format=%h %cI', ref]).stdout.toString('utf8').trim();

  const tree = parseLsTree(inCache(['ls-tree', '-r', '-z', '--full-tree', ref, '--', 'current', 'status.json']).stdout).filter((e) => e.type === 'blob' && e.mode !== '120000');
  if (tree.length === 0) {
    console.log(`${remote}/${branch} (${commit}) has no current/ data yet.`);
    return 0;
  }
  const batch = git(root, ['cat-file', '--batch'], tree.map((e) => e.sha).join('\n') + '\n');
  if (batch.status !== 0) {
    console.error(`git cat-file failed: ${batch.stderr}`);
    return 1;
  }
  const blobs = parseCatFileBatch(batch.stdout);

  const games = [...new Set(tree.filter((e) => e.path.startsWith('current/')).map((e) => e.path.split('/')[1] as string))].sort();
  for (const game of games) removeTree(path.join(out, 'current', game));
  const counts = new Map<string, number>();
  for (const e of tree) {
    const target = resolveRel(out, e.path);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, blobs.get(e.sha) ?? Buffer.alloc(0));
    const game = e.path.startsWith('current/') ? (e.path.split('/')[1] as string) : null;
    if (game) counts.set(game, (counts.get(game) ?? 0) + 1);
  }
  console.log(`Pulled ${remote}/${branch} @ ${commit} into ${path.relative(process.cwd(), out) || '.'}/:`);
  for (const game of games) console.log(`  current/${game}: ${counts.get(game)} file(s)`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
