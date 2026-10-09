/**
 * Stage browser-fetched data into public/ before `astro build` (SPEC §3).
 *
 *   node pipeline/stage.ts
 *
 * Per game, from the same data directory src/lib/datadir.ts resolves
 * ($WHETSTONE_DATA_DIR/current/<game>, then data/current/<game> unless WHETSTONE_FIXTURES=1, then
 * fixtures/<game>; private files pair with it, see resolveDataDirs):
 *  - <dir>/public/** and <privateDir>/public/** → public/data/<game>/<name>.<hash8>.<ext>
 *  - <dir>/img/**                              → public/data/<game>/img/** (unchanged names)
 *  - src/generated/stage-map.json  { "<game>/<name>": "data/<game>/<name>.<hash8>.<ext>" }
 *  - public/data/manifest.json     version, generatedAt, dataHash and the documented public
 *    shards of each game. Private (B/C) shards and shards whose file name starts with "_"
 *    (internal assets, e.g. a card index that must not be advertised as a dataset) are staged
 *    and mapped but never listed in the manifest.
 *
 * Overlay: when private/<game>/public/<name>.json exists next to current/<game>/public/<name>.json
 * (e.g. a class-B "stats" block for the HotS draft shard), the site gets their shallow merge
 * (top-level keys must not overlap), while the manifest keeps pointing at the pure class-A file,
 * which is staged as well. The public manifest never points at a file containing licensed data.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GameId, GameMeta } from '../src/core/game.ts';
import { compareStrings, jsonBytes, shortHash } from './hash.ts';
import {
  FILE_INDEX,
  GAME_IDS,
  META_FILE,
  custodyOf,
  isCommittable,
  type FileIndex,
  type PublicManifest,
  type PublicManifestFile,
} from './manifest.ts';
import { copyTree, listFiles, readJson, removeTree, resolveRel } from './store.ts';

export interface DataDirs {
  dir: string | null;
  privateDir: string | null;
  fixtures: boolean;
}

/**
 * Mirrors src/lib/datadir.ts (gameDataDir / gamePrivateDir) with an explicit root and env:
 * WHETSTONE_DATA_DIR, then data/ (skipped when WHETSTONE_FIXTURES=1), then fixtures/. The private
 * directory pairs with the chosen one: <dataRoot>/private/<game>, or for fixtures
 * fixtures/<game>/_private when WHETSTONE_FIXTURE_PRIVATE=1, so a fixture build can exercise the
 * class-B overlays (the HotS draft shard's synthetic `stats` block) exactly as a real build does.
 */
export function resolveDataDirs(root: string, game: GameId, env: Readonly<Record<string, string | undefined>>): DataDirs {
  const custom = env.WHETSTONE_DATA_DIR;
  const fixturesDir = path.join(root, 'fixtures', game);
  const dataRoots = [...(custom ? [path.resolve(root, custom)] : []), ...(env.WHETSTONE_FIXTURES === '1' ? [] : [path.join(root, 'data')])];
  const dataRoot = dataRoots.find((r) => existsSync(path.join(r, 'current', game, META_FILE)));
  if (dataRoot) {
    const privateDir = path.join(dataRoot, 'private', game);
    return { dir: path.join(dataRoot, 'current', game), privateDir: existsSync(privateDir) ? privateDir : null, fixtures: false };
  }
  if (!existsSync(path.join(fixturesDir, META_FILE))) return { dir: null, privateDir: null, fixtures: false };
  const fixturePrivate = path.join(fixturesDir, '_private');
  const privateDir = env.WHETSTONE_FIXTURE_PRIVATE === '1' && existsSync(fixturePrivate) ? fixturePrivate : null;
  return { dir: fixturesDir, privateDir, fixtures: true };
}

export interface StageOptions {
  root: string;
  env?: Readonly<Record<string, string | undefined>>;
  games?: readonly GameId[];
  log?: (line: string) => void;
}

export interface StageResult {
  map: Record<string, string>;
  manifest: PublicManifest;
  /** Staged files relative to public/ (POSIX). */
  files: string[];
}

function splitName(rel: string): { name: string; ext: string } {
  const slash = rel.lastIndexOf('/');
  const dot = rel.lastIndexOf('.');
  return dot > slash + 1 ? { name: rel.slice(0, dot), ext: rel.slice(dot) } : { name: rel, ext: '' };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Shallow merge of a private overlay into a public JSON object shard; keys may not overlap. */
export function overlay(key: string, publicBytes: Uint8Array, privateBytes: Uint8Array): Uint8Array {
  const decode = (b: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(b));
  const base = decode(publicBytes);
  const extra = decode(privateBytes);
  if (!isPlainObject(base) || !isPlainObject(extra)) throw new Error(`[stage] ${key}: an overlay needs JSON objects in both current/ and private/`);
  const clash = Object.keys(extra).filter((k) => k in base);
  if (clash.length > 0) throw new Error(`[stage] ${key}: private overlay would replace public keys (${clash.join(', ')})`);
  return jsonBytes({ ...base, ...extra }, false);
}

function sortedRecord<T>(rec: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of Object.keys(rec).sort(compareStrings)) out[k] = rec[k] as T;
  return out;
}

export function stage(opts: StageOptions): StageResult {
  const env = opts.env ?? process.env;
  const log = opts.log ?? ((line: string) => console.log(line));
  const publicDir = path.join(opts.root, 'public');
  const publicData = path.join(publicDir, 'data');
  removeTree(publicData);

  const map: Record<string, string> = {};
  const manifest: PublicManifest = { schema: 1, games: {} };
  const staged: string[] = [];

  for (const game of opts.games ?? GAME_IDS) {
    const { dir, privateDir, fixtures } = resolveDataDirs(opts.root, game, env);
    if (!dir) {
      log(`[stage] ${game}: no data found (no meta.json in WHETSTONE_DATA_DIR, data/current or fixtures); skipped`);
      continue;
    }
    const meta = readJson<GameMeta>(path.join(dir, META_FILE)) as GameMeta;
    const index = readJson<FileIndex>(path.join(dir, FILE_INDEX));
    const outDir = path.join(publicData, game);
    const files: Record<string, PublicManifestFile> = {};
    const emit = (name: string, ext: string, bytes: Uint8Array): string => {
      const hashed = `${name}.${shortHash(bytes)}${ext}`;
      const target = resolveRel(outDir, hashed);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, bytes);
      const url = `data/${game}/${hashed}`;
      staged.push(url);
      return url;
    };
    const read = (base: string): Map<string, Uint8Array> => new Map(listFiles(base).map((rel) => [rel, new Uint8Array(readFileSync(resolveRel(base, rel)))]));
    const pub = read(path.join(dir, 'public'));
    const priv = privateDir ? read(path.join(privateDir, 'public')) : new Map<string, Uint8Array>();
    const keyOwner = new Map<string, string>();

    for (const rel of [...new Set([...pub.keys(), ...priv.keys()])].sort(compareStrings)) {
      const { name, ext } = splitName(rel);
      const key = `${game}/${name}`;
      if (keyOwner.has(key)) throw new Error(`[stage] ${keyOwner.get(key)} and ${rel} both map to ${key}`);
      keyOwner.set(key, rel);
      const a = pub.get(rel);
      const b = priv.get(rel);
      if (a) {
        const url = emit(name, ext, a);
        map[key] = url;
        const internal = name.split('/').at(-1)?.startsWith('_') ?? false;
        const custody = custodyOf(index, `public/${rel}`, 'A');
        if (!internal && isCommittable(custody)) files[name] = { url, custody };
      }
      if (b) map[key] = emit(name, ext, a ? overlay(key, a, b) : b);
    }
    for (const rel of copyTree(path.join(dir, 'img'), path.join(outDir, 'img'))) staged.push(`data/${game}/img/${rel}`);

    manifest.games[game] = {
      version: meta.version,
      generatedAt: meta.generatedAt,
      dataHash: meta.dataHash,
      fixtures,
      sources: meta.sources,
      counts: meta.counts,
      files: sortedRecord(files),
    };
    const from = path.relative(opts.root, dir).split(path.sep).join('/');
    const mapped = Object.keys(map).filter((k) => k.startsWith(`${game}/`)).length;
    log(`[stage] ${game}: ${Object.keys(files).length} documented shard(s), ${mapped} mapped, from ${from}${privateDir ? ' + private' : ''}`);
  }

  mkdirSync(publicData, { recursive: true });
  writeFileSync(path.join(publicData, 'manifest.json'), jsonBytes(manifest, true));
  const mapFile = path.join(opts.root, 'src', 'generated', 'stage-map.json');
  mkdirSync(path.dirname(mapFile), { recursive: true });
  writeFileSync(mapFile, jsonBytes(sortedRecord(map), true));
  return { map: sortedRecord(map), manifest, files: staged.sort(compareStrings) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const result = stage({ root });
    console.log(`[stage] ${result.files.length} file(s) staged into public/data; map: src/generated/stage-map.json`);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  }
}
