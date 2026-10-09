/**
 * Data contracts for Pokémon Champions (VGC Doubles, critique D14). Files live in
 * data/current/pokemon/ (all class A; Limitless/Showdown data is aggregate-only, no player names):
 *
 *   meta.json                  GameMeta + regulation extras
 *   regulations.json           validated copy of curated/pokemon/regulations.yaml
 *   dex/species.json           Species[] (legal in at least one listed regulation)
 *   dex/moves.json             Move[] (Champions mod values)
 *   dex/items.json             Item[]
 *   dex/abilities.json         Ability[]
 *   dex/typechart.json         TypeChart
 *   dex/learnsets.json         species id → legal move ids
 *   usage/index.json           UsageIndex
 *   usage/<format>-<cutoff>.json  Usage (Smogon monthly chaos, top-K per field)
 *   tournaments.json           Limitless aggregates
 *   h2h.json                   Showdown Bo3 replay head-to-head edges
 *   speed.json                 Speed tiers at level 50 with Stat Points
 *   public/dex.json            DexShard (browser: builder, calc, preview)
 *
 * Ids are Showdown `toID`s (lowercase alphanumerics: `garchompmegaz`, `indeedeef`).
 * Stat Points (SP) replace EVs: ≤ 32 per stat, ≤ 66 total. Rates are fractions in [0, 1].
 */
import { z } from 'zod';
import { Count, DataPath, EdgeSchema, FileAttributionSchema, gameMetaSchema, IsoDate, IsoDateTime, Rate, Slug, Url, checkUnique } from '../../core/schemas.ts';

// ---- vocabulary ------------------------------------------------------------------------

export const POKEMON_TYPES = [
  'Normal', 'Fire', 'Water', 'Electric', 'Grass', 'Ice', 'Fighting', 'Poison', 'Ground',
  'Flying', 'Psychic', 'Bug', 'Rock', 'Ghost', 'Dragon', 'Dark', 'Steel', 'Fairy',
] as const;
export const PokemonTypeSchema = z.enum(POKEMON_TYPES);
export type PokemonType = z.infer<typeof PokemonTypeSchema>;

export const NATURES = [
  'Adamant', 'Bashful', 'Bold', 'Brave', 'Calm', 'Careful', 'Docile', 'Gentle', 'Hardy', 'Hasty', 'Impish', 'Jolly', 'Lax',
  'Lonely', 'Mild', 'Modest', 'Naive', 'Naughty', 'Quiet', 'Quirky', 'Rash', 'Relaxed', 'Sassy', 'Serious', 'Timid',
] as const;
export const NatureSchema = z.enum(NATURES);
export type Nature = z.infer<typeof NatureSchema>;

/** Showdown toID: lowercase alphanumerics. */
export const ShowdownIdSchema = z.string().regex(/^[a-z0-9]+$/, 'expected a Showdown id (lowercase alphanumerics)');
/** Regulation set id, e.g. `M-C`. */
export const RegulationIdSchema = z.string().regex(/^M-[A-Z]$/, 'expected a regulation id like M-C');
/** Showdown format id, e.g. `gen9championsvgc2026regmc`. */
export const FormatIdSchema = z.string().regex(/^gen\d+[a-z0-9]+$/, 'expected a Showdown format id');
/** Smogon rating cutoffs. */
export const CutoffSchema = z.union([z.literal(0), z.literal(1500), z.literal(1630), z.literal(1760)]);
export type Cutoff = z.infer<typeof CutoffSchema>;

const BaseStat = z.number().int().min(1).max(255);
export const StatsTableSchema = z.strictObject({ hp: BaseStat, atk: BaseStat, def: BaseStat, spa: BaseStat, spd: BaseStat, spe: BaseStat });

/** Stat Points spread in HP/Atk/Def/SpA/SpD/Spe order (each ≤ 32, total ≤ 66). */
export const SpSpreadSchema = z
  .tuple([z.number().int().min(0).max(32), z.number().int().min(0).max(32), z.number().int().min(0).max(32), z.number().int().min(0).max(32), z.number().int().min(0).max(32), z.number().int().min(0).max(32)])
  .refine((sp) => sp.reduce((a, b) => a + b, 0) <= 66, 'Stat Points total must be ≤ 66');

// ---- regulations (curated/pokemon/regulations.yaml → regulations.json) ------------------

export const SeasonSchema = z.strictObject({
  id: z.string().regex(/^M-\d+$/),
  start: IsoDateTime,
  end: IsoDateTime,
  /** Dates not yet confirmed by an official source. */
  estimated: z.literal(true).exactOptional(),
});

export const RegulationSchema = z
  .strictObject({
    id: RegulationIdSchema,
    label: z.string().min(1),
    /** Window in UTC; start inclusive, end inclusive to the minute (official 01:59 ends). */
    start: IsoDateTime,
    end: IsoDateTime,
    /** Showdown mod holding this regulation's data (`champions`, `championsregmb`). */
    showdownMod: z.string().regex(/^[a-z0-9]+$/),
    formats: z.strictObject({ doubles: FormatIdSchema, doublesBo3: FormatIdSchema, singles: FormatIdSchema }),
    /** Limitless play API format code. */
    limitlessFormat: z.string().min(1),
    seasons: z.array(SeasonSchema),
    estimatedEnd: z.literal(true).exactOptional(),
    sourceUrl: Url.exactOptional(),
    notes: z.string().min(1).exactOptional(),
  })
  .superRefine((r, ctx) => {
    if (!(Date.parse(r.start) < Date.parse(r.end))) ctx.addIssue({ code: 'custom', message: 'start must be before end', path: ['end'] });
    for (const [i, s] of r.seasons.entries()) {
      if (Date.parse(s.start) < Date.parse(r.start) || Date.parse(s.end) > Date.parse(r.end)) ctx.addIssue({ code: 'custom', message: `season ${s.id} lies outside the regulation window`, path: ['seasons', i] });
    }
  });
export type Regulation = z.infer<typeof RegulationSchema>;

/** Sorted by start; windows must not overlap. */
export const RegulationsFileSchema = z.strictObject({ regulations: z.array(RegulationSchema).min(1) }).superRefine((f, ctx) => {
  checkUnique(ctx, f.regulations.map((r) => r.id), 'regulation', ['regulations']);
  for (let i = 1; i < f.regulations.length; i++) {
    const a = f.regulations[i - 1] as Regulation;
    const b = f.regulations[i] as Regulation;
    if (Date.parse(a.end) >= Date.parse(b.start)) ctx.addIssue({ code: 'custom', message: `${a.id} overlaps or is not before ${b.id}`, path: ['regulations', i] });
  }
});
export type RegulationsFile = z.infer<typeof RegulationsFileSchema>;

// ---- meta.json -------------------------------------------------------------------------

export const PokemonMetaExtraSchema = z.strictObject({
  regulation: RegulationIdSchema,
  regulationLabel: z.string().min(1),
  window: z.strictObject({ start: IsoDateTime, end: IsoDateTime }),
  season: SeasonSchema.exactOptional(),
  formats: RegulationSchema.shape.formats,
  /** Smogon stats month the usage files come from (`2026-09`). */
  smogonMonth: z.string().regex(/^\d{4}-\d{2}$/).exactOptional(),
  /** smogon/pokemon-showdown commit the dex was exported from. */
  showdownSha: z.string().regex(/^[0-9a-f]{7,40}$/).exactOptional(),
  /**
   * Present right after a regulation change while some sources have no data for the new
   * regulation yet ("data warming up"). Those sources keep showing `showing`'s data, which
   * every file labels with its own `regulation`.
   */
  warmingUp: z
    .strictObject({
      /** The new (current) regulation. */
      regulation: RegulationIdSchema,
      since: IsoDateTime,
      /** SourceRef ids without data for `regulation` yet. */
      sources: z.array(z.string().min(1)).min(1),
      /** Regulation whose data is shown meanwhile, when there is any. */
      showing: RegulationIdSchema.exactOptional(),
    })
    .exactOptional(),
  /**
   * Cache key of the dex export: Showdown commit, exporter version and the regulation formats.
   * The pipeline skips the Showdown build and re-emits the last-good dex while it is unchanged.
   */
  dexKey: z.string().regex(/^[0-9a-f]{16}$/).exactOptional(),
  /**
   * Self-hosted sprites (img/sprites/<id>.webp, referenced by Species.sprite): where they come
   * from and the credit to show wherever they appear.
   */
  sprites: z.strictObject({ count: Count, source: Url, credit: z.string().min(1) }).exactOptional(),
});
export const PokemonMetaSchema = gameMetaSchema('pokemon', PokemonMetaExtraSchema);
export type PokemonMeta = z.infer<typeof PokemonMetaSchema>;

// ---- dex -------------------------------------------------------------------------------

export const SpeciesSchema = z
  .strictObject({
    id: ShowdownIdSchema,
    name: z.string().min(1),
    /** National Dex number (Species Clause compares these). */
    num: z.number().int().positive(),
    baseSpecies: z.string().min(1).exactOptional(),
    /** `Mega`, `Mega-Z`, `Mega-Y`, `F`, `Alola`, ... */
    forme: z.string().min(1).exactOptional(),
    types: z.union([z.tuple([PokemonTypeSchema]), z.tuple([PokemonTypeSchema, PokemonTypeSchema])]),
    base: StatsTableSchema,
    /** Ability ids. */
    abilities: z.array(ShowdownIdSchema).min(1).max(3),
    weightkg: z.number().positive(),
    /** Mega forme: id of the species it evolves from in battle. */
    megaOf: ShowdownIdSchema.exactOptional(),
    /** Mega forme: the stone (item id) it needs. */
    requiredItem: ShowdownIdSchema.exactOptional(),
    /** Base species: its Mega formes. */
    megas: z.array(ShowdownIdSchema).exactOptional(),
    otherFormes: z.array(ShowdownIdSchema).exactOptional(),
    /** Regulations this species/forme is legal in. */
    legal: z.array(RegulationIdSchema),
    /** Showdown Champions tier (OU, UU, ...), informational. */
    tier: z.string().min(1).exactOptional(),
    sprite: DataPath.exactOptional(),
    /**
     * Base species: ids of cosmetic formes (Vivillon patterns, Alcremie flavours...) that battle
     * exactly like it. They have no entry of their own; data keyed by one of them (replays,
     * tournament lists) is counted under this species.
     */
    cosmeticFormes: z.array(ShowdownIdSchema).exactOptional(),
  })
  .superRefine((s, ctx) => {
    if ((s.megaOf === undefined) !== (s.requiredItem === undefined)) {
      ctx.addIssue({ code: 'custom', message: 'megaOf and requiredItem go together', path: ['megaOf'] });
    }
    checkUnique(ctx, s.abilities, 'ability', ['abilities']);
  });
export type Species = z.infer<typeof SpeciesSchema>;

export const SpeciesFileSchema = z.array(SpeciesSchema).superRefine((list, ctx) => {
  checkUnique(ctx, list.map((s) => s.id), 'species id');
  const ids = new Set(list.map((s) => s.id));
  for (const [i, s] of list.entries()) {
    if (s.megaOf && !ids.has(s.megaOf)) ctx.addIssue({ code: 'custom', message: `megaOf ${s.megaOf} is not in the file`, path: [i, 'megaOf'] });
    for (const m of s.megas ?? []) if (!ids.has(m)) ctx.addIssue({ code: 'custom', message: `mega ${m} is not in the file`, path: [i, 'megas'] });
  }
  for (let i = 1; i < list.length; i++) {
    if ((list[i - 1] as Species).id > (list[i] as Species).id) {
      ctx.addIssue({ code: 'custom', message: 'species must be sorted by id', path: [i] });
      return;
    }
  }
});

export const MoveSchema = z.strictObject({
  id: ShowdownIdSchema,
  name: z.string().min(1),
  type: PokemonTypeSchema,
  category: z.enum(['Physical', 'Special', 'Status']),
  basePower: z.number().int().nonnegative(),
  /** `true` = never misses. */
  accuracy: z.union([z.number().int().min(1).max(100), z.literal(true)]),
  pp: z.number().int().positive(),
  priority: z.number().int().min(-7).max(5),
  /** Showdown target (`normal`, `allAdjacentFoes`, `self`, ...). */
  target: z.string().min(1),
  /** Showdown move flags that are set (`contact`, `protect`, `sound`, ...). */
  flags: z.array(z.string().min(1)),
  /** One-line plain description. */
  desc: z.string().min(1).exactOptional(),
});
export type Move = z.infer<typeof MoveSchema>;

export const ItemSchema = z.strictObject({
  id: ShowdownIdSchema,
  name: z.string().min(1),
  /** Mega Stone: which base species becomes which Mega. */
  mega: z.strictObject({ base: ShowdownIdSchema, forme: ShowdownIdSchema }).exactOptional(),
  legal: z.array(RegulationIdSchema),
  desc: z.string().min(1).exactOptional(),
});
export type Item = z.infer<typeof ItemSchema>;

export const AbilitySchema = z.strictObject({
  id: ShowdownIdSchema,
  name: z.string().min(1),
  desc: z.string().min(1).exactOptional(),
});
export type PokemonAbility = z.infer<typeof AbilitySchema>;

function sortedUniqueIds<T extends { id: string }>(what: string) {
  return (list: T[], ctx: z.core.$RefinementCtx<T[]>) => {
    checkUnique(ctx, list.map((x) => x.id), `${what} id`);
    for (let i = 1; i < list.length; i++) {
      if ((list[i - 1] as T).id > (list[i] as T).id) {
        ctx.addIssue({ code: 'custom', message: `${what}s must be sorted by id`, path: [i] });
        return;
      }
    }
  };
}
export const MovesFileSchema = z.array(MoveSchema).superRefine(sortedUniqueIds<Move>('move'));
export const ItemsFileSchema = z.array(ItemSchema).superRefine(sortedUniqueIds<Item>('item'));
export const AbilitiesFileSchema = z.array(AbilitySchema).superRefine(sortedUniqueIds<PokemonAbility>('ability'));

const Multiplier = z.union([z.literal(0), z.literal(0.5), z.literal(1), z.literal(2)]);
/** damage[attacking][defending] multiplier, all 18 × 18 present. */
export const TypeChartSchema = z.strictObject({
  types: z.array(PokemonTypeSchema).length(POKEMON_TYPES.length),
  damage: z.record(PokemonTypeSchema, z.record(PokemonTypeSchema, Multiplier)),
});
export type TypeChart = z.infer<typeof TypeChartSchema>;

/** species id → sorted, de-duplicated legal move ids. */
export const LearnsetsSchema = z.record(ShowdownIdSchema, z.array(ShowdownIdSchema)).superRefine((rec, ctx) => {
  for (const [id, moves] of Object.entries(rec)) {
    checkUnique(ctx, moves, `move for ${id}`, [id]);
    if (moves.some((m, i) => i > 0 && (moves[i - 1] as string) > m)) ctx.addIssue({ code: 'custom', message: 'moves must be sorted', path: [id] });
  }
});
export type Learnsets = z.infer<typeof LearnsetsSchema>;

// ---- usage (Smogon monthly chaos) ------------------------------------------------------

export const ShareSchema = z.strictObject({ id: ShowdownIdSchema, share: Rate });
export const SpreadShareSchema = z.strictObject({ nature: NatureSchema, sp: SpSpreadSchema, share: Rate });
export const CheckSchema = z.strictObject({
  id: ShowdownIdSchema,
  /** Weighted number of encounters. */
  n: z.number().nonnegative(),
  /** Smogon's score: chance the checked Pokémon is KOed or forced out. */
  p: Rate,
  /** Standard deviation of p. */
  d: z.number().nonnegative(),
});

export const UsageEntrySchema = z.strictObject({
  id: ShowdownIdSchema,
  rank: z.number().int().positive(),
  /** Weighted usage share. */
  usage: Rate,
  raw: Count,
  abilities: z.array(ShareSchema).max(3),
  items: z.array(ShareSchema).max(6),
  moves: z.array(ShareSchema).max(10),
  teammates: z.array(ShareSchema).max(12),
  spreads: z.array(SpreadShareSchema).max(8),
  /** Only rows with n ≥ 20, at most 15. */
  checks: z.array(CheckSchema).max(15),
});
export type UsageEntry = z.infer<typeof UsageEntrySchema>;

export const UsageSchema = z
  .strictObject({
    synthetic: z.literal(true).exactOptional(),
    source: z.literal('smogon'),
    attribution: FileAttributionSchema,
    regulation: RegulationIdSchema,
    format: FormatIdSchema,
    cutoff: CutoffSchema,
    month: z.string().regex(/^\d{4}-\d{2}$/),
    battles: Count,
    /** Sorted by rank. */
    pokemon: z.array(UsageEntrySchema),
  })
  .superRefine((u, ctx) => {
    checkUnique(ctx, u.pokemon.map((p) => p.id), 'species', ['pokemon']);
    for (const [i, p] of u.pokemon.entries()) {
      if (p.rank !== i + 1) {
        ctx.addIssue({ code: 'custom', message: 'pokemon must be sorted by rank 1..n', path: ['pokemon', i, 'rank'] });
        return;
      }
    }
  });
export type Usage = z.infer<typeof UsageSchema>;

export const UsageIndexEntrySchema = z.strictObject({
  regulation: RegulationIdSchema,
  format: FormatIdSchema,
  cutoff: CutoffSchema,
  month: z.string().regex(/^\d{4}-\d{2}$/),
  battles: Count,
  /** `usage/<format>-<cutoff>.json` */
  file: z.string().regex(/^usage\/gen\d+[a-z0-9]+-\d+\.json$/),
  synthetic: z.literal(true).exactOptional(),
});
export const UsageIndexSchema = z.array(UsageIndexEntrySchema).superRefine((list, ctx) => {
  checkUnique(ctx, list.map((e) => e.file), 'usage file');
  for (const [i, e] of list.entries()) {
    if (e.file !== usageFile(e.format, e.cutoff)) ctx.addIssue({ code: 'custom', message: `expected ${usageFile(e.format, e.cutoff)}`, path: [i, 'file'] });
  }
});
export type UsageIndex = z.infer<typeof UsageIndexSchema>;

export function usageFile(format: string, cutoff: number): string {
  return `usage/${format}-${cutoff}.json`;
}

// ---- tournaments.json (Limitless aggregates; no player names) --------------------------

export const RecordSchema = z.strictObject({ wins: Count, losses: Count, ties: Count });

export const TeamMemberSchema = z.strictObject({
  species: ShowdownIdSchema,
  item: ShowdownIdSchema.exactOptional(),
  ability: ShowdownIdSchema.exactOptional(),
  moves: z.array(ShowdownIdSchema).max(4),
  nature: NatureSchema.exactOptional(),
});

export const TournamentRefSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  date: IsoDate,
  players: Count,
  url: Url,
});

export const SpeciesResultSchema = z.strictObject({
  id: ShowdownIdSchema,
  /** Teams that registered it. */
  teams: Count,
  share: Rate,
  wins: Count,
  losses: Count,
  ties: Count,
  /** Game-weighted win rate, null without games. */
  wr: Rate.nullable(),
  /** Wilson lower bound (z = 1.96) of wr. */
  wrLower: Rate.nullable(),
  /** Teams that reached a top cut. */
  topCut: Count.exactOptional(),
  /** Held items on the open team lists that registered it, as shares of those teams (Champions has no Tera). */
  items: z.array(ShareSchema).max(6).exactOptional(),
  abilities: z.array(ShareSchema).max(3).exactOptional(),
  moves: z.array(ShareSchema).max(10).exactOptional(),
  natures: z.array(z.strictObject({ nature: NatureSchema, share: Rate })).max(5).exactOptional(),
});

export const ArchetypeSchema = z.strictObject({
  id: Slug,
  label: z.string().min(1),
  /** 2–4 species that define the archetype. */
  core: z.array(ShowdownIdSchema).min(2).max(4),
  teams: Count,
  share: Rate,
  wins: Count,
  losses: Count,
  ties: Count,
  wr: Rate.nullable(),
});

export const TopTeamSchema = z.strictObject({
  tournamentId: z.string().min(1),
  placing: z.number().int().positive(),
  record: RecordSchema,
  members: z.array(TeamMemberSchema).min(1).max(6),
});

export const TournamentsSchema = z
  .strictObject({
    synthetic: z.literal(true).exactOptional(),
    source: z.literal('limitless'),
    attribution: FileAttributionSchema,
    regulation: RegulationIdSchema,
    /** Limitless format code (`M-C`). */
    format: z.string().min(1),
    window: z.strictObject({ label: z.string().min(1), from: IsoDate, to: IsoDate }),
    totals: z.strictObject({ tournaments: Count, players: Count, teams: Count }),
    tournaments: z.array(TournamentRefSchema),
    species: z.array(SpeciesResultSchema),
    archetypes: z.array(ArchetypeSchema),
    /** Latest top-cut teams, newest first; player names stripped at ingest. */
    teams: z.array(TopTeamSchema),
  })
  .superRefine((t, ctx) => {
    checkUnique(ctx, t.species.map((s) => s.id), 'species', ['species']);
    checkUnique(ctx, t.archetypes.map((a) => a.id), 'archetype', ['archetypes']);
    const known = new Set(t.tournaments.map((x) => x.id));
    for (const [i, team] of t.teams.entries()) {
      if (!known.has(team.tournamentId)) ctx.addIssue({ code: 'custom', message: `unknown tournament ${team.tournamentId}`, path: ['teams', i] });
    }
  });
export type Tournaments = z.infer<typeof TournamentsSchema>;

// ---- h2h.json (Showdown Bo3 replays) ---------------------------------------------------

const ReplayEdgeSchema = EdgeSchema.refine((e) => e.source === 'replays' && e.n !== undefined, {
  message: "h2h edges need source 'replays' and n",
});

export const H2HSchema = z.strictObject({
  synthetic: z.literal(true).exactOptional(),
  source: z.literal('showdown-replays'),
  attribution: FileAttributionSchema,
  regulation: RegulationIdSchema,
  format: FormatIdSchema,
  window: z.strictObject({ label: z.string().min(1), from: IsoDate, to: IsoDate }),
  replays: Count,
  /** Directed: a's side beats sides that bring b; both directions present. */
  counters: z.array(ReplayEdgeSchema),
  /** Undirected (a < b): brought together. */
  synergies: z.array(ReplayEdgeSchema),
});
export type H2H = z.infer<typeof H2HSchema>;

// ---- speed.json ------------------------------------------------------------------------

export const SpeedEntrySchema = z.strictObject({
  id: ShowdownIdSchema,
  base: BaseStat,
  /** Speed of the most common spread: floor((base + SP + 20) × nature). */
  speed: z.number().int().positive(),
  nature: NatureSchema,
  /** Speed Stat Points of that spread. */
  sp: z.number().int().min(0).max(32),
  /** Share of the spread among this species' spreads. */
  share: Rate,
  /** 32 SP, +Spe nature. */
  max: z.number().int().positive(),
  /** 0 SP, neutral nature. */
  neutral: z.number().int().positive(),
  /** 0 SP, −Spe nature (Trick Room). */
  min: z.number().int().positive(),
  /** Choice Scarf: share of sets holding it and the scarfed Speed of the common spread (× 1.5). */
  scarf: z.strictObject({ share: Rate, speed: z.number().int().positive() }).exactOptional(),
  /** Share of sets with Tailwind (doubles the side's Speed for four turns). */
  tailwind: Rate.exactOptional(),
  /** Share of sets with Trick Room (slower Pokémon move first for five turns). */
  trickRoom: Rate.exactOptional(),
});

export const SpeedTiersSchema = z
  .strictObject({
    synthetic: z.literal(true).exactOptional(),
    regulation: RegulationIdSchema,
    format: FormatIdSchema,
    cutoff: CutoffSchema.exactOptional(),
    month: z.string().regex(/^\d{4}-\d{2}$/).exactOptional(),
    /** Sorted by speed desc, then id. */
    entries: z.array(SpeedEntrySchema),
  })
  .superRefine((s, ctx) => {
    for (let i = 1; i < s.entries.length; i++) {
      const a = s.entries[i - 1] as z.infer<typeof SpeedEntrySchema>;
      const b = s.entries[i] as z.infer<typeof SpeedEntrySchema>;
      if (a.speed < b.speed || (a.speed === b.speed && a.id > b.id)) {
        ctx.addIssue({ code: 'custom', message: 'entries must be sorted by speed desc, then id', path: ['entries', i] });
        return;
      }
    }
  });
export type SpeedTiers = z.infer<typeof SpeedTiersSchema>;

// ---- public/dex.json (browser shard) ---------------------------------------------------

export const DexShardSchema = z.strictObject({
  schema: z.literal(1),
  regulation: RegulationIdSchema,
  species: SpeciesFileSchema,
  moves: MovesFileSchema,
  items: ItemsFileSchema,
  abilities: AbilitiesFileSchema,
  learnsets: LearnsetsSchema,
  typechart: TypeChartSchema,
});
export type DexShard = z.infer<typeof DexShardSchema>;

// ---- ledger/<source>.json (pipeline state, anonymised) -----------------------------------

/**
 * One replayed game: `<date> <winner> <team1> <brought1> <team2> <brought2>`, where a team is
 * the six registered species and `brought` the ones that battled in order of first appearance
 * (the first two led). Both are comma-separated indexes into `species`; winner is 1 or 2.
 */
export const LedgerGameSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2} [12] \d+(?:,\d+){0,5} \d+(?:,\d+){0,5} \d+(?:,\d+){0,5} \d+(?:,\d+){0,5}$/, 'expected "<date> <winner> <team1> <brought1> <team2> <brought2>"');

/**
 * Rolling store of parsed Showdown replays, so a daily crawl capped at a few hundred logs adds
 * up to a meaningful window. No player names, replay ids or ratings: species, outcome and date.
 */
export const ReplayLedgerSchema = z
  .strictObject({
    schema: z.literal(1),
    source: z.literal('showdown-replays'),
    regulation: RegulationIdSchema,
    format: FormatIdSchema,
    /** Upload time (Unix seconds) of the newest replay ingested; the next run reads only newer ones. */
    cursor: z.number().int().nonnegative(),
    /** Species dictionary, sorted; games refer to it by index. */
    species: z.array(ShowdownIdSchema),
    /** Oldest first. */
    games: z.array(LedgerGameSchema),
  })
  .superRefine((l, ctx) => {
    checkUnique(ctx, l.species, 'species', ['species']);
    for (const [i, g] of l.games.entries()) {
      const parts = g.split(' ').slice(2);
      if (parts.some((p) => p.split(',').some((x) => Number(x) >= l.species.length))) {
        ctx.addIssue({ code: 'custom', message: 'species index out of range', path: ['games', i] });
        return;
      }
    }
  });
export type ReplayLedger = z.infer<typeof ReplayLedgerSchema>;

// ---- file registry ---------------------------------------------------------------------

export const POKEMON_FILES = {
  'meta.json': { schema: PokemonMetaSchema, custody: 'A' },
  'regulations.json': { schema: RegulationsFileSchema, custody: 'A' },
  'dex/species.json': { schema: SpeciesFileSchema, custody: 'A' },
  'dex/moves.json': { schema: MovesFileSchema, custody: 'A' },
  'dex/items.json': { schema: ItemsFileSchema, custody: 'A' },
  'dex/abilities.json': { schema: AbilitiesFileSchema, custody: 'A' },
  'dex/typechart.json': { schema: TypeChartSchema, custody: 'A' },
  'dex/learnsets.json': { schema: LearnsetsSchema, custody: 'A' },
  'usage/index.json': { schema: UsageIndexSchema, custody: 'A' },
  'usage/<format>-<cutoff>.json': { schema: UsageSchema, custody: 'A' },
  'tournaments.json': { schema: TournamentsSchema, custody: 'A' },
  'h2h.json': { schema: H2HSchema, custody: 'A' },
  'speed.json': { schema: SpeedTiersSchema, custody: 'A' },
  'public/dex.json': { schema: DexShardSchema, custody: 'A' },
  /** Pipeline state (not read by pages): anonymised per-source ledgers, e.g. ledger/showdown-replays.json. */
  'ledger/<source>.json': { schema: ReplayLedgerSchema, custody: 'A' },
} as const;

export const POKEMON_CURATED = {
  'regulations.yaml': RegulationsFileSchema,
} as const;
