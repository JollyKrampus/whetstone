/**
 * Data contracts for MTG Arena. Files live in data/current/mtga/ (all class A):
 *
 *   meta.json                      GameMeta + MTGA extras
 *   sets.json                      Set[]
 *   public/_cards.standard.json    CardShard (browser; Standard-legal Arena cards)
 *   public/_cards.arena.json       CardShard (browser; every Arena card)
 *   limited/index.json             LimitedIndex
 *   limited/<SET>.<Format>.json    LimitedRatings (17Lands public datasets, CC BY 4.0)
 *   meta/<format>.json             MetaSnapshot (hand-curated, grindstone snapshot format)
 *
 * The `_` prefix marks the card shards as internal assets: stage.ts maps them for the
 * analyzer but never lists them in the public manifest (Scryfall terms: not a dataset).
 *
 * Card records are exactly grindstone-mcp's `CardRecord` (core/types.ts): one per Scryfall
 * oracle id, folded over all printings by grindstone's `aggregateCards`, then filtered to Arena.
 * To save bytes a shard may omit empty/default fields; `CardRecordSchema` restores them
 * (zod defaults) and `hydrateCardRecord` does the same without zod for the browser worker.
 * Rates are fractions in [0, 1]; IWD is in percentage points.
 */
import { z } from 'zod';
import { Count, FileAttributionSchema, gameMetaSchema, IsoDate, IsoDateTime, Rate, Url, checkUnique } from '../../core/schemas.ts';

// ---- vocabulary ------------------------------------------------------------------------

export const COLORS = ['W', 'U', 'B', 'R', 'G'] as const;
export const ColorSchema = z.enum(COLORS);
export const RaritySchema = z.enum(['common', 'uncommon', 'rare', 'mythic']);
/** Scryfall legality keys kept in shards (the Arena formats grindstone knows, plus alchemy). */
export const ARENA_FORMATS = ['standard', 'pioneer', 'historic', 'timeless', 'brawl', 'standardbrawl', 'alchemy'] as const;
export const ArenaFormatSchema = z.enum(ARENA_FORMATS);
/** grindstone `FORMATS` ids a meta snapshot may target. */
export const ConstructedFormatSchema = z.enum(['standard', 'pioneer', 'historic', 'timeless', 'brawl', 'standardbrawl']);
export type ConstructedFormat = z.infer<typeof ConstructedFormatSchema>;
export const LegalitySchema = z.enum(['legal', 'not_legal', 'banned', 'restricted']);
/** 17Lands event types published as public datasets. */
export const LimitedFormatSchema = z.enum(['PremierDraft', 'TradDraft', 'QuickDraft', 'Sealed', 'TradSealed', 'PickTwoDraft', 'PickTwoTradDraft']);
export type LimitedFormat = z.infer<typeof LimitedFormatSchema>;
/** Upper-case set code as 17Lands writes it (`BLB`); Scryfall uses the lower-case form. */
export const SetCodeSchema = z.string().regex(/^[A-Z0-9]{2,6}$/, 'expected an upper-case set code like BLB');
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'expected a lower-case uuid');
/** Colour combination in WUBRG order, '' for colourless (`WU`, `BRG`). */
export const ColorComboSchema = z.string().regex(/^W?U?B?R?G?$/, 'expected colours in WUBRG order');

// ---- meta.json -------------------------------------------------------------------------

export const MtgaMetaExtraSchema = z.strictObject({
  /** Scryfall `default_cards` bulk `updated_at`: the card data snapshot id. */
  snapshot: IsoDateTime,
  /** grindstone-mcp version whose `aggregateCards` built the shards. */
  grindstone: z.string().min(1),
  latestSet: SetCodeSchema,
  /** Sets currently legal in Standard, newest first. */
  standardSets: z.array(SetCodeSchema),
  /** Formats with a curated meta snapshot under meta/. */
  metaFormats: z.array(ConstructedFormatSchema),
});
export const MtgaMetaSchema = gameMetaSchema('mtga', MtgaMetaExtraSchema);
export type MtgaMeta = z.infer<typeof MtgaMetaSchema>;

// ---- sets.json -------------------------------------------------------------------------

export const SetSchema = z.strictObject({
  code: SetCodeSchema,
  name: z.string().min(1),
  releasedAt: IsoDate,
  /** Scryfall `set_type` (expansion, core, masters, alchemy, ...). */
  kind: z.string().min(1),
  arena: z.boolean(),
  standard: z.boolean(),
  /** Arena cards (oracle records) first printed or reprinted in the set. */
  cardCount: Count.exactOptional(),
  /** Scryfall set icon (SVG), hotlinked with credit. */
  icon: Url.exactOptional(),
});
export type MtgSet = z.infer<typeof SetSchema>;

/** Newest first. */
export const SetsFileSchema = z.array(SetSchema).superRefine((list, ctx) => {
  checkUnique(ctx, list.map((s) => s.code), 'set code');
  for (let i = 1; i < list.length; i++) {
    if ((list[i - 1] as MtgSet).releasedAt < (list[i] as MtgSet).releasedAt) {
      ctx.addIssue({ code: 'custom', message: 'sets must be sorted newest first', path: [i] });
      return;
    }
  }
});

// ---- card shards (grindstone CardRecord) -----------------------------------------------

export const CardFaceSchema = z.strictObject({
  name: z.string().min(1),
  manaCost: z.string(),
  typeLine: z.string(),
  oracleText: z.string(),
  power: z.string().exactOptional(),
  toughness: z.string().exactOptional(),
});

/**
 * grindstone `CardRecord`. Fields with defaults may be omitted in shards. Legalities hold the
 * ARENA_FORMATS keys; `not_legal` entries may be omitted (grindstone treats a missing key as
 * not legal).
 */
export const CardRecordSchema = z.strictObject({
  oracleId: Uuid,
  name: z.string().min(1),
  layout: z.string().min(1),
  manaCost: z.string().default(''),
  cmc: z.number().nonnegative(),
  typeLine: z.string().min(1),
  /** Kept in full: grindstone's role, theme and land rules read it. */
  oracleText: z.string().default(''),
  faces: z.array(CardFaceSchema).default([]),
  colors: z.array(ColorSchema).default([]),
  colorIdentity: z.array(ColorSchema).default([]),
  producedMana: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]),
  legalities: z.partialRecord(ArenaFormatSchema, LegalitySchema),
  power: z.string().exactOptional(),
  toughness: z.string().exactOptional(),
  rarity: RaritySchema,
  arenaRarity: RaritySchema.nullable().default(null),
  onArena: z.boolean().default(true),
  arenaIds: z.array(z.number().int().positive()).default([]),
  releasedAt: IsoDate,
  latestReleasedAt: IsoDate,
  edhrecRank: z.number().int().positive().nullable().default(null),
  gameChanger: z.boolean().default(false),
  // Whetstone extras (ignored by grindstone): build image URLs without an API call.
  /** Scryfall id of the newest Arena printing. */
  scryfallId: Uuid.exactOptional(),
  /** Lower-case Scryfall set code and collector number of that printing. */
  set: z.string().regex(/^[a-z0-9]{2,6}$/).exactOptional(),
  cn: z.string().min(1).exactOptional(),
});
export type CardRecord = z.output<typeof CardRecordSchema>;
/** Shard form as written to disk (defaults may be missing). */
export type CompactCardRecord = z.input<typeof CardRecordSchema>;

/** grindstone `IndexMeta`; `builtAt` equals `snapshot` so shards stay deterministic. */
export const IndexMetaSchema = z.strictObject({
  snapshot: IsoDateTime,
  builtAt: IsoDateTime,
  source: Url,
  cardCount: Count,
});

export const CardShardSchema = z
  .strictObject({
    schema: z.literal(1),
    format: z.enum(['standard', 'arena']),
    /** Pass straight to `new CardIndex(cards, meta)`. */
    meta: IndexMetaSchema,
    grindstone: z.string().min(1),
    /** Sorted like grindstone's `byNameThenId`. */
    cards: z.array(CardRecordSchema),
  })
  .superRefine((s, ctx) => {
    if (s.cards.length !== s.meta.cardCount) {
      ctx.addIssue({ code: 'custom', message: `meta.cardCount ${s.meta.cardCount} != ${s.cards.length} cards`, path: ['meta', 'cardCount'] });
    }
    checkUnique(ctx, s.cards.map((c) => c.oracleId), 'oracleId', ['cards']);
    for (let i = 1; i < s.cards.length; i++) {
      const a = s.cards[i - 1] as CardRecord;
      const b = s.cards[i] as CardRecord;
      if (a.name > b.name || (a.name === b.name && a.oracleId > b.oracleId)) {
        ctx.addIssue({ code: 'custom', message: 'cards must be sorted by name, then oracleId', path: ['cards', i] });
        return;
      }
    }
    for (const [i, c] of s.cards.entries()) {
      if (!c.onArena) ctx.addIssue({ code: 'custom', message: `${c.name} is not on Arena`, path: ['cards', i, 'onArena'] });
      if (s.format === 'standard' && (c.legalities.standard ?? 'not_legal') === 'not_legal') {
        ctx.addIssue({ code: 'custom', message: `${c.name} has no Standard legality but is in the Standard shard`, path: ['cards', i] });
      }
    }
  });
export type CardShard = z.output<typeof CardShardSchema>;

/**
 * Restores fields a shard omitted, without zod (for the browser worker). Mirrors the defaults
 * in CardRecordSchema; keep the two in sync.
 */
export function hydrateCardRecord(c: CompactCardRecord): CardRecord {
  return {
    ...c,
    manaCost: c.manaCost ?? '',
    oracleText: c.oracleText ?? '',
    faces: c.faces ?? [],
    colors: c.colors ?? [],
    colorIdentity: c.colorIdentity ?? [],
    producedMana: c.producedMana ?? [],
    keywords: c.keywords ?? [],
    arenaRarity: c.arenaRarity ?? null,
    onArena: c.onArena ?? true,
    arenaIds: c.arenaIds ?? [],
    edhrecRank: c.edhrecRank ?? null,
    gameChanger: c.gameChanger ?? false,
  };
}

// ---- limited ratings (17Lands public datasets) -----------------------------------------

/** Win rate that is null when its sample is empty. */
const MaybeRate = Rate.nullable();

export const CardRatingSchema = z.strictObject({
  name: z.string().min(1),
  oracleId: Uuid.exactOptional(),
  arenaIds: z.array(z.number().int().positive()).exactOptional(),
  colors: ColorComboSchema,
  rarity: RaritySchema,
  /** Games played: card in the main deck. */
  gp: Count,
  /** Games in hand (opening hand or drawn) = oh + gd. */
  gih: Count,
  oh: Count,
  gd: Count,
  /** Games in deck but never seen. */
  gns: Count,
  gpWr: MaybeRate,
  gihWr: MaybeRate,
  ohWr: MaybeRate,
  gdWr: MaybeRate,
  gnsWr: MaybeRate,
  /** Improvement when drawn = gihWr − gnsWr, percentage points. */
  iwd: z.number().nullable(),
  /** Average pick number when last seen in a pack (draft data). */
  alsa: z.number().positive().nullable(),
  /** Average pick number when taken. */
  ata: z.number().positive().nullable(),
  picks: Count.exactOptional(),
});
export type CardRating = z.infer<typeof CardRatingSchema>;

export const ColorPairRatingSchema = z.strictObject({
  /** Main colours (WUBRG order); mono-colour decks use one letter. */
  colors: ColorComboSchema.refine((c) => c.length >= 1, 'expected at least one colour'),
  /** Decks with a splash counted separately when true. */
  splash: z.boolean(),
  games: Count,
  wins: Count,
  wr: MaybeRate,
});

export const LimitedRatingsSchema = z
  .strictObject({
    /** Fixture/sample numbers; never present in pipeline output. */
    synthetic: z.literal(true).exactOptional(),
    set: SetCodeSchema,
    format: LimitedFormatSchema,
    /** Must render at the top of the page (17Lands CC BY 4.0 usage guidelines). */
    attribution: FileAttributionSchema,
    dataset: z.strictObject({
      gameData: Url,
      draftData: Url.exactOptional(),
      /** S3 Last-Modified of the game data file. */
      lastModified: IsoDateTime,
    }),
    /** Optional player filter applied when aggregating. */
    filter: z.strictObject({ minUserWinRateBucket: Rate }).exactOptional(),
    totals: z.strictObject({ games: Count, drafts: Count.exactOptional() }),
    /** Sorted by name. */
    cards: z.array(CardRatingSchema),
    colorPairs: z.array(ColorPairRatingSchema),
  })
  .superRefine((r, ctx) => {
    if (r.attribution.source !== '17lands') ctx.addIssue({ code: 'custom', message: "attribution.source must be '17lands'", path: ['attribution', 'source'] });
    checkUnique(ctx, r.cards.map((c) => c.name), 'card', ['cards']);
    checkUnique(ctx, r.colorPairs.map((p) => `${p.colors}${p.splash ? '+' : ''}`), 'colour pair', ['colorPairs']);
    for (const [i, c] of r.cards.entries()) {
      if (c.gih !== c.oh + c.gd) ctx.addIssue({ code: 'custom', message: `${c.name}: gih must equal oh + gd`, path: ['cards', i, 'gih'] });
    }
  });
export type LimitedRatings = z.infer<typeof LimitedRatingsSchema>;

export const LimitedIndexEntrySchema = z.strictObject({
  set: SetCodeSchema,
  format: LimitedFormatSchema,
  /** Relative to the mtga data dir: `limited/<SET>.<Format>.json`. */
  file: z.string().regex(/^limited\/[A-Z0-9]{2,6}\.[A-Za-z]+\.json$/),
  games: Count,
  lastModified: IsoDateTime,
  synthetic: z.literal(true).exactOptional(),
});
export const LimitedIndexSchema = z.array(LimitedIndexEntrySchema).superRefine((list, ctx) => {
  checkUnique(ctx, list.map((e) => `${e.set}.${e.format}`), 'set/format');
  for (const [i, e] of list.entries()) {
    if (e.file !== limitedFile(e.set, e.format)) ctx.addIssue({ code: 'custom', message: `expected file ${limitedFile(e.set, e.format)}`, path: [i, 'file'] });
  }
});
export type LimitedIndex = z.infer<typeof LimitedIndexSchema>;

export function limitedFile(set: string, format: LimitedFormat): string {
  return `limited/${set}.${format}.json`;
}

// ---- meta/<format>.json (grindstone snapshot format) -----------------------------------

/**
 * One deck of grindstone's snapshot format (`snapshotSchema` in core/meta.ts) plus Whetstone
 * extras. grindstone's `parseSnapshot` strips unknown keys, so these files stay valid input.
 */
export const MetaDeckSchema = z.strictObject({
  name: z.string().min(1).exactOptional(),
  archetype: z.string().min(1).exactOptional(),
  /** Share of the metagame, 0..1. */
  metaShare: Rate.exactOptional(),
  /** Match win rate, 0..1. */
  winRate: Rate.exactOptional(),
  /** Arena export text. */
  list: z.string().min(1),
  /** Where a human read this list (required unless the deck is an example). */
  sourceUrl: Url.exactOptional(),
  /** Marks illustrative decks; the UI labels them and excludes them from meta stats. */
  example: z.literal(true).exactOptional(),
  notes: z.string().min(1).exactOptional(),
});

export const MetaSnapshotSchema = z
  .strictObject({
    format: ConstructedFormatSchema,
    date: IsoDate.exactOptional(),
    source: z.string().min(1).exactOptional(),
    /** Whole snapshot is illustrative. */
    example: z.literal(true).exactOptional(),
    curator: z.string().min(1).exactOptional(),
    decks: z.array(MetaDeckSchema).min(1),
  })
  .superRefine((s, ctx) => {
    for (const [i, d] of s.decks.entries()) {
      if (!d.sourceUrl && !d.example && !s.example) {
        ctx.addIssue({ code: 'custom', message: 'curated decks need a sourceUrl (or example: true)', path: ['decks', i, 'sourceUrl'] });
      }
    }
  });
export type MetaSnapshot = z.infer<typeof MetaSnapshotSchema>;

// ---- file registry ---------------------------------------------------------------------

export const MTGA_FILES = {
  'meta.json': { schema: MtgaMetaSchema, custody: 'A' },
  'sets.json': { schema: SetsFileSchema, custody: 'A' },
  'public/_cards.standard.json': { schema: CardShardSchema, custody: 'A' },
  'public/_cards.arena.json': { schema: CardShardSchema, custody: 'A' },
  'limited/index.json': { schema: LimitedIndexSchema, custody: 'A' },
  'limited/<SET>.<Format>.json': { schema: LimitedRatingsSchema, custody: 'A' },
  'meta/<format>.json': { schema: MetaSnapshotSchema, custody: 'A' },
} as const;

/** curated/mtga/meta/<format>.json */
export const MTGA_CURATED = {
  'meta/<format>.json': MetaSnapshotSchema,
} as const;
