/**
 * Showdown ids and the dex lookups every source needs to normalise what it ingests: cosmetic
 * formes fold into their species, a registered Pokémon holding its Mega Stone is counted as
 * the Mega (Smogon's convention, so usage, tournaments and replays share one id space).
 */
import type { Item, Species } from '../schema.ts';

/** Showdown's toID: lowercase ASCII alphanumerics. */
export function toId(text: unknown): string {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export interface DexIndex {
  has(id: string): boolean;
  /** Species id for a name or id as written by a source, or null when it is not in the dex. */
  species(nameOrId: string): string | null;
  /** The Mega forme `speciesId` becomes with `itemId`, or null. */
  mega(speciesId: string, itemId: string | undefined): string | null;
  /** Usage id: the Mega when holding its stone, else the species. */
  usageId(speciesId: string, itemId: string | undefined): string;
  /** Display name for reason texts. */
  name(id: string): string;
  /** Base species of a Mega (or the id itself). */
  base(id: string): string;
}

export function dexIndex(species: readonly Species[], items: readonly Item[]): DexIndex {
  const byId = new Map(species.map((s) => [s.id, s]));
  const alias = new Map<string, string>();
  for (const s of species) for (const c of s.cosmeticFormes ?? []) if (!byId.has(c)) alias.set(c, s.id);
  const stones = new Map<string, { base: string; forme: string }>();
  for (const i of items) if (i.mega) stones.set(i.id, i.mega);
  const resolve = (nameOrId: string): string | null => {
    const id = toId(nameOrId);
    if (byId.has(id)) return id;
    return alias.get(id) ?? null;
  };
  return {
    has: (id) => byId.has(id),
    species: resolve,
    mega(speciesId, itemId) {
      const stone = itemId ? stones.get(itemId) : undefined;
      return stone && stone.base === speciesId && byId.has(stone.forme) ? stone.forme : null;
    },
    usageId(speciesId, itemId) {
      return this.mega(speciesId, itemId) ?? speciesId;
    },
    name: (id) => byId.get(id)?.name ?? id,
    base: (id) => byId.get(id)?.megaOf ?? id,
  };
}
