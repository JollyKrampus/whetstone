/**
 * npm run sync:grindstone [-- --from <dir>]
 *
 * Vendors grindstone-mcp's browser-safe core build (the `grindstone-mcp/core` export, v0.2.0+)
 * into vendor/grindstone/ until the package is published to npm (README → "grindstone-mcp").
 * Source: --from, else $GRINDSTONE_DIR, else ~/grindstone-mcp. The source repo is only read:
 * this script never builds it, runs npm in it, or takes git locks there.
 *
 * Copies dist/core.js (+ .map), dist/core.d.ts and any chunk files they import, rubric/*.json
 * and LICENSE, then writes VERSION (version, git SHA, dirty flag, dates) and a package.json
 * exposing "./core", so both `#vendor/grindstone/core.js` and a future
 * `"grindstone-mcp": "file:vendor/grindstone"`-style import resolve in Node and Vite.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { removeTree } from '#pipeline/store.ts';

/** Relative module specifiers imported by an ES module or declaration file (static, dynamic, re-export). */
export function relativeImports(source: string): string[] {
  const found = new Set<string>();
  const patterns = [/\bfrom\s*["'](\.{1,2}\/[^"']+)["']/g, /\bimport\s*\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)/g, /\bimport\s*["'](\.{1,2}\/[^"']+)["']/g];
  for (const re of patterns) for (const m of source.matchAll(re)) if (m[1]) found.add(m[1]);
  return [...found].sort();
}

/** dist-relative files reachable from the entry files through relative imports. */
export function collectDistFiles(dist: string, entries: readonly string[]): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length > 0) {
    const rel = queue.shift() as string;
    if (seen.has(rel)) continue;
    const abs = path.join(dist, rel);
    if (!existsSync(abs)) throw new Error(`grindstone dist is missing ${rel} (imported by the core build)`);
    seen.add(rel);
    for (const spec of relativeImports(readFileSync(abs, 'utf8'))) {
      let target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (target.startsWith('../')) throw new Error(`core build imports ${spec} from outside dist/`);
      if (rel.endsWith('.d.ts') && target.endsWith('.js')) target = target.replace(/\.js$/, '.d.ts');
      else if (rel.endsWith('.d.ts') && !/\.(d\.ts|js|mjs)$/.test(target)) target = `${target}.d.ts`;
      queue.push(target);
    }
  }
  return [...seen].sort();
}

/**
 * Inputs of the core build whose current content differs from what was bundled. core.js.map
 * embeds sourcesContent, so this is exact (mtimes are not: a commit after the build touches them).
 */
export function staleCoreInputs(from: string, dist: string): string[] {
  const mapFile = path.join(dist, 'core.js.map');
  if (!existsSync(mapFile)) return [];
  const map = JSON.parse(readFileSync(mapFile, 'utf8')) as { sources?: string[]; sourcesContent?: Array<string | null> };
  const norm = (t: string): string => t.replace(/\r\n/g, '\n');
  const stale: string[] = [];
  (map.sources ?? []).forEach((src, i) => {
    const bundled = map.sourcesContent?.[i];
    const abs = path.resolve(dist, src);
    if (typeof bundled !== 'string' || !existsSync(abs)) return;
    if (norm(readFileSync(abs, 'utf8')) !== norm(bundled)) stale.push(path.relative(from, abs).split(path.sep).join('/'));
  });
  return stale;
}

function gitRead(dir: string, args: string[]): string {
  // --no-optional-locks: `git status` must not refresh the other repo's index.
  return execFileSync('git', ['--no-optional-locks', '-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function main(): number {
  const { values } = parseArgs({ options: { from: { type: 'string' } }, strict: true });
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const from = path.resolve(values.from ?? process.env.GRINDSTONE_DIR ?? path.join(homedir(), 'grindstone-mcp'));
  const pkgPath = path.join(from, 'package.json');
  if (!existsSync(pkgPath)) {
    console.error(`No grindstone-mcp checkout at ${from}. Pass --from <dir> or set GRINDSTONE_DIR.`);
    return 1;
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string; exports?: Record<string, unknown> };
  if (pkg.name !== 'grindstone-mcp') {
    console.error(`${pkgPath} is "${pkg.name}", not grindstone-mcp.`);
    return 1;
  }
  if (!pkg.exports?.['./core']) {
    console.error(`grindstone-mcp ${pkg.version} has no "./core" export. Apply the core-export change (v0.2.0) in that repo first.`);
    return 1;
  }
  const dist = path.join(from, 'dist');
  if (!existsSync(path.join(dist, 'core.js'))) {
    console.error(`${path.join(dist, 'core.js')} not found. Build grindstone in its own repo first:\n  cd "${from}" && npm run build\n(this script never builds or modifies that repository).`);
    return 1;
  }

  const distFiles = collectDistFiles(dist, ['core.js', 'core.d.ts']);
  const withMaps = distFiles.flatMap((rel) => (rel.endsWith('.js') && existsSync(path.join(dist, `${rel}.map`)) ? [rel, `${rel}.map`] : [rel]));
  const rubrics = existsSync(path.join(from, 'rubric')) ? readdirSync(path.join(from, 'rubric')).filter((f) => f.endsWith('.json')).sort() : [];

  const sha = gitRead(from, ['rev-parse', 'HEAD']);
  const dirty = gitRead(from, ['status', '--porcelain']) !== '';
  const commitDate = gitRead(from, ['log', '-1', '--format=%cI', 'HEAD']);
  const stale = staleCoreInputs(from, dist);
  if (stale.length > 0) {
    console.warn(`warning: dist/core.js is older than its sources (${stale.join(', ')}); rebuild grindstone and sync again.`);
  }
  if (dirty) console.warn('warning: the grindstone working tree has uncommitted changes; VERSION records dirty=true.');

  const vendor = path.join(root, 'vendor', 'grindstone');
  removeTree(vendor);
  mkdirSync(path.join(vendor, 'rubric'), { recursive: true });
  for (const rel of withMaps) {
    const target = path.join(vendor, ...rel.split('/'));
    mkdirSync(path.dirname(target), { recursive: true });
    copyFileSync(path.join(dist, ...rel.split('/')), target);
  }
  for (const f of rubrics) copyFileSync(path.join(from, 'rubric', f), path.join(vendor, 'rubric', f));
  if (existsSync(path.join(from, 'LICENSE'))) copyFileSync(path.join(from, 'LICENSE'), path.join(vendor, 'LICENSE'));

  const version = {
    package: 'grindstone-mcp',
    version: pkg.version ?? '0.0.0',
    sha,
    dirty,
    commitDate,
    syncedAt: new Date().toISOString().slice(0, 10),
  };
  writeFileSync(path.join(vendor, 'VERSION'), JSON.stringify(version, null, 2) + '\n');
  const vendorPkg = {
    name: 'grindstone-mcp-core-vendored',
    version: version.version,
    private: true,
    license: 'MIT',
    type: 'module',
    sideEffects: false,
    exports: { './core': { types: './core.d.ts', import: './core.js' } },
  };
  writeFileSync(path.join(vendor, 'package.json'), JSON.stringify(vendorPkg, null, 2) + '\n');
  writeFileSync(
    path.join(vendor, 'README.md'),
    [
      '# vendor/grindstone',
      '',
      `Generated by \`npm run sync:grindstone\` from grindstone-mcp ${version.version} (${sha.slice(0, 7)}${dirty ? ', dirty' : ''}). Do not edit; re-run the sync instead.`,
      '',
      'Import it as `#vendor/grindstone/core.js`. It needs `zod` from the root package. MIT licensed (see LICENSE).',
      'Interim until grindstone-mcp is published to npm; then depend on `"grindstone-mcp": "^0.2.0"` and import `grindstone-mcp/core`.',
      '',
    ].join('\n'),
  );

  console.log(`Synced grindstone-mcp ${version.version} @ ${sha.slice(0, 7)}${dirty ? ' (dirty)' : ''} from ${from}`);
  console.log(`  dist: ${withMaps.join(', ')}`);
  console.log(`  rubric: ${rubrics.join(', ') || '(none)'}`);
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
