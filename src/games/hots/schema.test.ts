import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { z } from 'zod';
import { DataValidationError, EdgeSchema, parseData } from '../../core/schemas.ts';
import { repoRoot } from '../../lib/datadir.ts';
import { decodeShard } from './draft/data.ts';
import { entityOrder } from './pipeline/transform/draft.ts';
import { statsBlockFromWindow } from './draft/statsblock.ts';
import * as load from './load.ts';
import {
  AliasesFileSchema,
  CuratedMapsFileSchema,
  CuratedPairsFileSchema,
  DraftShardSchema,
  DraftStatsOverlaySchema,
  HeroesFileSchema,
  HOTS_CURATED,
  HOTS_FILES,
  LinksSchema,
  MapsFileSchema,
  PatchesFileSchema,
  ProSchema,
  RankedPoolFileSchema,
  RotationSchema,
  RulesFileSchema,
  StatsSchema,
  TheorySchema,
  type Hero,
  type StatsWindow,
} from './schema.ts';

const ROOT = repoRoot();
const FIXTURES = path.join(ROOT, 'fixtures', 'hots');
const CURATED = path.join(ROOT, 'curated', 'hots');
const PRIVATE = new Set(['stats.json', 'videos.json', 'streams.json']);

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, 'utf8'));
const readYaml = (file: string): unknown => parseYaml(fs.readFileSync(file, 'utf8'));
function fixture<S extends z.ZodType>(schema: S, file: string): z.output<S> {
  return parseData(schema, readJson(path.join(FIXTURES, file)), `fixtures/hots/${file}`);
}
function curated<S extends z.ZodType>(schema: S, file: string): z.output<S> {
  return parseData(schema, readYaml(path.join(CURATED, file)), `curated/hots/${file}`);
}

describe('hots fixtures match the schemas', () => {
  for (const [file, { schema }] of Object.entries(HOTS_FILES)) {
    it(file, () => {
      const rel = PRIVATE.has(file) ? `_private/${file}` : file;
      expect(() => parseData(schema, readJson(path.join(FIXTURES, rel)), `fixtures/hots/${rel}`)).not.toThrow();
    });
  }

  it('ships the draft stats overlay that stage.ts merges with WHETSTONE_FIXTURE_PRIVATE=1, in sync with stats.json', () => {
    const shard = fixture(DraftShardSchema, 'public/draft.json');
    const stats = fixture(StatsSchema, '_private/stats.json');
    const overlay = fixture(DraftStatsOverlaySchema, '_private/public/draft.json');
    const sl = stats.modes.sl?.current;
    expect(sl).toBeDefined();
    if (!sl) return;
    // Regenerate with the hots fixture generator when the shard or stats.json change.
    expect(overlay).toEqual({ stats: statsBlockFromWindow(sl, shard, { mode: 'sl', timeframe: 'current', synthetic: true }) });
  });

  it('marks every private sample as synthetic', () => {
    for (const file of PRIVATE) expect((readJson(path.join(FIXTURES, '_private', file)) as { synthetic?: boolean }).synthetic).toBe(true);
  });

  it('ships images for every portrait and map thumbnail', () => {
    const heroes = fixture(HeroesFileSchema, 'heroes.json');
    const maps = fixture(MapsFileSchema, 'maps.json');
    for (const p of [...heroes.map((h) => h.portrait), ...maps.map((m) => m.image)]) expect(fs.existsSync(path.join(FIXTURES, p)), p).toBe(true);
  });
});

describe('hots curated files match the schemas', () => {
  for (const [file, schema] of Object.entries(HOTS_CURATED)) {
    it(file, () => {
      expect(() => parseData(schema, readYaml(path.join(CURATED, file)), `curated/hots/${file}`)).not.toThrow();
    });
  }

  it('has at least a dozen counter rules and the documented synergy rules', () => {
    const rules = curated(RulesFileSchema, 'rules.yaml');
    expect(rules.counters.length).toBeGreaterThanOrEqual(12);
    expect(rules.synergies.length).toBeGreaterThanOrEqual(5);
  });

  it('keeps the ranked pool and aliases consistent with maps.yaml', () => {
    const maps = curated(CuratedMapsFileSchema, 'maps.yaml');
    const pool = curated(RankedPoolFileSchema, 'ranked-pool.yaml');
    const aliases = curated(AliasesFileSchema, 'aliases.yaml');
    const ids = new Set(Object.keys(maps.maps));
    for (const m of [...pool.maps, ...pool.excluded.map((e) => e.map), ...Object.keys(aliases.maps)]) expect(ids.has(m), m).toBe(true);
    for (const m of pool.maps) expect(maps.maps[m]?.kind).toBe('standard');
    expect(Object.values(maps.maps).filter((m) => m.kind === 'standard')).toHaveLength(15);
    expect(Object.values(maps.maps).filter((m) => m.kind === 'aram')).toHaveLength(4);
  });

  it('references real fixture heroes in the example pairs', () => {
    const slugs = new Set(fixture(HeroesFileSchema, 'heroes.json').map((h) => h.slug));
    for (const file of ['counters.yaml', 'synergies.yaml']) {
      for (const p of curated(CuratedPairsFileSchema, file).pairs) {
        expect(slugs.has(p.a), `${file}: ${p.a}`).toBe(true);
        expect(slugs.has(p.b), `${file}: ${p.b}`).toBe(true);
      }
    }
  });
});

describe('hots fixture cross-references', () => {
  const heroes = fixture(HeroesFileSchema, 'heroes.json');
  const byId = new Map(heroes.map((h) => [h.id, h]));
  const entities = heroes.filter((h) => !h.memberOf);
  const entityIds = new Set(entities.map((h) => h.id));
  const maps = fixture(MapsFileSchema, 'maps.json');
  const mapIds = new Set(maps.map((m) => m.id));
  const curatedMaps = curated(CuratedMapsFileSchema, 'maps.yaml');

  it('covers the required roster, including the Cho\'gall composite', () => {
    const names = heroes.map((h) => h.name);
    for (const n of ['Abathur', "Anub'arak", 'Cho', 'Gall', 'Diablo', 'Li-Ming', 'Johanna', 'Malfurion', 'Muradin', 'Tracer', 'Valla', 'Varian', 'Zeratul', "Xal'atath", "Cho'gall"]) {
      expect(names).toContain(n);
    }
    const chogall = heroes.find((h) => h.id === 'chogall');
    expect(chogall?.members).toEqual(['CCho', 'Gall']);
    expect(byId.get('HXAL')?.isNew).toBe(true);
    for (const h of heroes.filter((x) => !x.members)) {
      expect(h.abilities.length, h.name).toBeGreaterThanOrEqual(3);
      for (const tier of Object.values(h.talents)) expect(tier.length, h.name).toBeGreaterThanOrEqual(2);
    }
  });

  it('keeps maps in line with curated profiles and includes an ARAM map', () => {
    expect(maps.length).toBe(6);
    expect(maps.some((m) => m.kind === 'aram')).toBe(true);
    for (const m of maps) {
      const c = curatedMaps.maps[m.id];
      expect(c, m.id).toBeDefined();
      expect(m.profile.tags).toEqual(c?.tags);
    }
  });

  it('uses draftable entity ids everywhere edges live', () => {
    const theory = fixture(TheorySchema, 'theory.json');
    for (const e of [...theory.counters, ...theory.synergies]) {
      expect(entityIds.has(e.a) && entityIds.has(e.b), `${e.a}/${e.b}`).toBe(true);
    }
    for (const f of theory.mapFit) {
      expect(entityIds.has(f.hero)).toBe(true);
      expect(mapIds.has(f.map)).toBe(true);
    }
    for (const h of fixture(ProSchema, 'pro.json').heroes) expect(entityIds.has(h.hero)).toBe(true);
  });

  it('builds the draft shard from the same heroes, maps and theory', () => {
    const draft = fixture(DraftShardSchema, 'public/draft.json');
    const theory = fixture(TheorySchema, 'theory.json');
    // Append-only shard order: release date, then id.
    expect(draft.heroes.id).toEqual(entityOrder(entities).map((h) => h.id));
    expect(draft.maps.id).toEqual(maps.map((m) => m.id));
    expect(draft.rulesVersion).toBe(theory.rulesVersion);
    expect(draft.theory.counters.a.length).toBe(theory.counters.length);
    expect(draft.theory.synergies.a.length).toBe(theory.synergies.length);
    expect(draft.theory.mapFit.hero.length).toBe(theory.mapFit.length);
    expect(draft.stats).toBeUndefined();
    // Reason templates and condition parts decode back to the exact theory.json lines, for every edge.
    const decoded = decodeShard(draft);
    const idx = (id: string) => decoded.byId.get(id)?.index ?? -1;
    for (const e of theory.counters) expect(decoded.counters.get(idx(e.a))?.get(idx(e.b))?.reasons, `${e.a}>${e.b}`).toEqual(e.reasons.map((r) => r.text));
    for (const e of theory.synergies) expect(decoded.synergies.get(idx(e.a))?.get(idx(e.b))?.reasons).toEqual(e.reasons.map((r) => r.text));
    const mapIdx = (id: string) => decoded.mapById.get(id)?.index ?? -1;
    for (const f of theory.mapFit) expect(decoded.mapFit.get(idx(f.hero))?.get(mapIdx(f.map))?.reasons).toEqual(f.reasons.map((r) => r.text));
  });

  it('accepts a class-B stats overlay merged into the draft shard', () => {
    const draft = fixture(DraftShardSchema, 'public/draft.json');
    const w = parseData(StatsSchema, readJson(path.join(FIXTURES, '_private', 'stats.json')), 'stats').modes.sl?.current;
    if (!w) throw new Error('fixture stats lack sl/current');
    const H = draft.heroes.id.length;
    const M = draft.maps.id.length;
    const at = new Map(draft.heroes.id.map((id, i) => [id, i]));
    const dense = (edges: StatsWindow['counters'], symmetric: boolean) => {
      const m = { score: Array<number | null>(H * H).fill(null), delta: Array<number | null>(H * H).fill(null), n: Array<number>(H * H).fill(0) };
      for (const e of edges) {
        const [i, j] = [at.get(e.a) as number, at.get(e.b) as number];
        for (const k of symmetric ? [i * H + j, j * H + i] : [i * H + j]) {
          m.score[k] = e.score;
          m.delta[k] = e.delta ?? null;
          m.n[k] = e.n ?? 0;
        }
      }
      return m;
    };
    const maps = { delta: Array<number | null>(H * M).fill(null), n: Array<number>(H * M).fill(0) };
    for (const [id, perMap] of Object.entries(w.maps)) {
      for (const [mapId, s] of Object.entries(perMap)) {
        const k = (at.get(id) as number) * M + draft.maps.id.indexOf(mapId);
        maps.delta[k] = s.delta;
        maps.n[k] = s.games;
      }
    }
    const hero = (pick: (s: StatsWindow['heroes'][string]) => number) => draft.heroes.id.map((id) => pick(w.heroes[id] as StatsWindow['heroes'][string]));
    const overlay = {
      stats: {
        synthetic: true, source: 'heroesprofile', mode: 'sl', timeframe: 'current', label: w.label, games: w.games,
        hero: { games: hero((s) => s.games), shrunk: hero((s) => s.shrunk), pick: hero((s) => s.pick), ban: hero((s) => s.ban), tier: draft.heroes.id.map((id) => w.heroes[id]?.tier ?? null) },
        counters: dense(w.counters, false),
        synergies: dense(w.synergies, true),
        maps,
      },
    };
    expect(() => parseData(DraftStatsOverlaySchema, overlay, 'private/hots/public/draft.json')).not.toThrow();
    expect(DraftShardSchema.safeParse({ ...draft, ...overlay }).success).toBe(true);
    expect(DraftShardSchema.safeParse({ ...draft, stats: { ...overlay.stats, maps: { delta: [], n: [] } } }).success).toBe(false);
    expect(DraftStatsOverlaySchema.safeParse({ ...overlay, heroes: draft.heroes }).success).toBe(false);
  });

  it('files patch notes, links and rotation under known ids', () => {
    for (const p of fixture(PatchesFileSchema, 'patches.json')) {
      for (const id of Object.keys(p.heroes)) expect(byId.has(id), id).toBe(true);
      for (const m of Object.keys(p.maps ?? {})) expect(curatedMaps.maps[m], m).toBeDefined();
    }
    const links = fixture(LinksSchema, 'links.json');
    for (const id of Object.keys(links.heroes)) expect(byId.get(id)?.members, id).toBeUndefined();
    for (const id of fixture(RotationSchema, 'rotation.json').heroes) expect(byId.has(id), id).toBe(true);
  });

  it('keeps synthetic stats consistent with heroes, maps and talents', () => {
    const stats = parseData(StatsSchema, readJson(path.join(FIXTURES, '_private', 'stats.json')), 'stats');
    for (const mode of Object.values(stats.modes)) {
      for (const w of [mode.current, mode.previous].filter((x) => x !== undefined)) {
        for (const id of Object.keys(w.heroes)) expect(entityIds.has(id), id).toBe(true);
        for (const e of w.counters) expect(w.counters.some((o) => o.a === e.b && o.b === e.a), `${e.a}>${e.b} antisymmetric`).toBe(true);
        for (const [id, perMap] of Object.entries(w.maps)) {
          expect(entityIds.has(id)).toBe(true);
          for (const m of Object.keys(perMap)) expect(mapIds.has(m), m).toBe(true);
        }
        for (const [id, builds] of Object.entries(w.builds)) {
          const hero = byId.get(id) as Hero;
          const pool = new Set([hero, ...(hero.members ?? []).map((m) => byId.get(m) as Hero)].flatMap((h) => Object.values(h.talents).flat().map((t) => t.id)));
          for (const b of builds) for (const t of b.talents) expect(pool.has(t), `${id}: ${t}`).toBe(true);
        }
      }
    }
  });
});

describe('hots schema rejects bad data with the file path', () => {
  it('names the file in validation errors', () => {
    expect(() => parseData(HeroesFileSchema, [{ id: 'nope' }], 'data/current/hots/heroes.json')).toThrow(DataValidationError);
    expect(() => parseData(HeroesFileSchema, [{ id: 'nope' }], 'data/current/hots/heroes.json')).toThrow(/data\/current\/hots\/heroes\.json/);
  });

  it('rejects synergy edges stored with a > b and non-theory sources in theory.json', () => {
    const edge = { a: 'Mura', b: 'Abat', score: 60, source: 'theory', reasons: [] };
    expect(TheorySchema.safeParse({ rulesVersion: 'x', counters: [], synergies: [edge], mapFit: [] }).success).toBe(false);
    expect(TheorySchema.safeParse({ rulesVersion: 'x', counters: [{ ...edge, source: 'stats' }], synergies: [], mapFit: [] }).success).toBe(false);
    expect(EdgeSchema.safeParse({ ...edge, score: 0 }).success).toBe(false);
  });

  it('rejects unknown tags and placeholders in rules', () => {
    const rule = { id: 'x', a: ['stun'], b: ['channel'], weight: 0.3, why: '{a} stops {b}.' };
    expect(RulesFileSchema.safeParse({ version: 1, counters: [rule], synergies: [] }).success).toBe(true);
    expect(RulesFileSchema.safeParse({ version: 1, counters: [{ ...rule, a: ['stunn'] }], synergies: [] }).success).toBe(false);
    expect(RulesFileSchema.safeParse({ version: 1, counters: [{ ...rule, b: ['burst&type:flying'] }], synergies: [] }).success).toBe(false);
    expect(RulesFileSchema.safeParse({ version: 1, counters: [{ ...rule, why: '{a} beats {target}.' }], synergies: [] }).success).toBe(false);
  });

  it('requires the share-alike licence on pro.json and rejects unknown keys', () => {
    const pro = readJson(path.join(FIXTURES, 'pro.json')) as Record<string, unknown>;
    const attribution = pro.attribution as Record<string, unknown>;
    expect(ProSchema.safeParse({ ...pro, attribution: { ...attribution, license: 'CC BY 4.0' } }).success).toBe(false);
    expect(RotationSchema.safeParse({ ...(readJson(path.join(FIXTURES, 'rotation.json')) as object), extra: 1 }).success).toBe(false);
  });
});

describe('hots load.ts against fixtures', () => {
  afterEach(() => {
    delete process.env.WHETSTONE_FIXTURE_PRIVATE;
    load.clearHotsCache();
  });

  it('loads and indexes heroes, maps and patches', () => {
    expect(load.getMeta().game).toBe('hots');
    expect(load.getHeroes().length).toBeGreaterThan(0);
    expect(load.getDraftableEntities().every((h) => !h.memberOf)).toBe(true);
    expect(load.getMaps().length).toBeGreaterThan(0);
    expect(load.getHeroes()).toHaveLength(15);
    expect(load.getDraftableEntities().map((h) => h.id)).toContain('chogall');
    expect(load.getDraftableEntities().map((h) => h.id)).not.toContain('CCho');
    expect(load.getHeroBySlug('liming')?.id).toBe('Wiza');
    expect(load.getEntity('cho')?.id).toBe('chogall');
    expect(load.getMembers(load.getEntity('chogall') as Hero).map((h) => h.slug)).toEqual(['cho', 'gall']);
    expect(load.getRankedMaps().map((m) => m.id)).not.toContain('hanamura-temple');
    expect(load.getPatchesSince('2026-09-30').map((p) => p.id)).toEqual(['2026-10-05-hotfix']);
    expect(load.getHeroPatchHistory(load.getHeroBySlug('xalatath') as Hero).map((e) => e.patch.id)).toEqual(['2026-10-05-hotfix', '2026-09-29-hotfix', '2026-09-28-patch', '2026-09-14-ptr']);
    expect(load.getHeroLinks(load.getEntity('chogall') as Hero).length).toBeGreaterThan(0);
    expect(load.isFreeToPlay(load.getHeroBySlug('diablo') as Hero)).toBe(true);
    expect(load.isFreeToPlay(load.getHeroBySlug('johanna') as Hero)).toBe(false);
  });

  it('resolves names, nicknames and localized aliases to draftable entities', () => {
    expect(load.resolveHero('Li Ming')?.slug).toBe('liming');
    expect(load.resolveHero('li-ming')?.slug).toBe('liming');
    expect(load.resolveHero('cho gall')?.slug).toBe('chogall');
    expect(load.resolveHero('Gall')?.slug).toBe('chogall');
    expect(load.resolveHero('xal')?.slug).toBe('xalatath');
    expect(load.resolveHero('Диабло')?.slug).toBe('diablo');
    expect(load.resolveHero('nobody')).toBeUndefined();
  });

  it('falls back to labelled theory edges without stats', () => {
    expect(load.getStats()).toBeNull();
    expect(load.getVideos()).toBeNull();
    const m = load.heroEdges('johanna');
    expect(m?.primary).toBe('theory');
    expect(m?.label).toBe(load.THEORY_LABEL);
    // Curated matchups first (Tracer and Valla, both 88), then generic rule matches by score.
    expect(m?.strong.slice(0, 2).map((r) => r.hero.slug)).toEqual(['tracer', 'valla']);
    expect(m?.strong[0]?.source).toBe('curated');
    const firstGeneric = m?.strong.findIndex((r) => r.source !== 'curated') ?? -1;
    expect(m?.strong.slice(0, firstGeneric).every((r) => r.source === 'curated')).toBe(true);
    // The theory bar: curated, or generic rules scoring 65+; the rest is shown below the bar.
    for (const r of m?.strong ?? []) {
      expect(r.score).toBeGreaterThan(50);
      expect(r.gate).toBe(r.source === 'curated' || r.score >= load.THEORY_GATES.listMinScore ? 'listed' : 'shown');
    }
    expect(m?.strong.some((r) => r.gate === 'shown')).toBe(true);
    expect(load.heroEdges('cho')?.hero.id).toBe('chogall');
    expect(load.heroEdges('unknown')).toBeNull();
    expect(load.heroMapFit('abathur')[0]?.source).toBe('theory');
  });

  it('reads synthetic private samples only when WHETSTONE_FIXTURE_PRIVATE=1', () => {
    process.env.WHETSTONE_FIXTURE_PRIVATE = '1';
    load.clearHotsCache();
    expect(load.getStats()?.synthetic).toBe(true);
    expect(load.getStatsWindow('sl', 'previous')).not.toBeNull();
    expect(load.getStatsWindow('qm')).toBeNull();
    const m = load.heroEdges('johanna');
    expect(m?.primary).toBe('stats');
    for (const row of [...(m?.strong ?? []), ...(m?.weak ?? [])]) {
      expect(row.gate).not.toBe('hidden');
      expect(row.edge.n).toBeGreaterThanOrEqual(load.GATES.hideBelow);
    }
    expect(m?.strong.some((r) => r.theory !== undefined && r.reasons.length > r.edge.reasons.length)).toBe(true);
    expect(load.getVideos()?.videos.length).toBeGreaterThan(0);
    expect(load.getStreams()?.streams.length).toBeGreaterThan(0);
    expect(load.getStreams({ now: new Date('2026-10-10T00:00:00Z') })).toBeNull();
    expect(load.heroMapFit('abathur')[0]?.source).toBe('stats');
  });

  it('applies the SPEC §6 display gates', () => {
    expect(load.statGate(14, 9)).toBe('hidden');
    expect(load.statGate(20, 9)).toBe('grey');
    expect(load.statGate(40, 9)).toBe('shown');
    expect(load.statGate(60, 1)).toBe('shown');
    expect(load.statGate(60, -1.5)).toBe('listed');
    expect(load.scoreFromDelta(0)).toBe(50);
    expect(load.scoreFromDelta(4)).toBe(88);
  });
});
