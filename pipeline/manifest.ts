/**
 * Shapes of the bookkeeping files the pipeline maintains next to game data:
 *  - `_files.json` in every current/<game>/ and private/<game>/ directory (custody index),
 *  - `<out>/status.json` (last run per game, committed to the data branch),
 *  - `public/data/manifest.json` (unhashed public manifest built by stage.ts).
 * See docs/DATA.md.
 */
import type { CustodyClass, GameId, GameMeta, SourceStatus, ValidationIssue } from '../src/core/game.ts';
import { compareStrings, sha256 } from './hash.ts';

export const GAME_IDS: readonly GameId[] = ['hots', 'mtga', 'pokemon'];
export const META_FILE = 'meta.json';
export const STATUS_FILE = 'status.json';
export const FILE_INDEX = '_files.json';
/** Paths the runner owns inside a game directory; games may not emit them. */
export const RESERVED_PATHS: readonly string[] = [META_FILE, FILE_INDEX];
/** Asset subtree with keep-unless-re-emitted semantics (see run.ts). */
export const IMG_DIR = 'img/';

export function isGameId(value: string): value is GameId {
  return (GAME_IDS as readonly string[]).includes(value);
}

export function isCustody(value: unknown): value is CustodyClass {
  return value === 'A' || value === 'A-SA' || value === 'B' || value === 'C';
}

/** A and A-SA live in current/ (public data branch); B and C only in private/. */
export function isCommittable(custody: CustodyClass): boolean {
  return custody === 'A' || custody === 'A-SA';
}

export interface FileIndexEntry {
  custody: CustodyClass;
  bytes: number;
  sha256: string;
}

export interface FileIndex {
  schema: 1;
  /** Every file except img/** (summarised below) and the runner's own files. */
  files: Record<string, FileIndexEntry>;
  /** Images are numerous and rarely change, so they are summarised rather than listed. */
  img?: { files: number; bytes: number; sha256: string };
}

export interface IndexInput {
  path: string;
  bytes: Uint8Array;
  custody: CustodyClass;
}

export function buildFileIndex(entries: readonly IndexInput[]): FileIndex {
  const files: Record<string, FileIndexEntry> = {};
  const img: IndexInput[] = [];
  for (const e of [...entries].sort((a, b) => compareStrings(a.path, b.path))) {
    if (RESERVED_PATHS.includes(e.path)) continue;
    if (e.path.startsWith(IMG_DIR)) {
      img.push(e);
      continue;
    }
    files[e.path] = { custody: e.custody, bytes: e.bytes.byteLength, sha256: sha256(e.bytes) };
  }
  const index: FileIndex = { schema: 1, files };
  if (img.length > 0) {
    index.img = {
      files: img.length,
      bytes: img.reduce((n, e) => n + e.bytes.byteLength, 0),
      sha256: sha256(img.map((e) => `${e.path}\0${sha256(e.bytes)}\n`).join('')),
    };
  }
  return index;
}

/** Custody of a path according to an index (img/** is class A by definition, SPEC §5). */
export function custodyOf(index: FileIndex | null, rel: string, fallback: CustodyClass): CustodyClass {
  if (rel.startsWith(IMG_DIR)) return 'A';
  return index?.files[rel]?.custody ?? fallback;
}

export type GameRunState = 'ok' | 'failed' | 'skipped';

export interface GameStatus {
  state: GameRunState;
  /** When this run looked at the game. */
  checkedAt: string;
  /** generatedAt / dataHash of the data that is now live in current/<game> (last good). */
  generatedAt: string | null;
  dataHash: string | null;
  /** True when this run produced a dataHash different from the previous one. */
  changed: boolean;
  durationMs: number;
  files: { current: number; private: number };
  sources: SourceStatus[];
  issues: ValidationIssue[];
  detail?: string;
}

export interface StatusFile {
  schema: 1;
  updatedAt: string;
  games: Partial<Record<GameId, GameStatus>>;
}

/** Merge per-game updates into an existing status file, keeping entries for games not run. */
export function mergeStatus(previous: StatusFile | null, updates: Partial<Record<GameId, GameStatus>>, updatedAt: string): StatusFile {
  const games: Partial<Record<GameId, GameStatus>> = {};
  for (const id of GAME_IDS) {
    const next = updates[id] ?? previous?.games?.[id];
    if (next) games[id] = next;
  }
  return { schema: 1, updatedAt, games };
}

/** meta.json content that participates in dataHash: timestamps and the hash itself are excluded. */
export function metaForHash(meta: Omit<GameMeta, 'generatedAt' | 'dataHash'>): unknown {
  return {
    ...meta,
    sources: meta.sources.map((s) => {
      const copy: Partial<SourceStatus> = { ...s };
      delete copy.fetchedAt;
      return copy;
    }),
  };
}

export interface PublicManifestFile {
  /** Site-relative URL (no leading slash), e.g. "data/hots/draft.1a2b3c4d.json". */
  url: string;
  custody: CustodyClass;
}

export interface PublicManifestGame {
  version: GameMeta['version'];
  generatedAt: string;
  dataHash: string;
  /** True when the build used committed fixtures instead of pipeline data. */
  fixtures: boolean;
  sources: SourceStatus[];
  counts: Record<string, number>;
  /** Documented class A / A-SA shards only. B/C and internal (`_`-prefixed) shards are never listed. */
  files: Record<string, PublicManifestFile>;
}

export interface PublicManifest {
  schema: 1;
  games: Partial<Record<GameId, PublicManifestGame>>;
}
