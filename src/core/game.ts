/**
 * Game-agnostic contracts shared by the pipeline (Node) and the site (Astro/Preact).
 * Browser-safe: types only, no runtime imports. See docs/SPEC.md §4.
 */

/** Every game the site ships, in display order. The single source of truth for game ids. */
export const GAME_IDS = ['hots', 'mtga', 'pokemon'] as const;

export type GameId = (typeof GAME_IDS)[number];

/**
 * Data custody class (SPEC §1.2, §13.2). A, A-SA and A-NC-SA are committed to the public data branch;
 * B, C and D are never committed (D, aggregates derived from public posts, is rebuilt every run);
 * P (personal) never leaves the private hub and must never be emitted by a public pipeline.
 */
export type CustodyClass = 'A' | 'A-SA' | 'A-NC-SA' | 'B' | 'C' | 'D' | 'P';

/** Where a source's credit must appear: same screen as its data, top of page, or footer. */
export type AttributionRule = 'inline' | 'top' | 'footer';

export interface SourceRef {
  id: string;
  name: string;
  url: string;
  /** Exact credit text shown to users. */
  attribution: string;
  rule: AttributionRule;
  license?: string;
  /** One-line summary of the terms that constrain how we use it. */
  tosNote?: string;
  custody: CustodyClass;
}

export type SourceState = 'ok' | 'stale' | 'failed' | 'disabled';

export interface SourceStatus {
  id: string;
  /** ISO timestamp of the last successful fetch (kept from last-good when stale). */
  fetchedAt: string | null;
  status: SourceState;
  detail?: string;
}

/** data/current/<game>/meta.json */
export interface GameMeta {
  game: GameId;
  schema: number;
  /** HotS { label: '2.57', build: '2.57.0.98348', since: '2026-09-28' }; Pokémon { label: 'Reg M-C' }; MTGA { label: set code }. */
  version: { label: string; build?: string; since?: string };
  generatedAt: string;
  dataHash: string;
  sources: SourceStatus[];
  counts: Record<string, number>;
  /** Game-specific extras (e.g. HotS ptrBuild, builds of the current major). */
  extra?: Record<string, unknown>;
}

export type ReasonKind = 'stat' | 'theory' | 'curated' | 'role' | 'map' | 'votes' | 'pro' | 'usage' | 'community' | 'personal';

/** A link to the public post or page a community reason was derived from (no quotes, no usernames). */
export interface Cite {
  url: string;
  /** Host or forum name shown next to the link, e.g. 'Blizzard forums'. */
  site: string;
  /** ISO date of the post. */
  date?: string;
}

/** One human-readable line explaining a score. */
export interface Reason {
  kind: ReasonKind;
  text: string;
  /** Sample size behind a stat reason. */
  n?: number;
  /** Effect in percentage points (stat reasons). */
  delta?: number;
  /** SourceRef.id */
  source?: string;
  /** Ability/talent/move names (etc.) that justified a theory tag. */
  evidence?: string[];
  /** Talents, choices or situations the reason depends on, rendered as "Only when …". */
  conditions?: string[];
  /** Public sources a community reason was derived from (at most 5). */
  cites?: Cite[];
}

export type EdgeSource = 'stats' | 'theory' | 'curated' | 'votes' | 'usage' | 'replays' | 'community' | 'personal';

/**
 * A scored relation between two entities.
 * Counters are directed (a counters b). Synergy is undirected and stored with a < b.
 */
export interface Edge {
  a: string;
  b: string;
  /** 1..100, 50 = neutral. */
  score: number;
  delta?: number;
  n?: number;
  z?: number;
  source: EdgeSource;
  reasons: Reason[];
}

export interface ValidationIssue {
  level: 'error' | 'warn';
  source?: string;
  message: string;
}

export interface OutputFile {
  /** Relative to data/current/<game>/ (A, A-SA) or data/private/<game>/ (B, C). Files under `public/` are staged for the browser. */
  path: string;
  data: unknown;
  custody: CustodyClass;
  /** Raw bytes instead of JSON (images). When set, `data` is ignored. */
  bytes?: Uint8Array;
}

export interface HttpResponse {
  status: number;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface Http {
  /** GET JSON with UA, retries/backoff, per-host spacing, dev disk cache, offline fixtures. */
  json<T = unknown>(url: string, init?: HttpInit): Promise<T>;
  text(url: string, init?: HttpInit): Promise<string>;
  bytes(url: string, init?: HttpInit): Promise<Uint8Array>;
  /** HEAD request; returns headers (lower-cased keys). */
  head(url: string, init?: HttpInit): Promise<Record<string, string>>;
  /**
   * The final response with its status and headers, for APIs that answer in statuses (202 jobs,
   * 429 quotas, rate-limit headers). Same User-Agent, per-host spacing, timeout, retries on
   * network errors and offline fixtures as the others, but it never throws on an HTTP status
   * and never retries one (the caller decides), skips the dev disk cache and is never recorded
   * as a fixture (licensed responses must not land in the repo).
   */
  request(url: string, init?: HttpInit): Promise<HttpResponse>;
}

export interface HttpInit {
  headers?: Record<string, string>;
  /** Minimum milliseconds between requests to the same host (default 250). */
  spacingMs?: number;
  /** Dev cache TTL in hours (ignored in CI). */
  ttlHours?: number;
  /** Fixture key used in --offline mode (defaults to a hash of the URL). */
  fixture?: string;
  method?: string;
  body?: string;
  timeoutMs?: number;
}

export interface PipelineContext {
  game: GameId;
  http: Http;
  /** Optional credentials and flags; modules must degrade gracefully when absent. */
  secrets: Readonly<Record<string, string | undefined>>;
  /** Last-good file from data/current/<game>/ (or data/private/<game>/ for B/C), parsed JSON, or null. */
  previous(path: string): Promise<unknown | null>;
  /** Last-good meta.json, or null on first run. */
  previousMeta: GameMeta | null;
  now: Date;
  offline: boolean;
  /** Repo root (absolute path). */
  root: string;
  log(msg: string, extra?: unknown): void;
}

export interface PipelineResult {
  meta: Omit<GameMeta, 'generatedAt' | 'dataHash'>;
  files: OutputFile[];
  issues: ValidationIssue[];
}

export interface DataPipeline {
  run(ctx: PipelineContext): Promise<PipelineResult>;
}

export interface NavItem {
  label: string;
  /** Relative to /<game>/, e.g. 'draft/'. Empty string = game home. */
  path: string;
}

/** Browser-safe game metadata. The pipeline lives in src/games/<id>/pipeline/index.ts and is imported lazily by pipeline/run.ts. */
export interface GameModule {
  id: GameId;
  name: string;
  short: string;
  tagline: string;
  status: 'live' | 'beta' | 'planned';
  /** CSS custom property name holding the game's accent colour, e.g. '--accent-hots'. */
  accent: string;
  sources: SourceRef[];
  nav: NavItem[];
}
