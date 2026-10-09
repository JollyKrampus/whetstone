/**
 * Shape of export.ts's output (the "raw dex export"). Validated before it is transformed, so a
 * Showdown refactor that changes field names fails loudly instead of producing empty data.
 */
import { z } from 'zod';

const Id = z.string().regex(/^[a-z0-9]+$/);
const Text = z.string().min(1);

export const RawRegulationSchema = z.discriminatedUnion('exists', [
  z.strictObject({ id: Text, format: Text, exists: z.literal(false) }),
  z.strictObject({
    id: Text,
    format: Text,
    exists: z.literal(true),
    mod: Text,
    species: z.array(Id),
    megas: z.array(Id),
    items: z.array(Id),
  }),
]);

export const RawSpeciesSchema = z.strictObject({
  id: Id,
  name: Text,
  num: z.number().int(),
  baseSpecies: Text,
  forme: z.string(),
  types: z.array(Text).min(1).max(2),
  baseStats: z.strictObject({ hp: z.number(), atk: z.number(), def: z.number(), spa: z.number(), spd: z.number(), spe: z.number() }),
  abilities: z.record(z.string(), z.string()),
  weightkg: z.number(),
  isMega: z.boolean(),
  requiredItem: Text.nullable(),
  changesFrom: Text.nullable(),
  otherFormes: z.array(Id),
  cosmeticFormes: z.array(Id),
  tier: z.string(),
  spriteid: Text,
});
export type RawSpecies = z.infer<typeof RawSpeciesSchema>;

export const RawMoveSchema = z.strictObject({
  id: Id,
  name: Text,
  type: Text,
  category: z.enum(['Physical', 'Special', 'Status']),
  basePower: z.number(),
  accuracy: z.union([z.number(), z.literal(true)]),
  pp: z.number(),
  priority: z.number(),
  target: Text,
  flags: z.array(Text),
  shortDesc: Text.nullable(),
});

export const RawItemSchema = z.strictObject({
  id: Id,
  name: Text,
  megaStone: z.array(z.strictObject({ base: Id, forme: Id })),
  shortDesc: Text.nullable(),
});

export const RawAbilitySchema = z.strictObject({ id: Id, name: Text, shortDesc: Text.nullable() });

export const RawTypeSchema = z.strictObject({ name: Text, damageTaken: z.record(z.string(), z.number()) });

export const RawDexExportSchema = z.strictObject({
  exporter: z.number().int().positive(),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  dataRegulation: Text,
  dataMod: Text,
  regulations: z.array(RawRegulationSchema).min(1),
  species: z.array(RawSpeciesSchema),
  moves: z.array(RawMoveSchema),
  items: z.array(RawItemSchema),
  abilities: z.array(RawAbilitySchema),
  types: z.array(RawTypeSchema),
  learnsets: z.record(Id, z.array(Id)),
});
export type RawDexExport = z.infer<typeof RawDexExportSchema>;
