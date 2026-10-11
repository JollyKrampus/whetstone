/**
 * Browser-side view of the draft shard (public/draft.json, SPEC §5): the columnar file is
 * decoded once into hero/map records and lookup tables the providers can query in O(1).
 *
 * The shard is fetched at runtime from a content-hashed URL, so it is checked structurally here
 * (cheap, no zod in the island bundle); the pipeline already validated it with DraftShardSchema.
 * Only `import type` from ../schema.ts, which keeps zod out of the browser bundle.
 */
import { GATES } from '../../../core/stats.ts';
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

/** One reason line of a theory edge, apart from the conditions it depends on. */
export interface TheoryLine {
  /** The line with the edge's names filled in, without its conditions. */
  text: string;
  /**
   * The shared template the line came from (names as {a}/{b}/{m}). Two edges matched by the
   * same rule share it, so "the same rule again, for another enemy" can be told apart from a
   * different reason.
   */
  template: string;
  /**
   * What the line depends on, one sentence each with names filled in: an engine condition
   * ("Only when Anduin takes Lightbomb.") loses its "Only when " lead, so every condition reads
   * the same way ("Anduin takes Lightbomb."); a curated condition is kept as written. Empty when
   * the line always holds. The UI renders them as "Only when …".
   */
  conditions: readonly string[];
}

/** One theory edge: score 1..100 (50 neutral) and its reason sentences. */
export interface TheoryLink {
  score: number;
  /** Each line in full, conditions included, exactly as theory.json words it. */
  reasons: readonly string[];
  /** The same lines split from their conditions, in theory.json order (curated lines first). */
  lines: readonly TheoryLine[];
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
  /** Match-statistics block merged in at stage time (class B); null without statistics. */
  stats: DraftStatsBlock | null;
  /** SourceRef id of the statistics block (its credit and reason labels), null when unknown. */
  statsSource: string | null;
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

/** Shard format this reader understands (DRAFT_SHARD_SCHEMA in ../schema.ts). */
export const SHARD_SCHEMA = 2;

/** Fills a reason template's {a}/{b}/{m} tokens with the edge's names (schema 2). */
export function fillReason(template: string, a: string, b: string, token: '{b}' | '{m}'): string {
  return template.split('{a}').join(a).split(token).join(b);
}

const ONLY_WHEN = 'Only when ';

/** A condition part as the UI shows it after "Only when": the engine's lead words dropped. */
export function conditionText(part: string): string {
  const t = part.trim();
  return t.startsWith(ONLY_WHEN) ? t.slice(ONLY_WHEN.length) : t;
}

/**
 * Splits one reason reference into its line and conditions. A reference [i, j(, k)] already
 * stores them apart (the first part is the line, the rest conditions); a single index may still
 * carry the engine's " Only when …" sentences inline, which are split off the same way.
 */
function splitRef(parts: readonly string[]): { line: string; conditions: string[] } {
  if (parts.length > 1) return { line: parts[0]!, conditions: parts.slice(1).map(conditionText).filter(Boolean) };
  const text = parts[0] ?? '';
  const at = text.indexOf(` ${ONLY_WHEN}`);
  if (at < 0) return { line: text, conditions: [] };
  const rest = text.slice(at + 1);
  const also = rest.search(/ {[ab]} must also take /);
  const conditions = also < 0 ? [rest] : [rest.slice(0, also), rest.slice(also + 1)];
  return { line: text.slice(0, at), conditions: conditions.map(conditionText).filter(Boolean) };
}

/**
 * The optional `cond` table of an edge list (schema 2): entry i says reason r[e[i]][k[i]] holds
 * only when every condition template c[i] holds. Returns row → reason position → templates.
 * A missing table means no conditions; entries that point outside the rows or the reasons table
 * are skipped (the build-time schema already rejects them).
 */
function conditionTable(raw: Record<string, unknown>, rows: number, reasons: readonly string[], where: string): Map<number, Map<number, string[]>> {
  const out = new Map<number, Map<number, string[]>>();
  if (raw.cond === undefined) return out;
  if (!isObject(raw.cond)) throw new ShardError(`${where}.cond is not an object`);
  const e = arrayOf(raw.cond, 'e', null, `${where}.cond`);
  const k = arrayOf(raw.cond, 'k', e.length, `${where}.cond`);
  const c = arrayOf(raw.cond, 'c', e.length, `${where}.cond`);
  for (let i = 0; i < e.length; i++) {
    const row = e[i];
    const pos = k[i];
    const list = c[i];
    if (typeof row !== 'number' || typeof pos !== 'number' || row < 0 || row >= rows || pos < 0 || !Array.isArray(list)) continue;
    const templates = list.map((j) => (typeof j === 'number' ? reasons[j] : undefined)).filter((t): t is string => t !== undefined && t.trim() !== '');
    if (templates.length === 0) continue;
    let byPos = out.get(row);
    if (!byPos) out.set(row, (byPos = new Map()));
    byPos.set(pos, [...(byPos.get(pos) ?? []), ...templates]);
  }
  return out;
}

function sparse(
  raw: Record<string, unknown>,
  name: string,
  fromKey: string,
  toKey: string,
  limits: [number, number],
  reasons: readonly string[],
  names: [readonly string[], readonly string[], '{b}' | '{m}'],
): { from: number; to: number; link: TheoryLink }[] {
  const where = `theory.${name}`;
  const from = arrayOf(raw, fromKey, null, where);
  const to = arrayOf(raw, toKey, from.length, where);
  const score = arrayOf(raw, 'score', from.length, where);
  const r = arrayOf(raw, 'r', from.length, where);
  const cond = conditionTable(raw, from.length, reasons, where);
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
    const [fromNames, toNames, token] = names;
    // A number, or [i, k] / [i, k, l]: a line and its talent conditions (joined with spaces in full).
    const partsOf = (j: unknown): string[] | undefined => {
      if (typeof j === 'number') return reasons[j] === undefined ? undefined : [reasons[j]];
      if (Array.isArray(j) && j.length > 0) {
        const parts = j.map((k) => (typeof k === 'number' ? reasons[k] : undefined));
        return parts.every((p) => p !== undefined) ? (parts as string[]) : undefined;
      }
      return undefined;
    };
    const fill = (t: string) => fillReason(t, fromNames[a] ?? '', toNames[b] ?? '', token);
    const texts: string[] = [];
    const lines: TheoryLine[] = [];
    const rowCond = cond.get(i);
    (Array.isArray(refs) ? refs : []).forEach((ref, k) => {
      const parts = partsOf(ref);
      if (!parts) return;
      texts.push(fill(parts.join(' ')));
      const { line, conditions } = splitRef(parts);
      // Inline (engine) conditions first, then the `cond` table's (curated), each said once.
      const all = [...conditions, ...(rowCond?.get(k) ?? []).map(conditionText)].map(fill).filter(Boolean);
      lines.push({ text: fill(line), template: line, conditions: [...new Set(all)] });
    });
    out.push({ from: a, to: b, link: { score: s, reasons: texts, lines } });
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
  if (raw.schema !== SHARD_SCHEMA) throw new ShardError(`unsupported schema ${String(raw.schema)}`);
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
  const heroNames = heroes.map((x) => x.name);
  const mapNameList = maps.map((x) => x.name);
  for (const e of sparse(objectAt(t, 'counters', 'theory'), 'counters', 'a', 'b', [H, H], reasons, [heroNames, heroNames, '{b}'])) addLink(counters, e.from, e.to, e.link);
  for (const e of sparse(objectAt(t, 'synergies', 'theory'), 'synergies', 'a', 'b', [H, H], reasons, [heroNames, heroNames, '{b}'])) {
    addLink(synergies, e.from, e.to, e.link);
    addLink(synergies, e.to, e.from, e.link);
  }
  for (const e of sparse(objectAt(t, 'mapFit', 'theory'), 'mapFit', 'hero', 'map', [H, M], reasons, [heroNames, mapNameList, '{m}'])) addLink(mapFit, e.from, e.to, e.link);
  const stats = checkStats(raw.stats, H, M);

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
    stats,
    statsSource: stats && typeof (stats as { source?: unknown }).source === 'string' ? String((stats as { source?: unknown }).source) : null,
  };
}

// ---- lookups -------------------------------------------------------------------------------

/** Cells with fewer games are hidden (SPEC §6 gate, from src/core/stats.ts). */
export const HIDE_BELOW_N = GATES.hideBelow;

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
