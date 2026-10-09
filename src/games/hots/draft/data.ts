/**
 * Browser-side view of the draft shard (public/draft.json, SPEC §5): the columnar file is
 * decoded once into hero/map records and lookup tables the providers can query in O(1).
 *
 * The shard is fetched at runtime from a content-hashed URL, so it is checked structurally here
 * (cheap, no zod in the island bundle); the pipeline already validated it with DraftShardSchema.
 * Only `import type` from ../schema.ts, which keeps zod out of the browser bundle.
 */
import type { DraftStatsBlock, HeroRole, HeroTag } from '../schema.ts';

export interface DraftHero {
  /** Row/column index in every shard table. */
  index: number;
  id: string;
  slug: string;
  name: string;
  role: HeroRole;
  roleAlt: HeroRole | null;
  type: 'Melee' | 'Ranged';
  /** 'img/heroes/….webp' (relative to the game's data directory). */
  portrait: string;
  /** Draft slots: 2 for Cho'gall. */
  slots: 1 | 2;
  members: readonly string[] | null;
  isNew: boolean;
  tags: ReadonlySet<HeroTag>;
}

export interface DraftMap {
  index: number;
  id: string;
  name: string;
  kind: 'standard' | 'aram' | 'brawl';
  ranked: boolean;
}

/** One theory edge: score 1..100 (50 neutral) and its reason sentences. */
export interface TheoryLink {
  score: number;
  reasons: readonly string[];
}

/** A statistics cell that passed the "hidden" gate (n ≥ 15, score present). */
export interface StatCell {
  score: number;
  /** pp */
  delta: number;
  n: number;
}

export interface DraftData {
  build: string;
  major: string;
  rulesVersion: string;
  heroes: readonly DraftHero[];
  byId: ReadonlyMap<string, DraftHero>;
  maps: readonly DraftMap[];
  mapById: ReadonlyMap<string, DraftMap>;
  /** counters.get(a)?.get(b): a counters b (directed). */
  counters: ReadonlyMap<number, ReadonlyMap<number, TheoryLink>>;
  /** Undirected; stored under both a→b and b→a. */
  synergies: ReadonlyMap<number, ReadonlyMap<number, TheoryLink>>;
  /** hero index → map index → fit. */
  mapFit: ReadonlyMap<number, ReadonlyMap<number, TheoryLink>>;
  /** Heroes Profile block merged in at stage time (class B); null when HP is off. */
  stats: DraftStatsBlock | null;
}

export class ShardError extends Error {
  constructor(message: string) {
    super(`Draft data is malformed: ${message}`);
    this.name = 'ShardError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function arrayOf(obj: Record<string, unknown>, key: string, length: number | null, where: string): unknown[] {
  const v = obj[key];
  if (!Array.isArray(v)) throw new ShardError(`${where}.${key} is not an array`);
  if (length !== null && v.length !== length) throw new ShardError(`${where}.${key} has ${v.length} entries, expected ${length}`);
  return v;
}

function objectAt(obj: Record<string, unknown>, key: string, where: string): Record<string, unknown> {
  const v = obj[key];
  if (!isObject(v)) throw new ShardError(`${where}.${key} is missing`);
  return v;
}

function addLink(table: Map<number, Map<number, TheoryLink>>, a: number, b: number, link: TheoryLink): void {
  let row = table.get(a);
  if (!row) table.set(a, (row = new Map()));
  row.set(b, link);
}

function sparse(
  raw: Record<string, unknown>,
  name: string,
  fromKey: string,
  toKey: string,
  limits: [number, number],
  reasons: readonly string[],
): { from: number; to: number; link: TheoryLink }[] {
  const where = `theory.${name}`;
  const from = arrayOf(raw, fromKey, null, where);
  const to = arrayOf(raw, toKey, from.length, where);
  const score = arrayOf(raw, 'score', from.length, where);
  const r = arrayOf(raw, 'r', from.length, where);
  const out: { from: number; to: number; link: TheoryLink }[] = [];
  for (let i = 0; i < from.length; i++) {
    const a = from[i];
    const b = to[i];
    const s = score[i];
    const refs = r[i];
    if (typeof a !== 'number' || typeof b !== 'number' || a < 0 || b < 0 || a >= limits[0] || b >= limits[1]) {
      throw new ShardError(`${where} row ${i} points outside the tables`);
    }
    if (typeof s !== 'number' || !Number.isFinite(s)) throw new ShardError(`${where} row ${i} has no score`);
    const texts = Array.isArray(refs) ? refs.map((j) => (typeof j === 'number' ? reasons[j] : undefined)).filter((t): t is string => typeof t === 'string') : [];
    out.push({ from: a, to: b, link: { score: s, reasons: texts } });
  }
  return out;
}

function checkStats(stats: unknown, H: number, M: number): DraftStatsBlock | null {
  if (stats === undefined || stats === null) return null;
  if (!isObject(stats)) throw new ShardError('stats is not an object');
  const hero = objectAt(stats, 'hero', 'stats');
  for (const k of ['games', 'shrunk', 'pick', 'ban', 'tier']) arrayOf(hero, k, H, 'stats.hero');
  for (const m of ['counters', 'synergies']) {
    const block = objectAt(stats, m, 'stats');
    for (const k of ['score', 'delta', 'n']) arrayOf(block, k, H * H, `stats.${m}`);
  }
  const maps = objectAt(stats, 'maps', 'stats');
  for (const k of ['delta', 'n']) arrayOf(maps, k, H * M, 'stats.maps');
  if (typeof stats.mode !== 'string' || typeof stats.label !== 'string') throw new ShardError('stats.mode/label missing');
  return stats as unknown as DraftStatsBlock;
}

/** Decode and check a fetched draft shard. Throws ShardError with a readable message. */
export function decodeShard(raw: unknown): DraftData {
  if (!isObject(raw)) throw new ShardError('not a JSON object');
  if (raw.schema !== 1) throw new ShardError(`unsupported schema ${String(raw.schema)}`);
  const h = objectAt(raw, 'heroes', 'shard');
  const ids = arrayOf(h, 'id', null, 'heroes');
  const H = ids.length;
  const cols = Object.fromEntries(
    ['slug', 'name', 'role', 'roleAlt', 'type', 'portrait', 'slots', 'members', 'isNew', 'tags'].map((k) => [k, arrayOf(h, k, H, 'heroes')]),
  ) as Record<string, unknown[]>;
  const heroes: DraftHero[] = ids.map((id, i) => {
    if (typeof id !== 'string' || id === '') throw new ShardError(`heroes.id[${i}] is empty`);
    const slots = cols.slots![i] === 2 ? 2 : 1;
    const members = cols.members![i];
    const tags = cols.tags![i];
    return {
      index: i,
      id,
      slug: String(cols.slug![i]),
      name: String(cols.name![i]),
      role: cols.role![i] as HeroRole,
      roleAlt: (cols.roleAlt![i] ?? null) as HeroRole | null,
      type: cols.type![i] === 'Ranged' ? 'Ranged' : 'Melee',
      portrait: String(cols.portrait![i]),
      slots,
      members: Array.isArray(members) ? members.map(String) : null,
      isNew: cols.isNew![i] === true,
      tags: new Set(Array.isArray(tags) ? (tags as HeroTag[]) : []),
    };
  });
  const byId = new Map(heroes.map((x) => [x.id, x]));
  if (byId.size !== H) throw new ShardError('duplicate hero ids');

  const m = objectAt(raw, 'maps', 'shard');
  const mapIds = arrayOf(m, 'id', null, 'maps');
  const M = mapIds.length;
  const mapNames = arrayOf(m, 'name', M, 'maps');
  const mapKinds = arrayOf(m, 'kind', M, 'maps');
  const mapRanked = arrayOf(m, 'ranked', M, 'maps');
  const maps: DraftMap[] = mapIds.map((id, i) => ({
    index: i,
    id: String(id),
    name: String(mapNames[i]),
    kind: mapKinds[i] === 'aram' ? 'aram' : mapKinds[i] === 'brawl' ? 'brawl' : 'standard',
    ranked: mapRanked[i] === true,
  }));

  const reasons = arrayOf(raw, 'reasons', null, 'shard').map(String);
  const t = objectAt(raw, 'theory', 'shard');
  const counters = new Map<number, Map<number, TheoryLink>>();
  const synergies = new Map<number, Map<number, TheoryLink>>();
  const mapFit = new Map<number, Map<number, TheoryLink>>();
  for (const e of sparse(objectAt(t, 'counters', 'theory'), 'counters', 'a', 'b', [H, H], reasons)) addLink(counters, e.from, e.to, e.link);
  for (const e of sparse(objectAt(t, 'synergies', 'theory'), 'synergies', 'a', 'b', [H, H], reasons)) {
    addLink(synergies, e.from, e.to, e.link);
    addLink(synergies, e.to, e.from, e.link);
  }
  for (const e of sparse(objectAt(t, 'mapFit', 'theory'), 'mapFit', 'hero', 'map', [H, M], reasons)) addLink(mapFit, e.from, e.to, e.link);

  return {
    build: String(raw.build ?? ''),
    major: String(raw.major ?? ''),
    rulesVersion: String(raw.rulesVersion ?? ''),
    heroes,
    byId,
    maps,
    mapById: new Map(maps.map((x) => [x.id, x])),
    counters,
    synergies,
    mapFit,
    stats: checkStats(raw.stats, H, M),
  };
}

// ---- lookups -------------------------------------------------------------------------------

export const HIDE_BELOW_N = 15;

function cell(score: (number | null)[], delta: (number | null)[], n: number[], k: number): StatCell | null {
  const s = score[k];
  const d = delta[k];
  const nn = n[k] ?? 0;
  if (s === null || s === undefined || d === null || d === undefined || !(nn >= HIDE_BELOW_N)) return null;
  return { score: s, delta: d, n: nn };
}

/** Stats for "a against b" (counters) or "a with b" (synergies), null when hidden or absent. */
export function statPair(data: DraftData, matrix: 'counters' | 'synergies', a: number, b: number): StatCell | null {
  const s = data.stats;
  if (!s || a === b) return null;
  const H = data.heroes.length;
  const m = s[matrix];
  return cell(m.score, m.delta, m.n, a * H + b);
}

/** Hero × map stats (delta vs the hero's own rate, pp), null when hidden or absent. */
export function statMap(data: DraftData, hero: number, map: number): { delta: number; n: number } | null {
  const s = data.stats;
  if (!s) return null;
  const k = hero * data.maps.length + map;
  const d = s.maps.delta[k];
  const n = s.maps.n[k] ?? 0;
  if (d === null || d === undefined || !(n >= HIDE_BELOW_N)) return null;
  return { delta: d, n };
}

export interface HeroStatCell {
  games: number;
  shrunk: number;
  pick: number;
  ban: number;
  tier: number | null;
}

export function statHero(data: DraftData, hero: number): HeroStatCell | null {
  const s = data.stats;
  if (!s) return null;
  const games = s.hero.games[hero] ?? 0;
  if (!(games >= HIDE_BELOW_N)) return null;
  return {
    games,
    shrunk: s.hero.shrunk[hero] ?? 0.5,
    pick: s.hero.pick[hero] ?? 0,
    ban: s.hero.ban[hero] ?? 0,
    tier: s.hero.tier[hero] ?? null,
  };
}

export const theoryCounter = (data: DraftData, a: number, b: number): TheoryLink | undefined => data.counters.get(a)?.get(b);
export const theorySynergy = (data: DraftData, a: number, b: number): TheoryLink | undefined => data.synergies.get(a)?.get(b);
export const theoryMapFit = (data: DraftData, hero: number, map: number): TheoryLink | undefined => data.mapFit.get(hero)?.get(map);
