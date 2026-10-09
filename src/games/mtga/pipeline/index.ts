/**
 * MTG Arena data pipeline (SPEC §4, docs/DATA.md §4). Sources, in order:
 *
 *   scryfall       default_cards bulk data → public/_cards.{standard,arena}.json + sets.json
 *                  (skipped when Scryfall's updated_at and the grindstone version are unchanged)
 *   curated-meta   curated/mtga/meta/<format>.json, validated against the fresh card index
 *   17lands        public datasets for the newest Arena sets → limited/<SET>.<Format>.json
 *                  (each dataset gated on its S3 Last-Modified; runtime capped for the 30-minute job)
 *   grindstone-mcp the vendored engine whose aggregateCards built the shards (status only)
 *
 * Partial fallback: a source that fails keeps its last-good files (status `failed`, a warning);
 * only missing card data with nothing to fall back on is an error. `--only` is honoured: sources
 * that are not selected re-emit their last-good files.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { CardIndex } from '#vendor/grindstone/core.js';
import type { DataPipeline, OutputFile, PipelineContext, PipelineResult, SourceStatus, ValidationIssue } from '../../../core/game.ts';
import { isSelected } from '../../../../pipeline/context.ts';
import { checkCount, validateFiles } from '../../../../pipeline/validate.ts';
import {
  CardShardSchema,
  LimitedIndexSchema,
  LimitedRatingsSchema,
  MetaSnapshotSchema,
  MtgaMetaExtraSchema,
  MTGA_FILES,
  SetsFileSchema,
  hydrateCardRecord,
  limitedFile,
  type CardShard,
  type ConstructedFormat,
  type LimitedFormat,
  type LimitedIndex,
  type LimitedRatings,
  type MetaSnapshot,
  type MtgSet,
} from '../schema.ts';
import { loadCurated } from './curated.ts';
import { textLines } from './lines.ts';
import { SCRYFALL_BULK_URL, SCRYFALL_HEADERS, buildCardData, foldBulk, parseBulkInfo, versionOf, type CardData } from './scryfall.ts';
import {
  CARDS_CSV_URL,
  aggregateDrafts,
  aggregateGames,
  buildLimitedIndex,
  buildRatings,
  draftDataUrl,
  gameDataUrl,
  parseCardsCsv,
  type CardMeta,
} from './seventeenlands.ts';

/** Newest Arena sets with 17Lands data to publish. */
export const LIMITED_SET_COUNT = 2;
/** How many of the newest Arena sets to probe for 17Lands data before giving up. */
export const LIMITED_PROBES = 6;
/** Formats published per set, in processing priority. */
export const LIMITED_FORMATS: readonly LimitedFormat[] = ['PremierDraft', 'TradDraft', 'Sealed'];
/** Set types 17Lands publishes datasets for. */
const LIMITED_KINDS = new Set(['expansion', 'core', 'draft_innovation', 'masters']);
/** Wall-clock budget for the 17Lands step (the whole MTGA job has 30 minutes). */
export const LIMITED_BUDGET_MS = 18 * 60_000;
const BIG_DOWNLOAD_MS = 15 * 60_000;

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export interface GrindstoneVersion {
  version: string;
  sha: string;
}

export function readGrindstoneVersion(root: string): GrindstoneVersion {
  const raw = JSON.parse(readFileSync(path.join(root, 'vendor', 'grindstone', 'VERSION'), 'utf8')) as Partial<GrindstoneVersion>;
  if (typeof raw.version !== 'string' || typeof raw.sha !== 'string') throw new Error('vendor/grindstone/VERSION lacks version/sha');
  return { version: raw.version, sha: raw.sha };
}

function previousStatus(ctx: PipelineContext, id: string): SourceStatus | undefined {
  return ctx.previousMeta?.sources.find((s) => s.id === id);
}

function failedStatus(ctx: PipelineContext, id: string, detail: string): SourceStatus {
  return { id, fetchedAt: previousStatus(ctx, id)?.fetchedAt ?? null, status: 'failed', detail };
}

/**
 * Status of a source that was not fetched in this run (--only): exactly the previous status, so
 * re-emitting unchanged files never changes dataHash.
 */
function keptStatus(ctx: PipelineContext, id: string): SourceStatus {
  const prev = previousStatus(ctx, id);
  return prev ? { ...prev } : { id, fetchedAt: null, status: 'stale', detail: 'not fetched yet' };
}

/** Same text whether the shards were rebuilt or kept, so an unchanged snapshot keeps its dataHash. */
function cardsDetail(data: CardData): string {
  return `default_cards ${data.arena.meta.snapshot}: ${data.arena.cards.length} Arena cards, ${data.standard.cards.length} Standard`;
}

/** 404/403 from S3, or a missing fixture offline: the object does not exist. */
function isMissing(err: unknown): boolean {
  const e = err as { status?: unknown; name?: unknown };
  return e?.name === 'OfflineFixtureError' || e?.status === 403 || e?.status === 404;
}

// ---- scryfall ----------------------------------------------------------------------------

interface CardsStep {
  data: CardData | null;
  snapshot: string | null;
  status: SourceStatus;
  issues: ValidationIssue[];
}

async function previousCardData(ctx: PipelineContext): Promise<CardData | null> {
  const [arena, standard, sets] = await Promise.all([
    ctx.previous('public/_cards.arena.json'),
    ctx.previous('public/_cards.standard.json'),
    ctx.previous('sets.json'),
  ]);
  const a = CardShardSchema.safeParse(arena);
  const s = CardShardSchema.safeParse(standard);
  const t = SetsFileSchema.safeParse(sets);
  if (!a.success || !s.success || !t.success) return null;
  // Re-emit exactly what was on disk (compact form), not the zod-hydrated copy.
  return { arena: arena as CardShard, standard: standard as CardShard, sets: t.data };
}

async function cardsStep(ctx: PipelineContext, grindstone: string): Promise<CardsStep> {
  const prevExtra = MtgaMetaExtraSchema.safeParse(ctx.previousMeta?.extra);
  const prevSnapshot = prevExtra.success ? prevExtra.data.snapshot : null;
  const fallback = async (why: string, level: 'kept' | 'failed'): Promise<CardsStep> => {
    const prev = await previousCardData(ctx);
    if (!prev) {
      return {
        data: null,
        snapshot: null,
        status: failedStatus(ctx, 'scryfall', why),
        issues: [{ level: 'error', source: 'scryfall', message: `no card data: ${why}, and no last-good shards to keep` }],
      };
    }
    return {
      data: prev,
      snapshot: prev.arena.meta.snapshot,
      status: level === 'kept' ? keptStatus(ctx, 'scryfall') : failedStatus(ctx, 'scryfall', why),
      issues: level === 'kept' ? [] : [{ level: 'warn', source: 'scryfall', message: `${why}; last-good card data kept` }],
    };
  };

  if (!isSelected(ctx, 'scryfall')) return fallback('not selected in this run (--only)', 'kept');
  try {
    const info = parseBulkInfo(await ctx.http.json(SCRYFALL_BULK_URL, { headers: { ...SCRYFALL_HEADERS }, fixture: 'scryfall/bulk-data-default_cards', ttlHours: 1 }));
    if (prevSnapshot === info.updatedAt && prevExtra.success && prevExtra.data.grindstone === grindstone) {
      const prev = await previousCardData(ctx);
      if (prev) {
        ctx.log(`scryfall: default_cards unchanged since ${info.updatedAt}; keeping shards`);
        return {
          data: prev,
          snapshot: info.updatedAt,
          status: { id: 'scryfall', fetchedAt: ctx.now.toISOString(), status: 'ok', detail: cardsDetail(prev) },
          issues: [],
        };
      }
    }
    const started = Date.now();
    ctx.log(`scryfall: downloading ${info.downloadUri}${info.compressedSize ? ` (${(info.compressedSize / 1048576).toFixed(1)} MB)` : ''}`);
    const gz = await ctx.http.bytes(info.downloadUri, { fixture: 'scryfall/default-cards.jsonl', timeoutMs: BIG_DOWNLOAD_MS, ttlHours: 24 });
    const fold = await foldBulk(textLines(gz));
    const data = buildCardData(fold, { snapshot: info.updatedAt, source: info.downloadUri, grindstone, today: ctx.now.toISOString().slice(0, 10) });
    ctx.log(
      `scryfall: ${fold.printingCount} printings → ${fold.records.length} cards, ${data.arena.cards.length} on Arena, ` +
        `${data.standard.cards.length} Standard, ${data.sets.length} Arena sets (${((Date.now() - started) / 1000).toFixed(1)} s)`,
    );
    const prevCounts = ctx.offline ? null : (ctx.previousMeta?.counts ?? null);
    const issues = [
      ...checkCount({ name: 'Arena cards', count: data.arena.cards.length, previous: prevCounts?.cards ?? null, min: ctx.offline ? 1 : 10_000, source: 'scryfall' }),
      ...checkCount({ name: 'Standard cards', count: data.standard.cards.length, previous: prevCounts?.standardCards ?? null, maxDropPct: 50, min: ctx.offline ? 1 : 1_000, source: 'scryfall' }),
    ];
    if (issues.some((i) => i.level === 'error')) {
      const kept = await fallback(issues.map((i) => i.message).join('; '), 'failed');
      return { ...kept, issues: [...kept.issues, ...issues.map((i) => ({ ...i, level: 'warn' as const }))] };
    }
    return {
      data,
      snapshot: info.updatedAt,
      status: {
        id: 'scryfall',
        fetchedAt: ctx.now.toISOString(),
        status: 'ok',
        detail: cardsDetail(data),
      },
      issues,
    };
  } catch (err) {
    ctx.log(`scryfall failed: ${errMsg(err)}`);
    return fallback(`Scryfall fetch failed: ${errMsg(err)}`, 'failed');
  }
}

// ---- curated meta ------------------------------------------------------------------------

interface CuratedStep {
  snapshots: { format: ConstructedFormat; snapshot: MetaSnapshot }[];
  status: SourceStatus;
  issues: ValidationIssue[];
}

async function curatedStep(ctx: PipelineContext, index: CardIndex): Promise<CuratedStep> {
  if (!isSelected(ctx, 'curated-meta')) {
    const prevExtra = MtgaMetaExtraSchema.safeParse(ctx.previousMeta?.extra);
    const snapshots: CuratedStep['snapshots'] = [];
    for (const format of prevExtra.success ? prevExtra.data.metaFormats : []) {
      const parsed = MetaSnapshotSchema.safeParse(await ctx.previous(`meta/${format}.json`));
      if (parsed.success) snapshots.push({ format, snapshot: parsed.data });
    }
    return { snapshots, status: keptStatus(ctx, 'curated-meta'), issues: [] };
  }
  const r = await loadCurated(ctx.root, index);
  const decks = r.snapshots.reduce((n, s) => n + s.snapshot.decks.length, 0);
  const examples = r.snapshots.every((s) => s.snapshot.example === true);
  return {
    snapshots: r.snapshots,
    status: {
      id: 'curated-meta',
      fetchedAt: ctx.now.toISOString(),
      status: 'ok',
      detail: `${r.snapshots.length} format(s), ${decks} list(s)${r.snapshots.length > 0 && examples ? ' (example lists only)' : ''}`,
    },
    issues: r.issues,
  };
}

// ---- 17lands -----------------------------------------------------------------------------

interface LimitedStep {
  ratings: LimitedRatings[];
  index: LimitedIndex;
  status: SourceStatus;
  issues: ValidationIssue[];
}

async function previousLimited(ctx: PipelineContext): Promise<{ index: LimitedIndex; ratings: Map<string, LimitedRatings> }> {
  const parsed = LimitedIndexSchema.safeParse(await ctx.previous('limited/index.json'));
  const ratings = new Map<string, LimitedRatings>();
  if (!parsed.success) return { index: [], ratings };
  for (const e of parsed.data) {
    const raw = await ctx.previous(e.file);
    if (LimitedRatingsSchema.safeParse(raw).success) ratings.set(`${e.set}.${e.format}`, raw as LimitedRatings);
  }
  return { index: parsed.data.filter((e) => ratings.has(`${e.set}.${e.format}`)), ratings };
}

async function lastModified(ctx: PipelineContext, url: string, fixture: string): Promise<string | null> {
  try {
    const h = await ctx.http.head(url, { fixture, ttlHours: 1 });
    const t = Date.parse(h['last-modified'] ?? '');
    return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

async function limitedStep(ctx: PipelineContext, sets: readonly MtgSet[], index: CardIndex): Promise<LimitedStep> {
  const prev = await previousLimited(ctx);
  const keepAll = (status: SourceStatus, issues: ValidationIssue[]): LimitedStep => ({
    ratings: prev.index.map((e) => prev.ratings.get(`${e.set}.${e.format}`)!),
    index: prev.index,
    status,
    issues,
  });
  if (!isSelected(ctx, '17lands')) return keepAll(keptStatus(ctx, '17lands'), []);

  const started = Date.now();
  const deadline = started + LIMITED_BUDGET_MS;
  const today = ctx.now.toISOString().slice(0, 10);
  const issues: ValidationIssue[] = [];
  const notes: string[] = [];
  try {
    // 1. Newest Arena sets with a published PremierDraft game-data file.
    const candidates = sets.filter((s) => LIMITED_KINDS.has(s.kind) && s.releasedAt <= today).slice(0, LIMITED_PROBES);
    const found: { set: string; premier: string }[] = [];
    for (const s of candidates) {
      if (found.length >= LIMITED_SET_COUNT) break;
      const lm = await lastModified(ctx, gameDataUrl(s.code, 'PremierDraft'), `17lands/${s.code}.PremierDraft.game`);
      if (lm) found.push({ set: s.code, premier: lm });
    }
    ctx.log(`17lands: datasets for ${found.map((f) => f.set).join(', ') || 'no set'} (probed ${candidates.map((s) => s.code).join(', ')})`);

    // 2. Which datasets exist and which changed since the last run.
    interface Job { set: string; format: LimitedFormat; lastModified: string }
    const jobs: Job[] = [];
    for (const format of LIMITED_FORMATS) {
      for (const f of found) {
        const lm = format === 'PremierDraft' ? f.premier : await lastModified(ctx, gameDataUrl(f.set, format), `17lands/${f.set}.${format}.game`);
        if (lm) jobs.push({ set: f.set, format, lastModified: lm });
      }
    }

    // 3. Process changed datasets within the time budget; reuse unchanged ones.
    let cards: Map<string, Map<string, CardMeta>> | null = null;
    const out: LimitedRatings[] = [];
    let processed = 0;
    let reused = 0;
    for (const job of jobs) {
      const key = `${job.set}.${job.format}`;
      const old = prev.ratings.get(key);
      if (old && old.dataset.lastModified === job.lastModified && !old.synthetic) {
        out.push(old);
        reused++;
        continue;
      }
      if (Date.now() > deadline) {
        const msg = `${key}: skipped, 17Lands time budget (${LIMITED_BUDGET_MS / 60_000} min) used up`;
        issues.push({ level: 'warn', source: '17lands', message: old ? `${msg}; last-good ratings kept` : msg });
        if (old) out.push(old);
        continue;
      }
      try {
        const t0 = Date.now();
        cards ??= await parseCardsCsv(textLines(await ctx.http.bytes(CARDS_CSV_URL, { fixture: '17lands/cards', timeoutMs: 120_000, ttlHours: 24 })));
        const gameUrl = gameDataUrl(job.set, job.format);
        const games = await aggregateGames(textLines(await ctx.http.bytes(gameUrl, { fixture: `17lands/${key}.game`, timeoutMs: BIG_DOWNLOAD_MS, ttlHours: 24 * 7 })));
        const draftUrl = draftDataUrl(job.set, job.format);
        const hasDraft = job.format !== 'Sealed' && job.format !== 'TradSealed' && (await lastModified(ctx, draftUrl, `17lands/${key}.draft`)) !== null;
        const drafts = hasDraft && Date.now() < deadline
          ? await aggregateDrafts(textLines(await ctx.http.bytes(draftUrl, { fixture: `17lands/${key}.draft`, timeoutMs: BIG_DOWNLOAD_MS, ttlHours: 24 * 7 })))
          : null;
        out.push(buildRatings({ set: job.set, format: job.format, games, drafts, cards, index, gameData: gameUrl, draftData: drafts ? draftUrl : null, lastModified: job.lastModified }));
        processed++;
        ctx.log(`17lands: ${key}: ${games.games} games${drafts ? `, ${drafts.drafts} drafts` : ''} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      } catch (err) {
        ctx.log(`17lands: ${key} failed: ${errMsg(err)}`);
        issues.push({ level: 'warn', source: '17lands', message: `${key}: ${errMsg(err)}${old ? '; last-good ratings kept' : ''}` });
        if (old) out.push(old);
      }
    }
    const setOrder = found.map((f) => f.set);
    const limitedIndex = buildLimitedIndex(out, setOrder, LIMITED_FORMATS);
    notes.push(`${limitedIndex.map((e) => `${e.set} ${e.format}`).join(', ') || 'no datasets published yet'}`);
    const partial = issues.length > 0;
    ctx.log(`17lands: ${processed} processed, ${reused} unchanged (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return {
      ratings: limitedIndex.map((e) => out.find((r) => r.set === e.set && r.format === e.format)!),
      index: limitedIndex,
      status: {
        id: '17lands',
        fetchedAt: partial ? (previousStatus(ctx, '17lands')?.fetchedAt ?? ctx.now.toISOString()) : ctx.now.toISOString(),
        status: partial ? 'stale' : 'ok',
        detail: notes.join('; '),
      },
      issues,
    };
  } catch (err) {
    ctx.log(`17lands failed: ${errMsg(err)}`);
    return keepAll(failedStatus(ctx, '17lands', errMsg(err)), [{ level: 'warn', source: '17lands', message: `17Lands datasets unavailable: ${errMsg(err)}; last-good ratings kept` }]);
  }
}

// ---- assembly ----------------------------------------------------------------------------

export async function runMtga(ctx: PipelineContext): Promise<PipelineResult> {
  const issues: ValidationIssue[] = [];
  const files: OutputFile[] = [];
  const gs = readGrindstoneVersion(ctx.root);

  const cards = await cardsStep(ctx, gs.version);
  issues.push(...cards.issues);
  const grindstoneStatus: SourceStatus = {
    id: 'grindstone-mcp',
    fetchedAt: ctx.now.toISOString(),
    status: 'ok',
    detail: `grindstone-mcp ${gs.version} (${gs.sha.slice(0, 7)}), vendored`,
  };
  if (!cards.data) {
    // Nothing usable: the runner keeps every last-good file for the game.
    const prevMeta = ctx.previousMeta;
    return {
      meta: {
        game: 'mtga',
        schema: 1,
        version: prevMeta?.version ?? { label: 'unknown' },
        sources: [cards.status, ...(prevMeta?.sources.filter((s) => s.id !== 'scryfall') ?? []), grindstoneStatus],
        counts: prevMeta?.counts ?? {},
      },
      files: [],
      issues,
    };
  }

  const { arena, standard, sets } = cards.data;
  files.push(
    { path: 'public/_cards.arena.json', data: arena, custody: 'A' },
    { path: 'public/_cards.standard.json', data: standard, custody: 'A' },
    { path: 'sets.json', data: sets, custody: 'A' },
  );
  const index = new CardIndex(arena.cards.map(hydrateCardRecord), arena.meta);

  const curated = await curatedStep(ctx, index);
  issues.push(...curated.issues);
  for (const s of curated.snapshots) files.push({ path: `meta/${s.format}.json`, data: s.snapshot, custody: 'A' });

  const limited = await limitedStep(ctx, sets, index);
  issues.push(...limited.issues);
  for (const r of limited.ratings) files.push({ path: limitedFile(r.set, r.format), data: r, custody: 'A' });
  files.push({ path: 'limited/index.json', data: limited.index, custody: 'A' });

  const { latest, standardSets } = versionOf(sets, ctx.now.toISOString().slice(0, 10));
  const extra = {
    snapshot: arena.meta.snapshot,
    grindstone: gs.version,
    latestSet: latest?.code ?? 'NONE',
    standardSets,
    metaFormats: curated.snapshots.map((s) => s.format),
  };
  const extraCheck = MtgaMetaExtraSchema.safeParse(extra);
  if (!extraCheck.success) issues.push({ level: 'error', message: `meta.json extra: ${extraCheck.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
  issues.push(...validateFiles(files, MTGA_FILES));

  return {
    meta: {
      game: 'mtga',
      schema: 1,
      version: latest ? { label: latest.code, since: latest.releasedAt } : { label: 'unknown' },
      sources: [cards.status, limited.status, curated.status, grindstoneStatus],
      counts: {
        cards: arena.cards.length,
        standardCards: standard.cards.length,
        sets: sets.length,
        limitedSets: new Set(limited.index.map((e) => e.set)).size,
        metaDecks: curated.snapshots.reduce((n, s) => n + s.snapshot.decks.length, 0),
      },
      extra,
    },
    files,
    issues,
  };
}

export const pipeline: DataPipeline = { run: runMtga };
export default pipeline;
