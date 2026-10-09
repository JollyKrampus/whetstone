/**
 * Build-time loaders for MTG Arena data: the only place pages read MTGA files (SPEC §3).
 * Node-only (fs through src/lib/datadir.ts). Card shards are fetched by the analyzer worker
 * in the browser; pages read them here only for counts, search pages and validation.
 * Every read is zod-validated (errors name the file) and memoized.
 */
import path from 'node:path';
import { createCachedLoader } from '../../core/schemas.ts';
import { gameDataDir, readGameJson } from '../../lib/datadir.ts';
import {
  CardShardSchema,
  LimitedIndexSchema,
  LimitedRatingsSchema,
  MetaSnapshotSchema,
  MtgaMetaSchema,
  SetsFileSchema,
  limitedFile,
  type CardShard,
  type ConstructedFormat,
  type LimitedFormat,
  type LimitedIndex,
  type LimitedRatings,
  type MetaSnapshot,
  type MtgaMeta,
  type MtgSet,
} from './schema.ts';

const GAME = 'mtga';

const data = createCachedLoader({
  read: (file, { optional }) => readGameJson(GAME, file, { optional }),
  where: (file) => path.join(gameDataDir(GAME), file),
});

/** Drops cached files (tests, dev-server reloads). */
export function clearMtgaCache(): void {
  data.clear();
}

export function getMeta(): MtgaMeta {
  return data.required('meta.json', MtgaMetaSchema);
}

/** Newest first. */
export function getSets(): MtgSet[] {
  return data.required('sets.json', SetsFileSchema);
}

export function getSet(code: string): MtgSet | undefined {
  const upper = code.toUpperCase();
  return getSets().find((s) => s.code === upper);
}

export function getStandardSets(): MtgSet[] {
  return getSets().filter((s) => s.standard);
}

/**
 * A card shard with defaults restored (records are grindstone `CardRecord`s; pass
 * `shard.cards` and `shard.meta` to `new CardIndex(...)`). The Arena shard is large: prefer
 * the Standard one at build time unless every card is needed.
 */
export function getCardShard(format: 'standard' | 'arena'): CardShard {
  return data.required(`public/_cards.${format}.json`, CardShardSchema);
}

/** Sets/formats with 17Lands ratings; empty when Limited data has never been built. */
export function getLimitedIndex(): LimitedIndex {
  return data.optional('limited/index.json', LimitedIndexSchema) ?? [];
}

/** 17Lands ratings for one set and format, or null when not published. Render `attribution` at the top of the page. */
export function getLimitedRatings(set: string, format: LimitedFormat = 'PremierDraft'): LimitedRatings | null {
  const entry = getLimitedIndex().find((e) => e.set === set.toUpperCase() && e.format === format);
  if (!entry) return null;
  const ratings = data.required(entry.file, LimitedRatingsSchema);
  if (ratings.set !== entry.set || ratings.format !== entry.format) {
    throw new Error(`${path.join(gameDataDir(GAME), entry.file)} holds ${ratings.set} ${ratings.format}, index says ${entry.set} ${entry.format}`);
  }
  return ratings;
}

/** Path of a set's ratings file relative to the data dir (for staging/links). */
export { limitedFile };

/** Hand-curated meta snapshot for a format (grindstone snapshot format), or null. */
export function getMetaSnapshot(format: ConstructedFormat): MetaSnapshot | null {
  const snap = data.optional(`meta/${format}.json`, MetaSnapshotSchema);
  if (snap && snap.format !== format) {
    throw new Error(`${path.join(gameDataDir(GAME), `meta/${format}.json`)} declares format ${snap.format}`);
  }
  return snap;
}

/** Every curated snapshot listed in meta.json `extra.metaFormats`. */
export function getMetaSnapshots(): MetaSnapshot[] {
  return getMeta()
    .extra.metaFormats.map((f) => getMetaSnapshot(f))
    .filter((s): s is MetaSnapshot => s !== null);
}
