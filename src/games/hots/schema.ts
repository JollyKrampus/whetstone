/**
 * Data contracts for Heroes of the Storm (SPEC §5). Every file the HotS pipeline writes to
 * data/current/hots/ (class A / A-SA) or data/private/hots/ (class B / C), and every curated
 * YAML file under curated/hots/, has a schema here. Browser-safe (zod only).
 *
 * Identity rules (critique D4):
 * - Hero `id` = game attributeId (`Abat`, `HXAL`, `CCho`, `Gall`); `slug` = lowercase
 *   alphanumerics of the English name (`liming`, `thebutcher`).
 * - Cho and Gall are separate heroes (kits, talents) AND members of the composite draft entity
 *   `chogall` (id = slug = 'chogall', `members: ['CCho','Gall']`, 2 draft slots, one page).
 * - "Entity ids" (edges, stats, theory, pro, draft shard) are draftable entity ids: hero ids,
 *   with members collapsed into their composite (`chogall`, never `CCho`/`Gall`).
 * - Map ids are our own kebab-case slugs (`cursed-hollow`).
 * - Rates are fractions in [0, 1]; `delta` values are percentage points.
 */
import { z } from 'zod';
import {
  Count,
  DataPath,
  EdgeSchema,
  FileAttributionSchema,
  gameMetaSchema,
  IsoDate,
  IsoDateTime,
  Rate,
  ReasonSchema,
  Score,
  Slug,
  Url,
  checkUnique,
} from '../../core/schemas.ts';

// ---- vocabulary ------------------------------------------------------------------------

export const HOTS_ROLES = ['Tank', 'Bruiser', 'Healer', 'Support', 'Ranged Assassin', 'Melee Assassin'] as const;
export const HeroRoleSchema = z.enum(HOTS_ROLES);
export type HeroRole = z.infer<typeof HeroRoleSchema>;

export const AttackTypeSchema = z.enum(['Melee', 'Ranged']);
/** heroes-data2 `franchise`, with its `Starcraft` normalised to `StarCraft`. `Classic` = Blizzard classics / Nexus originals. */
export const FranchiseSchema = z.enum(['Warcraft', 'StarCraft', 'Diablo', 'Overwatch', 'Classic']);
export const DifficultySchema = z.enum(['Easy', 'Medium', 'Hard', 'Very Hard']);

export const TALENT_TIERS = ['1', '4', '7', '10', '13', '16', '20'] as const;
export const TalentTierSchema = z.enum(TALENT_TIERS);
export type TalentTier = z.infer<typeof TalentTierSchema>;

/** Tags the mechanics extractor derives from ability/talent text (SPEC §5.1.1). */
export const MECHANIC_TAGS = [
  // crowd control
  'stun', 'root', 'slow', 'silence', 'blind', 'polymorph', 'sleep', 'taunt', 'fear', 'displace', 'pull', 'time-stop',
  // defensive / mobility
  'unstoppable', 'invulnerable', 'stasis', 'untargetable', 'cleanse', 'spell-armor', 'physical-armor', 'block',
  'shield', 'heal-self', 'heal-ally', 'stealth', 'reveal', 'dash', 'teleport', 'unkillable',
  // damage / macro
  'percent-hp-damage', 'anti-heal', 'armor-shred', 'burst', 'sustained-dps', 'poke', 'aoe', 'dot', 'summons',
  'global', 'waveclear', 'siege', 'channel', 'aa-reliant', 'mana-hungry',
] as const;
/** Tags only a curator can assign (curated/hots/traits.yaml, SPEC §5.1.2). */
export const TRAIT_TAGS = [
  'immobile', 'dive', 'split-push', 'vulnerable-body', 'frontline', 'peel', 'engage', 'save',
] as const;
export const HERO_TAGS = [...MECHANIC_TAGS, ...TRAIT_TAGS] as const;
export const HeroTagSchema = z.enum(HERO_TAGS);
export type HeroTag = z.infer<typeof HeroTagSchema>;

/** Role and attack-type selectors usable in rules next to hero tags. */
export const ROLE_TAGS = [
  'role:tank', 'role:bruiser', 'role:healer', 'role:support', 'role:ranged-assassin', 'role:melee-assassin',
  'type:melee', 'type:ranged',
] as const;
export const RuleAtomSchema = z.enum([...HERO_TAGS, ...ROLE_TAGS]);
export type RuleAtom = z.infer<typeof RuleAtomSchema>;

/** `role:<kebab role>` selector for a role, e.g. 'Ranged Assassin' → 'role:ranged-assassin'. */
export function roleTag(role: HeroRole): RuleAtom {
  return `role:${role.toLowerCase().replace(/ /g, '-')}` as RuleAtom;
}

/**
 * One alternative of a rule side: tags joined by `&` must ALL match (`burst&type:ranged`).
 * A rule side is a list of alternatives; ANY alternative matching is enough.
 */
export const RuleExprSchema = z.string().superRefine((expr, ctx) => {
  const parts = expr.split('&');
  for (const part of parts) {
    if (!RuleAtomSchema.safeParse(part).success) {
      ctx.addIssue({ code: 'custom', message: `unknown tag "${part}" in rule expression "${expr}"` });
    }
  }
});

export const MAP_TAGS = [
  'large', 'small', 'three-lane', 'two-lane', 'single-lane', 'channel-objective', 'pve-objective',
  'teamfight', 'structure-objective', 'long-rotations', 'escort-objective', 'push-objective',
] as const;
export const MapTagSchema = z.enum(MAP_TAGS);
export type MapTag = z.infer<typeof MapTagSchema>;

export const MapKindSchema = z.enum(['standard', 'aram', 'brawl']);
export const GameModeSchema = z.enum(['sl', 'qm', 'aram']);
export type GameMode = z.infer<typeof GameModeSchema>;
export const TimeframeSchema = z.enum(['current', 'previous']);
export type Timeframe = z.infer<typeof TimeframeSchema>;

// ---- ids -------------------------------------------------------------------------------

/** Game build `2.57.0.98348` (PTR builds carry `_ptr`). */
export const BuildSchema = z.string().regex(/^\d+\.\d+\.\d+\.\d+(?:_ptr)?$/, 'expected a build like 2.57.0.98348');
/** Major patch `2.57`. */
export const MajorSchema = z.string().regex(/^\d+\.\d+$/, 'expected a major patch like 2.57');
/** Hero attributeId, e.g. `Abat`, `HXAL`, `Tra0`. */
export const AttributeIdSchema = z.string().regex(/^[A-Za-z0-9]{4}$/, 'expected a 4-character attributeId');
/** Hero slug: lowercase alphanumerics of the English name (`liming`). */
export const HeroSlugSchema = z.string().regex(/^[a-z0-9]+$/, 'expected lowercase alphanumerics');
/** Draftable entity id: an attributeId or a composite slug (`chogall`). */
export const EntityIdSchema = z.union([AttributeIdSchema, HeroSlugSchema]);
export const MapSlugSchema = Slug;

const LowerText = z.string().min(1).refine((s) => s === s.toLowerCase().trim(), 'expected lowercase, trimmed text');

/** Placeholders a rule's `why` template may use. */
function templateCheck(allowed: readonly string[]) {
  return z.string().min(8).superRefine((tpl, ctx) => {
    for (const m of tpl.matchAll(/\{([^}]*)\}/g)) {
      if (!allowed.includes(m[1] ?? '')) {
        ctx.addIssue({ code: 'custom', message: `unknown placeholder {${m[1]}}; allowed: ${allowed.map((a) => `{${a}}`).join(' ')}` });
      }
    }
  });
}

function sortedBy<T>(key: (x: T) => string, what: string) {
  return (list: T[], ctx: z.core.$RefinementCtx<T[]>) => {
    for (let i = 1; i < list.length; i++) {
      const prev = key(list[i - 1] as T);
      const cur = key(list[i] as T);
      if (prev > cur) {
        ctx.addIssue({ code: 'custom', message: `${what} must be sorted ascending ("${prev}" before "${cur}")`, path: [i] });
        return;
      }
    }
  };
}

/**
 * Accepts last-good files written before a statistics source was removed (2026-10-10, SPEC §12):
 * drops keys only that source used, so a data branch that still holds them parses (and the next
 * run rewrites them). The output type never has them and the pipeline never writes them.
 */
function dropLegacyKeys<T extends z.ZodType>(schema: T, keys: readonly string[]) {
  return z.preprocess((value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value) || !keys.some((k) => k in value)) return value;
    const copy: Record<string, unknown> = { ...(value as Record<string, unknown>) };
    for (const k of keys) delete copy[k];
    return copy;
  }, schema);
}

// ---- meta.json -------------------------------------------------------------------------

const HotsMetaExtraObject = z.strictObject({
  /** Live build (TACT). */
  build: BuildSchema,
  /** heroes-data2 build the hero data was generated from; differs from `build` while data lags. */
  dataBuild: BuildSchema.exactOptional(),
  ptrBuild: BuildSchema.exactOptional(),
  major: MajorSchema,
  majorSince: IsoDate,
  /** Builds of the current major, newest first. */
  builds: z.array(BuildSchema).min(1),
  /** heroes-images tag the vendored images come from. */
  assetsTag: z.string().min(1).exactOptional(),
  /** When the pipeline first saw the current live `build` on the version server. */
  buildSeenAt: IsoDateTime.exactOptional(),
  /** heroes-data2 has lagged the live build for more than 48 hours: hero data is from `dataBuild`. */
  dataPending: z.boolean().exactOptional(),
});
/** meta.json `extra`. A legacy `hpMode` (the removed statistics source's switch) is dropped on read. */
export const HotsMetaExtraSchema = dropLegacyKeys(HotsMetaExtraObject, ['hpMode']);
export const HotsMetaSchema = gameMetaSchema('hots', HotsMetaExtraSchema);
export type HotsMeta = z.infer<typeof HotsMetaSchema>;

// ---- heroes.json -----------------------------------------------------------------------

export const AbilityKindSchema = z.enum(['basic', 'heroic', 'trait', 'mount', 'active']);

export const AbilitySchema = z.strictObject({
  /** heroes-data2 linkId, e.g. `AbathurSymbiote|AbathurSymbiote|Q`. */
  id: z.string().min(1),
  name: z.string().min(1),
  /** Q W E R D Z or 1-9; empty for passives. */
  hotkey: z.string().regex(/^[QWERDZ1-9]?$/),
  kind: AbilityKindSchema,
  /** Seconds. */
  cooldown: z.number().nonnegative().exactOptional(),
  /** Human text, e.g. `60 Mana`, `20 Fury`. */
  cost: z.string().min(1).exactOptional(),
  /** Plain text: game markup rendered, `\n` for line breaks, scaling as "(+4% per level)". */
  text: z.string().min(1),
  icon: DataPath,
});
export type Ability = z.infer<typeof AbilitySchema>;

/** Which ability a talent modifies (heroes-data2 abilityType, Heroic → R, Trait → D). */
export const TalentAbilitySchema = z.enum(['Q', 'W', 'E', 'R', 'D', 'Z', 'Active', 'Passive']);

export const TalentSchema = z.strictObject({
  /** heroes-data2 talentId (also the key talent builds refer to). */
  id: z.string().min(1),
  name: z.string().min(1),
  text: z.string().min(1),
  icon: DataPath,
  ability: TalentAbilitySchema.exactOptional(),
  /** 1-based position within the tier. */
  sort: z.number().int().min(1),
  quest: z.boolean().exactOptional(),
});
export type Talent = z.infer<typeof TalentSchema>;

const tierArray = z.array(TalentSchema).superRefine((list, ctx) => {
  checkUnique(ctx, list.map((t) => t.id), 'talent id');
  sortedBy<Talent>((t) => String(t.sort).padStart(3, '0'), 'talents (by sort)')(list, ctx);
});
export const TalentsSchema = z.strictObject({
  '1': tierArray, '4': tierArray, '7': tierArray, '10': tierArray, '13': tierArray, '16': tierArray, '20': tierArray,
});
export type Talents = z.infer<typeof TalentsSchema>;

export const EvidenceSchema = z.strictObject({
  /** `curated` = from curated/hots/traits.yaml (snippet = the curator's justification). */
  kind: z.enum(['ability', 'talent', 'curated']),
  /** Ability/talent name, or `traits.yaml` for curated tags. */
  name: z.string().min(1),
  /** Short excerpt of the text that matched (or the curator's one-liner). */
  snippet: z.string().min(1),
});
export const MechanicSchema = z.strictObject({
  tag: HeroTagSchema,
  evidence: z.array(EvidenceSchema).min(1),
});
export type Mechanic = z.infer<typeof MechanicSchema>;

export const RatingsSchema = z.strictObject({
  damage: z.number().int().min(0).max(10),
  utility: z.number().int().min(0).max(10),
  survivability: z.number().int().min(0).max(10),
  complexity: z.number().int().min(0).max(10),
});

export const HeroSchema = z
  .strictObject({
    id: EntityIdSchema,
    slug: HeroSlugSchema,
    name: z.string().min(1),
    /** Epithet, e.g. "Evolution Master". */
    title: z.string().min(1),
    role: HeroRoleSchema,
    /** Flex role (Varian by heroic, Cho'gall composite). */
    roleAlt: HeroRoleSchema.exactOptional(),
    type: AttackTypeSchema,
    franchise: FranchiseSchema,
    difficulty: DifficultySchema,
    ratings: RatingsSchema,
    releaseDate: IsoDate.exactOptional(),
    /** Lowercase search aliases (nicknames, HC slugs like `li-ming`, localized names). */
    aliases: z.array(LowerText),
    portrait: DataPath,
    abilities: z.array(AbilitySchema),
    talents: TalentsSchema,
    /** Composite only: member hero ids, e.g. ['CCho', 'Gall']. */
    members: z.tuple([AttributeIdSchema, AttributeIdSchema]).exactOptional(),
    /** Member only: id of the composite it belongs to. */
    memberOf: HeroSlugSchema.exactOptional(),
    mechanics: z.array(MechanicSchema),
    /** Last build whose data diff touched this hero (derived from the game-data diffs). */
    lastChangedBuild: BuildSchema.exactOptional(),
    /** Released within the "new hero" window; drives the badge and "early data" labels. */
    isNew: z.boolean(),
    /** heroes-data2 item key (`Wizard` for Li-Ming). */
    hdpId: z.string().min(1).exactOptional(),
    /** Large draft-screen portrait (180×212), e.g. for hero page headers; `portrait` is the 128×128 pick button. */
    draftPortrait: DataPath.exactOptional(),
  })
  .superRefine((h, ctx) => {
    if (h.members) {
      if (h.id !== h.slug) ctx.addIssue({ code: 'custom', message: 'composite id must equal its slug', path: ['id'] });
      if (h.memberOf) ctx.addIssue({ code: 'custom', message: 'a composite cannot be a member', path: ['memberOf'] });
    } else {
      if (!AttributeIdSchema.safeParse(h.id).success) {
        ctx.addIssue({ code: 'custom', message: 'non-composite hero id must be an attributeId', path: ['id'] });
      }
      if (h.abilities.length === 0) ctx.addIssue({ code: 'custom', message: 'hero has no abilities', path: ['abilities'] });
    }
    checkUnique(ctx, h.abilities.map((a) => a.id), 'ability id', ['abilities']);
    checkUnique(ctx, h.mechanics.map((m) => m.tag), 'mechanic tag', ['mechanics']);
    checkUnique(ctx, h.aliases, 'alias', ['aliases']);
  });
export type Hero = z.infer<typeof HeroSchema>;

export const HeroesFileSchema = z.array(HeroSchema).superRefine((list, ctx) => {
  checkUnique(ctx, list.map((h) => h.id), 'hero id');
  checkUnique(ctx, list.map((h) => h.slug), 'hero slug');
  sortedBy<Hero>((h) => h.slug, 'heroes (by slug)')(list, ctx);
  const byId = new Map(list.map((h) => [h.id, h]));
  for (const [i, h] of list.entries()) {
    for (const m of h.members ?? []) {
      if (byId.get(m)?.memberOf !== h.id) {
        ctx.addIssue({ code: 'custom', message: `member ${m} of ${h.id} is missing or lacks memberOf: '${h.id}'`, path: [i, 'members'] });
      }
    }
    if (h.memberOf && !byId.get(h.memberOf)?.members?.includes(h.id)) {
      ctx.addIssue({ code: 'custom', message: `${h.id}.memberOf points at ${h.memberOf}, which does not list it`, path: [i, 'memberOf'] });
    }
  }
});

// ---- maps.json -------------------------------------------------------------------------

export const MapProfileSchema = z.strictObject({
  size: z.enum(['small', 'medium', 'large']),
  lanes: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  /** One-line plain description of the objective. */
  objective: z.string().min(1),
  tags: z.array(MapTagSchema),
});

export const MapSchema = z.strictObject({
  id: MapSlugSchema,
  name: z.string().min(1),
  kind: MapKindSchema,
  /** In the current Storm League pool. */
  ranked: z.boolean(),
  /**
   * How `ranked` was decided. The pipeline always writes 'curated' (curated/hots/ranked-pool.yaml);
   * 'stats' is kept only so readers of older files and a future measured pool still type-check.
   */
  rankedSource: z.enum(['stats', 'curated']),
  image: DataPath,
  profile: MapProfileSchema,
});
export type GameMap = z.infer<typeof MapSchema>;

/** maps.json. A legacy `hp` key (the removed statistics source's map ref) is dropped on read. */
export const MapsFileSchema = z.array(dropLegacyKeys(MapSchema, ['hp'])).superRefine((list, ctx) => {
  checkUnique(ctx, list.map((m) => m.id), 'map id');
  sortedBy<GameMap>((m) => m.id, 'maps (by id)')(list, ctx);
});

// ---- patches.json ----------------------------------------------------------------------

export const ChangeDirSchema = z.enum(['buff', 'nerf', 'change', 'rework']);

/**
 * What a change does, in our own terms: `numeric` carries the value's label and its numbers;
 * the rest are qualitative and never carry Blizzard's wording.
 */
export const ChangeKindSchema = z.enum(['numeric', 'added', 'removed', 'reworked', 'changed', 'bugfix']);
/** Units we keep with numbers: percent and seconds. */
export const ChangeUnitSchema = z.enum(['%', 's']);

/**
 * One change of one hero, as our own structured summary (never the sentence from the notes).
 * `text` is a template sentence generated from the other fields, e.g. "Damage 345 → 360",
 * "Cooldown 12 s → 10 s", "Effect changed (see Blizzard's notes)".
 */
export const PatchChangeSchema = z
  .strictObject({
    /** Our section label: 'Base', 'Abilities', 'Talents', 'Level 13', 'New Hero', 'Game data'... */
    section: z.string().min(1).max(40),
    /** Ability or talent the change is about (its name in the game data). */
    target: z.string().min(1).max(60).exactOptional(),
    level: TalentTierSchema.exactOptional(),
    kind: ChangeKindSchema,
    /** numeric: short label of the value ('Damage', 'Cooldown', 'Health decay reduction'). */
    stat: z.string().min(1).max(48).exactOptional(),
    old: z.number().exactOptional(),
    new: z.number().exactOptional(),
    /** numeric without an old value: the signed amount ("reduced by 20%" → -20). */
    by: z.number().exactOptional(),
    unit: ChangeUnitSchema.exactOptional(),
    /** Qualitative lines of one kind about the same target, counted instead of listed. */
    count: z.number().int().min(2).exactOptional(),
    /** Our template sentence for the fields above. */
    text: z.string().min(1).max(160),
    dir: ChangeDirSchema.exactOptional(),
  })
  .superRefine((c, ctx) => {
    const numbers = c.stat !== undefined || c.old !== undefined || c.new !== undefined || c.by !== undefined || c.unit !== undefined;
    if (c.kind === 'numeric') {
      const pair = c.old !== undefined && c.new !== undefined;
      if (c.stat === undefined || pair === (c.by !== undefined)) {
        ctx.addIssue({ code: 'custom', message: 'a numeric change needs stat and either old and new, or by' });
      }
      if (c.count !== undefined) ctx.addIssue({ code: 'custom', message: 'numeric changes are not counted', path: ['count'] });
    } else if (numbers) {
      ctx.addIssue({ code: 'custom', message: `a ${c.kind} change carries no stat, numbers or unit` });
    }
  });

export const PatchHeroSchema = z.strictObject({
  verdict: z.enum(['buff', 'nerf', 'mixed', 'rework', 'new', 'change']).exactOptional(),
  changes: z.array(PatchChangeSchema).min(1),
});

/** Template of a qualitative line converted from a file written before summaries existed. */
const LEGACY_LINE = "Effect changed (see Blizzard's notes)";
/** Sections whose lines were always our own words, also in old files. */
const OWN_SECTIONS = new Set(['New Hero', 'Game data']);

/**
 * patches.json written before 2026-10-10 stored Blizzard's change sentences. Such a record (it
 * has no `notes`) is reduced on read to counts and our own lines, so the site never shows those
 * sentences and a not-yet-refreshed data directory still builds. The pipeline migrates old
 * records itself, keeping their numbers (transform/patches.ts migrateLegacyPatches).
 */
function legacyPatch(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || 'notes' in value) return value;
  const rec = value as Record<string, unknown>;
  const count = (n: number): string => `${n} ${n === 1 ? 'change' : 'changes'}`;
  const general = Array.isArray(rec.general) && rec.general.length > 0 ? [`General: ${count(rec.general.length)}`] : [];
  const maps =
    typeof rec.maps === 'object' && rec.maps !== null
      ? Object.fromEntries(Object.entries(rec.maps).map(([slug, lines]) => [slug, [`${count(Array.isArray(lines) ? lines.length : 0)} (see Blizzard's notes)`]]))
      : rec.maps;
  const heroes =
    typeof rec.heroes === 'object' && rec.heroes !== null
      ? Object.fromEntries(
          Object.entries(rec.heroes).map(([id, h]) => {
            const hero = (typeof h === 'object' && h !== null ? h : {}) as { changes?: unknown };
            const changes = (Array.isArray(hero.changes) ? hero.changes : []).map((c: unknown) => {
              const ch = (typeof c === 'object' && c !== null ? c : {}) as Record<string, unknown>;
              const own = OWN_SECTIONS.has(String(ch.section)) || ch.text === 'Full rework: new base abilities and talent tree.';
              const kind = ch.dir === 'rework' ? 'reworked' : ch.section === 'New Hero' ? 'added' : 'changed';
              const { text: _text, ...rest } = ch;
              return { ...rest, kind, text: own ? ch.text : kind === 'reworked' ? "Reworked (see Blizzard's notes)" : LEGACY_LINE };
            });
            return [id, { ...hero, changes }];
          }),
        )
      : rec.heroes;
  return { ...rec, notes: 'summary', general, ...(maps === undefined ? {} : { maps }), heroes };
}

export const PatchSchema = z.strictObject({
  /** `<date>-<kind>[-n]`, e.g. `2026-09-28-patch`, `2026-10-05-hotfix`. Used in /hots/patches/[id]/. */
  id: z.string().regex(/^\d{4}-\d{2}-\d{2}-[a-z0-9]+(?:-[a-z0-9]+)*$/),
  version: MajorSchema,
  build: BuildSchema.exactOptional(),
  date: IsoDate,
  title: z.string().min(1),
  url: Url,
  kind: z.enum(['patch', 'balance', 'hotfix', 'ptr']),
  /** Hash of the article section this record was parsed from (hotfixes append silently). */
  contentHash: z.string().regex(/^[0-9a-f]{16,64}$/),
  /**
   * How the lines were written: 'summary' = our own structured summaries (this schema). Records
   * without it predate the summaries and are converted on read (legacyPatch).
   */
  notes: z.literal('summary'),
  /** General (system) changes as our category counts, e.g. "Interface and audio: 2 changes". */
  general: z.array(z.string().min(1).max(80)),
  /** Per map: numeric changes as templates, then a count of the other changes. */
  maps: z.record(MapSlugSchema, z.array(z.string().min(1).max(120)).min(1)).exactOptional(),
  /** Keyed by hero id (members, not composites: notes list Cho and Gall separately). */
  heroes: z.record(AttributeIdSchema, PatchHeroSchema),
  newHeroes: z.array(AttributeIdSchema).exactOptional(),
});
export type Patch = z.infer<typeof PatchSchema>;

/** Newest first (date desc, then id desc). Records from before the summaries are converted on read. */
export const PatchesFileSchema = z.array(z.preprocess(legacyPatch, PatchSchema)).superRefine((list, ctx) => {
  checkUnique(ctx, list.map((p) => p.id), 'patch id');
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1] as Patch;
    const b = list[i] as Patch;
    if (a.date < b.date || (a.date === b.date && a.id < b.id)) {
      ctx.addIssue({ code: 'custom', message: 'patches must be sorted newest first', path: [i] });
      return;
    }
  }
});

// ---- diffs.json ------------------------------------------------------------------------

export const DiffEntrySchema = z.strictObject({
  kind: z.enum(['stat', 'ability', 'talent', 'ability-added', 'ability-removed', 'talent-added', 'talent-removed', 'talent-moved']),
  /** Ability/talent name, or the stat name for kind 'stat' ('Health', 'Basic Attack Damage'). */
  target: z.string().min(1),
  /** Changed field: 'cooldown', 'cost', 'text', 'damage', 'range', 'tier'... */
  field: z.string().min(1).exactOptional(),
  level: TalentTierSchema.exactOptional(),
  old: z.union([z.string(), z.number()]).exactOptional(),
  new: z.union([z.string(), z.number()]).exactOptional(),
});
export type DiffEntry = z.infer<typeof DiffEntrySchema>;

export const DiffSchema = z.strictObject({
  /** `<from>..<to>` */
  id: z.string().regex(/^\d+\.\d+\.\d+\.\d+(?:_ptr)?\.\.\d+\.\d+\.\d+\.\d+(?:_ptr)?$/),
  from: BuildSchema,
  to: BuildSchema,
  date: IsoDate.exactOptional(),
  heroes: z.record(AttributeIdSchema, z.array(DiffEntrySchema).min(1)),
});
export type Diff = z.infer<typeof DiffSchema>;

/** Newest `to` first. */
export const DiffsFileSchema = z.array(DiffSchema).superRefine((list, ctx) => {
  checkUnique(ctx, list.map((d) => d.id), 'diff id');
});

// ---- theory.json -----------------------------------------------------------------------

const TheoryEdgeSchema = EdgeSchema.refine((e) => e.source === 'theory' || e.source === 'curated', {
  message: "theory edges must have source 'theory' or 'curated'",
});

export const MapFitSchema = z.strictObject({
  hero: EntityIdSchema,
  map: MapSlugSchema,
  score: Score,
  reasons: z.array(ReasonSchema).min(1),
});
export type MapFit = z.infer<typeof MapFitSchema>;

export const TheorySchema = z
  .strictObject({
    /** Hash/version of rules.yaml + counters.yaml + synergies.yaml + maps.yaml used. */
    rulesVersion: z.string().min(1),
    /** Directed: a counters b. */
    counters: z.array(TheoryEdgeSchema),
    /** Undirected, stored with a < b. */
    synergies: z.array(TheoryEdgeSchema),
    mapFit: z.array(MapFitSchema),
  })
  .superRefine((t, ctx) => {
    checkUnique(ctx, t.counters.map((e) => `${e.a}>${e.b}`), 'counter pair', ['counters']);
    checkUnique(ctx, t.synergies.map((e) => `${e.a}+${e.b}`), 'synergy pair', ['synergies']);
    checkUnique(ctx, t.mapFit.map((f) => `${f.hero}@${f.map}`), 'map-fit pair', ['mapFit']);
    for (const [i, e] of t.synergies.entries()) {
      if (!(e.a < e.b)) ctx.addIssue({ code: 'custom', message: 'synergy edges must be stored with a < b', path: ['synergies', i] });
    }
    for (const [i, e] of t.counters.entries()) {
      if (e.a === e.b) ctx.addIssue({ code: 'custom', message: 'self edge', path: ['counters', i] });
    }
  });
export type Theory = z.infer<typeof TheorySchema>;

// ---- links.json ------------------------------------------------------------------------

export const LinkSchema = z.strictObject({
  site: z.enum(['icy-veins', 'psionic-storm', 'nexus-compendium', 'liquipedia', 'fandom', 'blizzard', 'youtube', 'twitch']),
  kind: z.enum(['guide', 'talents', 'calculator', 'matchups', 'maps', 'draft', 'wiki', 'esports', 'news', 'tierlist', 'live']),
  label: z.string().min(1),
  url: Url,
});
export type Link = z.infer<typeof LinkSchema>;

/**
 * Sites the pipeline links. A last-good file may still hold links to a site that is no longer
 * linked (a removed source); those are dropped on read instead of failing the whole file.
 */
const LINK_SITES: ReadonlySet<unknown> = new Set(LinkSchema.shape.site.options);

function dropRemovedLinks(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const keep = (list: unknown): unknown =>
    Array.isArray(list) ? list.filter((l) => !(typeof l === 'object' && l !== null && !LINK_SITES.has((l as { site?: unknown }).site))) : list;
  const v = value as { heroes?: unknown; general?: unknown };
  const heroes =
    typeof v.heroes === 'object' && v.heroes !== null && !Array.isArray(v.heroes)
      ? Object.fromEntries(Object.entries(v.heroes).map(([id, list]) => [id, keep(list)]))
      : v.heroes;
  return { ...value, heroes, general: keep(v.general) };
}

export const LinksSchema = z.preprocess(
  dropRemovedLinks,
  z.strictObject({
    /** Keyed by hero id (members, not composites; a composite page merges its members' links). */
    heroes: z.record(AttributeIdSchema, z.array(LinkSchema)),
    general: z.array(LinkSchema),
  }),
);
export type Links = z.infer<typeof LinksSchema>;

// ---- rotation.json ---------------------------------------------------------------------

export const RankedSeasonSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  start: IsoDate,
  end: IsoDate,
});

export const RotationSchema = z.strictObject({
  source: z.enum(['nexus-compendium', 'manual']),
  /**
   * "As of" time shown next to the rotation: when this content was first fetched. It stays put
   * while the content is unchanged (so dataHash does too); the last check is the source's
   * `fetchedAt` in meta.json.
   */
  fetchedAt: IsoDateTime,
  /**
   * Present (true) when the window had already ended at the last pipeline run: the source has not
   * published the new week yet (or could not be fetched), so no hero should be shown as free.
   * Written on the switch day itself, which changes dataHash and so redeploys the site.
   */
  lagging: z.literal(true).exactOptional(),
  start: IsoDate,
  end: IsoDate,
  allFree: z.boolean(),
  /** Hero ids (members, as the game rotates Cho and Gall separately). */
  heroes: z.array(AttributeIdSchema),
  ranked: RankedSeasonSchema.nullable(),
});
export type Rotation = z.infer<typeof RotationSchema>;

// ---- pro.json (class A-SA, Liquipedia, CC BY-SA 3.0) ------------------------------------

export const ProTournamentSchema = z.strictObject({
  /** Liquipedia page title, e.g. `Copium_Cup`, `Murky_Cup/3`. */
  id: z.string().min(1),
  name: z.string().min(1),
  url: Url,
  /** Liquipedia tier (1..4); omitted for showmatches. */
  tier: z.number().int().min(1).max(5).exactOptional(),
  region: z.string().min(1).exactOptional(),
  startDate: IsoDate,
  endDate: IsoDate.exactOptional(),
  /** Drafted maps counted from this tournament. */
  maps: Count,
});

export const ProHeroSchema = z.strictObject({
  hero: EntityIdSchema,
  picks: Count,
  bans: Count,
  wins: Count.exactOptional(),
  pickRate: Rate,
  banRate: Rate,
  /** (picks + bans) / maps */
  presence: Rate,
});

export const ProSchema = z
  .strictObject({
    /** Marks fixture/sample numbers; never present in pipeline output. */
    synthetic: z.literal(true).exactOptional(),
    attribution: FileAttributionSchema,
    window: z.strictObject({
      label: z.string().min(1),
      from: IsoDate,
      to: IsoDate,
      major: MajorSchema.exactOptional(),
    }),
    totals: z.strictObject({ tournaments: Count, maps: Count }),
    tournaments: z.array(ProTournamentSchema),
    /** Sorted by presence desc, then hero id. */
    heroes: z.array(ProHeroSchema),
  })
  .superRefine((p, ctx) => {
    if (p.attribution.license !== 'CC BY-SA 3.0') {
      ctx.addIssue({ code: 'custom', message: "pro.json is class A-SA: attribution.license must be 'CC BY-SA 3.0'", path: ['attribution', 'license'] });
    }
    checkUnique(ctx, p.heroes.map((h) => h.hero), 'hero', ['heroes']);
    checkUnique(ctx, p.tournaments.map((t) => t.id), 'tournament', ['tournaments']);
  });
export type Pro = z.infer<typeof ProSchema>;

// ---- stats.json (private match statistics) ----------------------------------------------
//
// Generic aggregate shapes (hero win rates, pair matrices, map deltas, talent builds) for a
// private statistics source. The public pipeline has no producer for them (no public HotS
// statistics source is used, SPEC §12, 2026-10-10); the synthetic sample in fixtures/hots/_private
// exercises the site's statistics mode, and the private hub can reuse the shapes.

export const HeroStatSchema = z.strictObject({
  games: Count,
  wins: Count,
  /** Raw win rate. */
  wr: Rate,
  /** Empirical-Bayes shrunk win rate (SPEC §6). */
  shrunk: Rate,
  pick: Rate,
  ban: Rate,
  /** 1..5; absent = "early data" (n < 200). */
  tier: z.number().int().min(1).max(5).exactOptional(),
});
export type HeroStat = z.infer<typeof HeroStatSchema>;

export const MapStatSchema = z.strictObject({
  games: Count,
  wins: Count,
  /** Shrunk toward the hero's overall shrunk WR. */
  shrunk: Rate,
  /** shrunk − hero shrunk, percentage points. */
  delta: z.number(),
});

export const TalentBuildSchema = z.strictObject({
  /** Talent ids in level order (1..7 of them). */
  talents: z.array(z.string().min(1)).min(1).max(7),
  games: Count,
  wins: Count,
  /** Posterior 10th percentile used for ranking (SPEC §6 / stats report §9.4.9). */
  shrunkLower: Rate,
});

const StatsEdgeSchema = EdgeSchema.refine((e) => e.source === 'stats' && e.n !== undefined && e.delta !== undefined, {
  message: "stats edges need source 'stats', n and delta",
});

export const StatsWindowSchema = z.strictObject({
  label: z.string().min(1),
  major: MajorSchema,
  /** Game builds covered by this window. */
  patchBuilds: z.array(BuildSchema).min(1),
  /** First 14 days of a major: pooled with the previous major at this weight. */
  pooled: z.strictObject({ major: MajorSchema, weight: Rate }).exactOptional(),
  /** Total games G in the filter (Σ hero games / 10). */
  games: Count,
  heroes: z.record(EntityIdSchema, HeroStatSchema),
  /** Directed, both directions present (antisymmetrised); pairs with n < 15 omitted. */
  counters: z.array(StatsEdgeSchema),
  /** Undirected, a < b; pairs with n < 15 omitted. */
  synergies: z.array(StatsEdgeSchema),
  maps: z.record(EntityIdSchema, z.record(MapSlugSchema, MapStatSchema)),
  /** Top talent builds per hero, best shrunkLower first. */
  builds: z.record(EntityIdSchema, z.array(TalentBuildSchema)),
});
export type StatsWindow = z.infer<typeof StatsWindowSchema>;

export const ModeStatsSchema = z.strictObject({
  current: StatsWindowSchema,
  previous: StatsWindowSchema.exactOptional(),
});

export const StatsSchema = z.strictObject({
  schema: z.literal(1),
  /** Fixture-only marker; load.ts refuses synthetic stats outside fixtures. */
  synthetic: z.literal(true).exactOptional(),
  /** SourceRef id (or fixture label) of the producer. */
  source: Slug,
  fetchedAt: IsoDateTime,
  major: MajorSchema,
  builds: z.array(BuildSchema).min(1),
  modes: z.strictObject({
    sl: ModeStatsSchema.exactOptional(),
    qm: ModeStatsSchema.exactOptional(),
    aram: ModeStatsSchema.exactOptional(),
  }),
});
export type Stats = z.infer<typeof StatsSchema>;

// ---- videos.json / streams.json (class C, private) -------------------------------------

/** Client and build-time retention for class C data (critique D2 / C14). */
export const RETENTION = {
  /** YouTube API data must be refreshed or deleted within 30 days. */
  videosMs: 30 * 24 * 3600 * 1000,
  /** Twitch: hide after 90 minutes on screen... */
  streamsDisplayMs: 90 * 60 * 1000,
  /** ...and never keep longer than 24 hours. */
  streamsMaxMs: 24 * 3600 * 1000,
} as const;

export const VideoSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
  channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/),
  channel: z.string().min(1),
  title: z.string().min(1),
  published: IsoDateTime,
  durationSec: Count.exactOptional(),
  /** YouTube's own view count, unmodified (no derived metrics). */
  views: Count.exactOptional(),
  heroes: z.array(EntityIdSchema),
  maps: z.array(MapSlugSchema),
  kind: z.enum(['guide', 'gameplay', 'tournament', 'patch']),
  lang: z.string().min(2).exactOptional(),
});
export type Video = z.infer<typeof VideoSchema>;

export const VideosSchema = z.strictObject({
  synthetic: z.literal(true).exactOptional(),
  source: z.literal('youtube'),
  fetchedAt: IsoDateTime,
  videos: z.array(VideoSchema),
});
export type Videos = z.infer<typeof VideosSchema>;

export const StreamSchema = z.strictObject({
  login: z.string().regex(/^[a-z0-9_]{2,25}$/),
  name: z.string().min(1),
  title: z.string(),
  viewers: Count,
  startedAt: IsoDateTime,
  lang: z.string().min(2),
  /** Twitch preview URL template containing {width}x{height}. */
  thumb: Url,
  url: Url,
  heroes: z.array(EntityIdSchema).exactOptional(),
});
export type Stream = z.infer<typeof StreamSchema>;

export const StreamsSchema = z.strictObject({
  synthetic: z.literal(true).exactOptional(),
  source: z.literal('twitch'),
  twitchGameId: z.literal('32959'),
  fetchedAt: IsoDateTime,
  streams: z.array(StreamSchema),
});
export type Streams = z.infer<typeof StreamsSchema>;

// ---- public/draft.json (browser shard, columnar) ---------------------------------------

const Index = z.number().int().nonnegative();

/**
 * A reason reference: an index into `reasons`, or [i, j] / [i, j, k] for those lines joined with a
 * space (a rule line and its "Only when … takes …" / "… must also take …" conditions, stored apart
 * so every part is shared).
 */
export const ReasonRefSchema = z.union([Index, z.array(Index).min(2).max(3)]);
export type ReasonRef = z.infer<typeof ReasonRefSchema>;

/** Most conditions kept per reason in the shard. */
export const MAX_SHARD_CONDITIONS = 8;

/**
 * Conditions of reasons (Reason.conditions: talents or situations the reason depends on), sparse:
 * entry i says reason `k[i]` of row `e[i]` of the same table holds when all of `c[i]` hold, each
 * an index into `reasons` (templates with the same name tokens). Absent when no reason has any;
 * readers that predate it still decode `r` unchanged.
 */
export const SparseConditionsSchema = z.strictObject({
  e: z.array(Index),
  k: z.array(Index),
  c: z.array(z.array(Index).min(1).max(MAX_SHARD_CONDITIONS)),
});
export type SparseConditions = z.infer<typeof SparseConditionsSchema>;

/** Sparse edge list in parallel arrays (COO). `r[i]` indexes into the shard's `reasons` table. */
export const SparseEdgesSchema = z.strictObject({
  a: z.array(Index),
  b: z.array(Index),
  score: z.array(Score),
  r: z.array(z.array(ReasonRefSchema)),
  cond: SparseConditionsSchema.exactOptional(),
});
export const SparseMapFitSchema = z.strictObject({
  hero: z.array(Index),
  map: z.array(Index),
  score: z.array(Score),
  r: z.array(z.array(ReasonRefSchema)),
  cond: SparseConditionsSchema.exactOptional(),
});

/** Dense row-major H×H matrix: entry [i*H + j] is "i vs j" (counters) or "i with j" (synergies). */
export const DenseMatrixSchema = z.strictObject({
  /** null = hidden (n < 15). */
  score: z.array(Score.nullable()),
  delta: z.array(z.number().nullable()),
  n: z.array(Count),
});

export const DraftStatsBlockSchema = z.strictObject({
  synthetic: z.literal(true).exactOptional(),
  /** SourceRef id (or fixture label) of the producer. */
  source: Slug,
  mode: GameModeSchema,
  timeframe: TimeframeSchema,
  label: z.string().min(1),
  games: Count,
  hero: z.strictObject({
    games: z.array(Count),
    shrunk: z.array(Rate),
    pick: z.array(Rate),
    ban: z.array(Rate),
    /** null = early data. */
    tier: z.array(z.number().int().min(1).max(5).nullable()),
  }),
  counters: DenseMatrixSchema,
  synergies: DenseMatrixSchema,
  /** Dense heroes × maps (row-major): shrunk map delta in pp, null when n < 15. */
  maps: z.strictObject({ delta: z.array(z.number().nullable()), n: z.array(Count) }),
});

/**
 * Shard format version. 2: reason lines are templates in which `{a}` and `{b}` stand for the
 * edge's two heroes (map fit: `{a}` the hero, `{m}` the map), so one line serves every pair a
 * rule matches; readers fill the names back in (src/games/hots/draft/data.ts). An optional `cond`
 * table per edge list adds reason conditions without changing how `r` decodes (still schema 2).
 */
export const DRAFT_SHARD_SCHEMA = 2;

export const DraftShardSchema = z
  .strictObject({
    schema: z.literal(DRAFT_SHARD_SCHEMA),
    build: BuildSchema,
    major: MajorSchema,
    rulesVersion: z.string().min(1),
    /** Draftable entities (composites, not members). Index i is the row/column everywhere. */
    heroes: z.strictObject({
      id: z.array(EntityIdSchema),
      slug: z.array(HeroSlugSchema),
      name: z.array(z.string().min(1)),
      role: z.array(HeroRoleSchema),
      roleAlt: z.array(HeroRoleSchema.nullable()),
      type: z.array(AttackTypeSchema),
      portrait: z.array(DataPath),
      /** Draft slots taken: 2 for Cho'gall (needs two consecutive own picks). */
      slots: z.array(z.union([z.literal(1), z.literal(2)])),
      members: z.array(z.array(AttributeIdSchema).nullable()),
      isNew: z.array(z.boolean()),
      tags: z.array(z.array(HeroTagSchema)),
    }),
    maps: z.strictObject({
      id: z.array(MapSlugSchema),
      name: z.array(z.string().min(1)),
      kind: z.array(MapKindSchema),
      ranked: z.array(z.boolean()),
    }),
    /** Deduplicated reason templates referenced by `r` arrays (see DRAFT_SHARD_SCHEMA). */
    reasons: z.array(z.string().min(1)),
    theory: z.strictObject({
      counters: SparseEdgesSchema,
      synergies: SparseEdgesSchema,
      mapFit: SparseMapFitSchema,
    }),
    /** Merged at stage time when private stats exist (private overlay, hashed name only). */
    stats: DraftStatsBlockSchema.exactOptional(),
  })
  .superRefine((d, ctx) => {
    const H = d.heroes.id.length;
    const M = d.maps.id.length;
    const R = d.reasons.length;
    for (const [k, v] of Object.entries(d.heroes)) {
      if (v.length !== H) ctx.addIssue({ code: 'custom', message: `heroes.${k} has ${v.length} entries, expected ${H}`, path: ['heroes', k] });
    }
    for (const [k, v] of Object.entries(d.maps)) {
      if (v.length !== M) ctx.addIssue({ code: 'custom', message: `maps.${k} has ${v.length} entries, expected ${M}`, path: ['maps', k] });
    }
    checkUnique(ctx, d.heroes.id, 'hero id', ['heroes', 'id']);
    for (const [i, s] of d.heroes.slots.entries()) {
      const composite = d.heroes.members[i] !== null;
      if ((s === 2) !== composite) ctx.addIssue({ code: 'custom', message: 'slots must be 2 exactly for composites', path: ['heroes', 'slots', i] });
    }
    /** `from`/`to` index the hero (or map) tables; every array must have one entry per edge. */
    const checkSparse = (name: string, from: number[], to: number[], score: number[], r: ReasonRef[][], limits: [number, number], cond?: SparseConditions) => {
      if (to.length !== from.length || score.length !== from.length || r.length !== from.length) {
        ctx.addIssue({ code: 'custom', message: `theory.${name} arrays differ in length`, path: ['theory', name] });
      }
      if (from.some((x) => x >= limits[0]) || to.some((x) => x >= limits[1])) {
        ctx.addIssue({ code: 'custom', message: `theory.${name} index out of range`, path: ['theory', name] });
      }
      if (r.some((list) => list.some((x) => (typeof x === "number" ? [x] : x).some((i) => i >= R)))) {
        ctx.addIssue({ code: 'custom', message: `theory.${name} reason index out of range`, path: ['theory', name, 'r'] });
      }
      if (cond) {
        if (cond.k.length !== cond.e.length || cond.c.length !== cond.e.length) {
          ctx.addIssue({ code: 'custom', message: `theory.${name}.cond arrays differ in length`, path: ['theory', name, 'cond'] });
        }
        const bad = cond.e.some((row, i) => row >= r.length || (cond.k[i] ?? 0) >= (r[row]?.length ?? 0) || (cond.c[i] ?? []).some((x) => x >= R));
        if (bad) ctx.addIssue({ code: 'custom', message: `theory.${name}.cond points outside the rows, their reasons or the reasons table`, path: ['theory', name, 'cond'] });
      }
    };
    const t = d.theory;
    checkSparse('counters', t.counters.a, t.counters.b, t.counters.score, t.counters.r, [H, H], t.counters.cond);
    checkSparse('synergies', t.synergies.a, t.synergies.b, t.synergies.score, t.synergies.r, [H, H], t.synergies.cond);
    checkSparse('mapFit', t.mapFit.hero, t.mapFit.map, t.mapFit.score, t.mapFit.r, [H, M], t.mapFit.cond);
    if (d.stats) {
      const s = d.stats;
      for (const [k, v] of Object.entries(s.hero)) {
        if (v.length !== H) ctx.addIssue({ code: 'custom', message: `stats.hero.${k} must have ${H} entries`, path: ['stats', 'hero', k] });
      }
      for (const m of ['counters', 'synergies'] as const) {
        for (const [k, v] of Object.entries(s[m])) {
          if (v.length !== H * H) ctx.addIssue({ code: 'custom', message: `stats.${m}.${k} must have ${H * H} entries`, path: ['stats', m, k] });
        }
      }
      for (const [k, v] of Object.entries(s.maps)) {
        if (v.length !== H * M) ctx.addIssue({ code: 'custom', message: `stats.maps.${k} must have ${H * M} entries`, path: ['stats', 'maps', k] });
      }
    }
  });
export type DraftShard = z.infer<typeof DraftShardSchema>;

/**
 * private/hots/public/draft.json (class B): stage.ts shallow-merges it into the class-A shard,
 * so it may carry nothing but the `stats` block.
 */
export const DraftStatsOverlaySchema = z.strictObject({ stats: DraftStatsBlockSchema });
export type DraftStatsBlock = z.infer<typeof DraftStatsBlockSchema>;

// ---- curated YAML (curated/hots/*.yaml) ------------------------------------------------

/** traits.yaml: hero slug → curated tags with a one-line justification. */
export const CuratedTraitSchema = z.strictObject({
  tag: HeroTagSchema,
  why: z.string().min(8),
  /** `remove` suppresses a wrongly extracted tag. */
  op: z.enum(['add', 'remove']).default('add'),
});
export const TraitsFileSchema = z.record(HeroSlugSchema, z.array(CuratedTraitSchema).min(1)).superRefine((rec, ctx) => {
  for (const [slug, list] of Object.entries(rec)) checkUnique(ctx, list.map((t) => t.tag), `tag for ${slug}`, [slug]);
});
export type TraitsFile = z.infer<typeof TraitsFileSchema>;

/** Placeholders for counter/synergy rule templates (SPEC §5.1.3). */
export const RULE_PLACEHOLDERS = ['a', 'b', 'aTag', 'bTag', 'evidence'] as const;
/** Placeholders for map-fit rule templates. */
export const MAP_RULE_PLACEHOLDERS = ['hero', 'map', 'heroTag', 'mapTag', 'evidence'] as const;

export const RuleSchema = z.strictObject({
  id: Slug,
  /** Hero A matches if it satisfies any expression (`tag` or `tag&tag`). */
  a: z.array(RuleExprSchema).min(1),
  b: z.array(RuleExprSchema).min(1),
  /** Contribution to x in score = round(50 + 50·tanh(x)); typical 0.2..0.8. */
  weight: z.number().min(-2).max(2).refine((w) => w !== 0, 'weight must be non-zero'),
  why: templateCheck(RULE_PLACEHOLDERS),
});
export type Rule = z.infer<typeof RuleSchema>;

export const RulesFileSchema = z
  .strictObject({
    version: z.number().int().positive(),
    /** a counters b (directed). */
    counters: z.array(RuleSchema),
    /** a works well with b (undirected: matched both ways). */
    synergies: z.array(RuleSchema),
  })
  .superRefine((r, ctx) => checkUnique(ctx, [...r.counters, ...r.synergies].map((x) => x.id), 'rule id'));
export type RulesFile = z.infer<typeof RulesFileSchema>;

export const ConfidenceSchema = z.enum(['low', 'medium', 'high']);

export const CuratedPairSchema = z.strictObject({
  /** Hero slugs (composites allowed: `chogall`). counters.yaml: a counters b. */
  a: HeroSlugSchema,
  b: HeroSlugSchema,
  /** Handwritten mechanical reason, consistent with the current kit text. */
  why: z.string().min(12),
  /** Talents or situations the matchup depends on. */
  conditions: z.array(z.string().min(1)).exactOptional(),
  /** Ability/talent names the reason relies on (checked against current game data). */
  evidence: z.array(z.string().min(1)).exactOptional(),
  confidence: ConfidenceSchema,
  /** Overrides the weight implied by confidence. */
  weight: z.number().min(-2).max(2).exactOptional(),
  reviewedFor: MajorSchema,
});
export type CuratedPair = z.infer<typeof CuratedPairSchema>;

export const CuratedPairsFileSchema = z.strictObject({ pairs: z.array(CuratedPairSchema) }).superRefine((f, ctx) => {
  for (const [i, p] of f.pairs.entries()) {
    if (p.a === p.b) ctx.addIssue({ code: 'custom', message: 'a and b must differ', path: ['pairs', i] });
  }
  checkUnique(ctx, f.pairs.map((p) => `${p.a}|${p.b}`), 'pair', ['pairs']);
});
export type CuratedPairsFile = z.infer<typeof CuratedPairsFileSchema>;

export const CuratedMapSchema = z.strictObject({
  name: z.string().min(1),
  kind: MapKindSchema,
  size: MapProfileSchema.shape.size,
  lanes: MapProfileSchema.shape.lanes,
  objective: z.string().min(1),
  tags: z.array(MapTagSchema).min(1),
  notes: z.string().min(1).exactOptional(),
});

export const MapFitRuleSchema = z.strictObject({
  id: Slug,
  /** Map matches if it has any of these tags. */
  map: z.array(MapTagSchema).min(1),
  /** Hero matches if it satisfies any expression. */
  hero: z.array(RuleExprSchema).min(1),
  weight: z.number().min(-2).max(2).refine((w) => w !== 0, 'weight must be non-zero'),
  why: templateCheck(MAP_RULE_PLACEHOLDERS),
});

export const CuratedMapsFileSchema = z
  .strictObject({
    version: z.number().int().positive(),
    maps: z.record(MapSlugSchema, CuratedMapSchema),
    fit: z.array(MapFitRuleSchema),
  })
  .superRefine((f, ctx) => checkUnique(ctx, f.fit.map((r) => r.id), 'fit rule id', ['fit']));
export type CuratedMapsFile = z.infer<typeof CuratedMapsFileSchema>;

/** aliases.yaml: target slug → extra lowercase search aliases. */
export const AliasesFileSchema = z
  .strictObject({
    heroes: z.record(HeroSlugSchema, z.array(LowerText).min(1)),
    maps: z.record(MapSlugSchema, z.array(LowerText).min(1)),
  })
  .superRefine((f, ctx) => {
    for (const group of ['heroes', 'maps'] as const) {
      const owner = new Map<string, string>();
      for (const [target, list] of Object.entries(f[group])) {
        for (const alias of list) {
          const prev = owner.get(alias);
          if (prev && prev !== target) ctx.addIssue({ code: 'custom', message: `alias "${alias}" points at both ${prev} and ${target}`, path: [group, target] });
          owner.set(alias, target);
        }
      }
    }
  });
export type AliasesFile = z.infer<typeof AliasesFileSchema>;

export const RankedPoolFileSchema = z
  .strictObject({
    asOf: IsoDate,
    mode: z.literal('sl'),
    /** Map slugs believed to be in the Storm League pool. */
    maps: z.array(MapSlugSchema).min(1),
    /** Maps deliberately left out, with the reason. */
    excluded: z.array(z.strictObject({ map: MapSlugSchema, why: z.string().min(8) })),
    confidence: ConfidenceSchema,
    note: z.string().min(1),
    sources: z.array(z.strictObject({ what: z.string().min(1), url: Url.exactOptional(), date: IsoDate })).min(1),
  })
  .superRefine((f, ctx) => {
    checkUnique(ctx, [...f.maps, ...f.excluded.map((e) => e.map)], 'map', ['maps']);
  });
export type RankedPoolFile = z.infer<typeof RankedPoolFileSchema>;

export const CreatorSchema = z
  .strictObject({
    id: Slug,
    name: z.string().min(1),
    youtube: z.strictObject({ channelId: z.string().regex(/^UC[A-Za-z0-9_-]{22}$/), handle: z.string().regex(/^@[A-Za-z0-9._-]+$/).exactOptional() }).exactOptional(),
    twitch: z.strictObject({ login: z.string().regex(/^[a-z0-9_]{2,25}$/) }).exactOptional(),
    lang: z.string().min(2),
    kinds: z.array(z.enum(['guide', 'gameplay', 'tournament', 'patch', 'news', 'coaching', 'official'])).min(1),
    /** Show the channel in the "featured" strip on /hots/live/. */
    featured: z.boolean().exactOptional(),
    /** Last date someone checked the channel is active and HotS-focused. */
    verified: IsoDate,
    /** Title regexes (case-insensitive) whose videos are not HotS and must be skipped. */
    excludeTitles: z.array(z.string().min(1)).exactOptional(),
    notes: z.string().min(1).exactOptional(),
  })
  .refine((c) => c.youtube !== undefined || c.twitch !== undefined, 'creator needs a youtube or twitch channel');

export const CreatorsFileSchema = z
  .strictObject({ reviewed: IsoDate, creators: z.array(CreatorSchema) })
  .superRefine((f, ctx) => {
    checkUnique(ctx, f.creators.map((c) => c.id), 'creator id', ['creators']);
    for (const [i, c] of f.creators.entries()) {
      for (const re of c.excludeTitles ?? []) {
        try {
          new RegExp(re, 'i');
        } catch {
          ctx.addIssue({ code: 'custom', message: `invalid regex "${re}"`, path: ['creators', i, 'excludeTitles'] });
        }
      }
    }
  });
export type CreatorsFile = z.infer<typeof CreatorsFileSchema>;

// ---- file registry ---------------------------------------------------------------------

/** Every file the HotS pipeline writes, with its schema and custody class. */
export const HOTS_FILES = {
  'meta.json': { schema: HotsMetaSchema, custody: 'A' },
  'heroes.json': { schema: HeroesFileSchema, custody: 'A' },
  'maps.json': { schema: MapsFileSchema, custody: 'A' },
  'patches.json': { schema: PatchesFileSchema, custody: 'A' },
  'diffs.json': { schema: DiffsFileSchema, custody: 'A' },
  'theory.json': { schema: TheorySchema, custody: 'A' },
  'links.json': { schema: LinksSchema, custody: 'A' },
  'rotation.json': { schema: RotationSchema, custody: 'A' },
  'pro.json': { schema: ProSchema, custody: 'A-SA' },
  'public/draft.json': { schema: DraftShardSchema, custody: 'A' },
  'stats.json': { schema: StatsSchema, custody: 'B' },
  'videos.json': { schema: VideosSchema, custody: 'C' },
  'streams.json': { schema: StreamsSchema, custody: 'C' },
} as const;

/** Private overlays of public shards (same path as a class-A file, merged at stage time). */
export const HOTS_PRIVATE_OVERLAYS = {
  'public/draft.json': { schema: DraftStatsOverlaySchema, custody: 'B' },
} as const;

/** Every curated YAML file under curated/hots/, with its schema. */
export const HOTS_CURATED = {
  'traits.yaml': TraitsFileSchema,
  'rules.yaml': RulesFileSchema,
  'counters.yaml': CuratedPairsFileSchema,
  'synergies.yaml': CuratedPairsFileSchema,
  'maps.yaml': CuratedMapsFileSchema,
  'aliases.yaml': AliasesFileSchema,
  'ranked-pool.yaml': RankedPoolFileSchema,
  'creators.yaml': CreatorsFileSchema,
} as const;
