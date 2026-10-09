/**
 * public/draft.json: the columnar browser shard for the draft tool (DraftShardSchema). Pure.
 *
 * Entity order (index i is the row/column of every array and matrix) is APPEND-ONLY STABLE:
 * draftable entities sorted by release date, then id. A new hero has the newest release date,
 * so it is appended and every existing index keeps its meaning across builds. URL-encoded
 * draft states and the stage-time stats overlay rely on this. Entities without a release date
 * sort last (by id).
 */
import type { DraftShard, GameMap, Hero, Theory } from '../../schema.ts';
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

export function buildDraftShard(input: DraftShardInput): DraftShard {
  const entities = entityOrder(input.heroes.filter((h) => !h.memberOf));
  const eIdx = new Map(entities.map((e, i) => [e.id, i]));
  const mIdx = new Map(input.maps.map((m, i) => [m.id, i]));
  const reasons: string[] = [];
  const rIdx = new Map<string, number>();
  const ri = (text: string): number => {
    let i = rIdx.get(text);
    if (i === undefined) {
      i = reasons.length;
      reasons.push(text);
      rIdx.set(text, i);
    }
    return i;
  };
  const sparse = (edges: Theory['counters']): DraftShard['theory']['counters'] => {
    const out: DraftShard['theory']['counters'] = { a: [], b: [], score: [], r: [] };
    for (const e of edges) {
      const a = eIdx.get(e.a);
      const b = eIdx.get(e.b);
      if (a === undefined || b === undefined) continue;
      out.a.push(a);
      out.b.push(b);
      out.score.push(e.score);
      out.r.push(e.reasons.map((r) => ri(r.text)));
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
    mapFit.hero.push(h);
    mapFit.map.push(m);
    mapFit.score.push(f.score);
    mapFit.r.push(f.reasons.map((r) => ri(r.text)));
  }
  return {
    schema: 1,
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
