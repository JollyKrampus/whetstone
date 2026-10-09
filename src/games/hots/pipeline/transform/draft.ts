/**
 * public/draft.json: the columnar browser shard for the draft tool (DraftShardSchema). Pure.
 *
 * Entity order (index i is the row/column of every array and matrix) is APPEND-ONLY STABLE:
 * draftable entities sorted by release date, then id. A new hero has the newest release date,
 * so it is appended and every existing index keeps its meaning across builds. URL-encoded
 * draft states and the stage-time stats overlay rely on this. Entities without a release date
 * sort last (by id).
 *
 * Reasons are stored once as templates: the edge's hero names become {a} and {b} (map fit: {a}
 * and the map name {m}), which turns ~20k pair-specific lines into a few thousand shared ones.
 * The substitution is lossless because the reader puts back exactly the names it took out.
 */
import { DRAFT_SHARD_SCHEMA, type DraftShard, type GameMap, type Hero, type ReasonRef, type Theory } from '../../schema.ts';
import { compareStrings } from '../util.ts';

export function entityOrder<T extends Pick<Hero, 'id' | 'releaseDate'>>(entities: readonly T[]): T[] {
  return [...entities].sort((a, b) => compareStrings(a.releaseDate ?? '9999-99-99', b.releaseDate ?? '9999-99-99') || compareStrings(a.id, b.id));
}

export interface DraftShardInput {
  build: string;
  major: string;
  /** Every hero record; members are dropped (their composite is the entity). */
  heroes: readonly Hero[];
  maps: readonly GameMap[];
  theory: Theory;
}

const TOKEN = /{[abm]}/;

/**
 * Splits a templated reason before the engine's talent conditions (theory/engine.ts onlyWhen):
 * "<line> Only when {a} takes X. {b} must also take Y." → [line, "Only when …", "{b} must …"].
 */
export function splitConditions(text: string): string[] {
  const at = text.indexOf(' Only when ');
  if (at < 0) return [text];
  const rest = text.slice(at + 1);
  const also = rest.search(/ {[ab]} must also take /);
  return also < 0 ? [text.slice(0, at), rest] : [text.slice(0, at), rest.slice(0, also), rest.slice(also + 1)];
}

/** Replaces each name with its token, longest name first. */
export function reasonTemplate(text: string, names: readonly (readonly [token: string, name: string])[]): string {
  if (TOKEN.test(text)) throw new Error(`reason already contains a template token: ${text}`);
  let out = text;
  for (const [token, name] of [...names].sort((x, y) => y[1].length - x[1].length)) if (name) out = out.split(name).join(token);
  return out;
}

export function buildDraftShard(input: DraftShardInput): DraftShard {
  const entities = entityOrder(input.heroes.filter((h) => !h.memberOf));
  const eIdx = new Map(entities.map((e, i) => [e.id, i]));
  const mIdx = new Map(input.maps.map((m, i) => [m.id, i]));
  const reasons: string[] = [];
  const rIdx = new Map<string, number>();
  const index = (text: string): number => {
    let i = rIdx.get(text);
    if (i === undefined) {
      i = reasons.length;
      reasons.push(text);
      rIdx.set(text, i);
    }
    return i;
  };
  // A rule line and its talent conditions are stored apart, so each part is shared.
  const ri = (text: string): ReasonRef => {
    const parts = splitConditions(text);
    return parts.length === 1 ? index(text) : parts.map(index);
  };
  const sparse = (edges: Theory['counters']): DraftShard['theory']['counters'] => {
    const out: DraftShard['theory']['counters'] = { a: [], b: [], score: [], r: [] };
    for (const e of edges) {
      const a = eIdx.get(e.a);
      const b = eIdx.get(e.b);
      if (a === undefined || b === undefined) continue;
      const names = [['{a}', entities[a]?.name ?? ''], ['{b}', entities[b]?.name ?? '']] as const;
      out.a.push(a);
      out.b.push(b);
      out.score.push(e.score);
      out.r.push(e.reasons.map((r) => ri(reasonTemplate(r.text, names))));
    }
    return out;
  };
  const counters = sparse(input.theory.counters);
  const synergies = sparse(input.theory.synergies);
  const mapFit: DraftShard['theory']['mapFit'] = { hero: [], map: [], score: [], r: [] };
  for (const f of input.theory.mapFit) {
    const h = eIdx.get(f.hero);
    const m = mIdx.get(f.map);
    if (h === undefined || m === undefined) continue;
    const names = [['{a}', entities[h]?.name ?? ''], ['{m}', input.maps[m]?.name ?? '']] as const;
    mapFit.hero.push(h);
    mapFit.map.push(m);
    mapFit.score.push(f.score);
    mapFit.r.push(f.reasons.map((r) => ri(reasonTemplate(r.text, names))));
  }
  return {
    schema: DRAFT_SHARD_SCHEMA,
    build: input.build,
    major: input.major,
    rulesVersion: input.theory.rulesVersion,
    heroes: {
      id: entities.map((e) => e.id),
      slug: entities.map((e) => e.slug),
      name: entities.map((e) => e.name),
      role: entities.map((e) => e.role),
      roleAlt: entities.map((e) => e.roleAlt ?? null),
      type: entities.map((e) => e.type),
      portrait: entities.map((e) => e.portrait),
      slots: entities.map((e) => (e.members ? 2 : 1)),
      members: entities.map((e) => (e.members ? [...e.members] : null)),
      isNew: entities.map((e) => e.isNew),
      tags: entities.map((e) => [...new Set(e.mechanics.map((m) => m.tag))].sort(compareStrings)),
    },
    maps: {
      id: input.maps.map((m) => m.id),
      name: input.maps.map((m) => m.name),
      kind: input.maps.map((m) => m.kind),
      ranked: input.maps.map((m) => m.ranked),
    },
    reasons,
    theory: { counters, synergies, mapFit },
  };
}
