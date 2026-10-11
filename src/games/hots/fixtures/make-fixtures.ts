/**
 * Rebuild the committed HotS fixtures (fixtures/hots/**) from a live pipeline run.
 *
 *   node pipeline/run.ts --game hots                     # live run into data/
 *   node src/games/hots/fixtures/make-fixtures.ts [--from data/current/hots]
 *
 * Keeps the same small cast so tests and e2e stay stable: 15 hero records (Cho'gall as the
 * composite plus its members), 6 maps, and real data for them: kit text, mechanics, the theory
 * edges among them (the engine's own output, filtered), patches and diffs that touch them,
 * links, the free rotation, portraits, draft portraits and map images. Ability icons are left out
 * to keep the fixtures small (pages draw placeholders through hasAsset).
 *
 * Stays synthetic and is only re-keyed: pro.json (Liquipedia-derived data is CC BY-SA, so the
 * repository ships made-up numbers) and fixtures/hots/_private/** (synthetic statistics, YouTube
 * and Twitch samples for the site's statistics mode). The draft shard and its synthetic stats
 * overlay are rebuilt from the result.
 * Every file is checked against its schema before anything is written.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseData } from '../../../core/schemas.ts';
import { statsBlockFromWindow } from '../draft/statsblock.ts';
import { buildDraftShard } from '../pipeline/transform/draft.ts';
import {
  DraftStatsOverlaySchema,
  HOTS_FILES,
  StatsSchema,
  type Diff,
  type GameMap,
  type Hero,
  type HotsMeta,
  type Links,
  type Patch,
  type Pro,
  type Rotation,
  type Theory,
} from '../schema.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../../../..');
const OUT = path.join(ROOT, 'fixtures', 'hots');

/** Hero slugs in the fixtures (composite members are added automatically). */
export const FIXTURE_HEROES = ['abathur', 'anubarak', 'chogall', 'diablo', 'johanna', 'liming', 'malfurion', 'muradin', 'tracer', 'valla', 'varian', 'xalatath', 'zeratul'];
export const FIXTURE_MAPS = ['battlefield-of-eternity', 'braxis-outpost', 'cursed-hollow', 'dragon-shire', 'hanamura-temple', 'towers-of-doom'];
/** Patch notes kept: everything since this date (live, balance, hotfix and PTR). */
const PATCHES_SINCE = '2026-04-01';

const read = <T>(dir: string, rel: string): T => JSON.parse(readFileSync(path.join(dir, rel), 'utf8')) as T;

function writeJson(rel: string, value: unknown, compact = false): void {
  const file = path.join(OUT, ...rel.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${compact ? JSON.stringify(value) : JSON.stringify(value, null, 2)}\n`);
}

function main(): void {
  const { values } = parseArgs({ options: { from: { type: 'string', default: path.join('data', 'current', 'hots') } }, strict: true });
  const src = path.resolve(ROOT, values.from as string);
  if (!existsSync(path.join(src, 'meta.json'))) throw new Error(`No pipeline output at ${src}: run node pipeline/run.ts --game hots first.`);

  const allHeroes = read<Hero[]>(src, 'heroes.json');
  const entities = allHeroes.filter((h) => FIXTURE_HEROES.includes(h.slug));
  if (entities.length !== FIXTURE_HEROES.length) throw new Error(`missing fixture heroes: ${FIXTURE_HEROES.filter((s) => !entities.some((h) => h.slug === s)).join(', ')}`);
  const memberIds = new Set(entities.flatMap((h) => h.members ?? []));
  const heroes = allHeroes.filter((h) => FIXTURE_HEROES.includes(h.slug) || memberIds.has(h.id));
  const heroIds = new Set(heroes.map((h) => h.id));
  const entityIds = new Set(entities.map((h) => h.id));

  const maps = read<GameMap[]>(src, 'maps.json').filter((m) => FIXTURE_MAPS.includes(m.id));
  const mapIds = new Set(maps.map((m) => m.id));

  const fullTheory = read<Theory>(src, 'theory.json');
  const theory: Theory = {
    rulesVersion: fullTheory.rulesVersion,
    counters: fullTheory.counters.filter((e) => entityIds.has(e.a) && entityIds.has(e.b)),
    synergies: fullTheory.synergies.filter((e) => entityIds.has(e.a) && entityIds.has(e.b)),
    mapFit: fullTheory.mapFit.filter((f) => entityIds.has(f.hero) && mapIds.has(f.map)),
  };

  const patches = read<Patch[]>(src, 'patches.json')
    .filter((p) => p.date >= PATCHES_SINCE)
    .map((p) => {
      const kept: Patch = { ...p, heroes: Object.fromEntries(Object.entries(p.heroes).filter(([id]) => heroIds.has(id))) };
      if (p.maps) {
        const m = Object.fromEntries(Object.entries(p.maps).filter(([id]) => mapIds.has(id)));
        if (Object.keys(m).length > 0) kept.maps = m;
        else delete kept.maps;
      }
      return kept;
    });

  const diffs = read<Diff[]>(src, 'diffs.json')
    .map((d) => ({ ...d, heroes: Object.fromEntries(Object.entries(d.heroes).filter(([id]) => heroIds.has(id))) }))
    .filter((d) => Object.keys(d.heroes).length > 0);

  const links = read<Links>(src, 'links.json');
  const fixtureLinks: Links = { ...links, heroes: Object.fromEntries(Object.entries(links.heroes).filter(([id]) => heroIds.has(id))) };

  const { lagging: _lagging, ...rotation } = read<Rotation>(src, 'rotation.json');
  // Keep the fixture rotation current even when the live one was fetched after its window ended
  // or is flagged `lagging` (the run came on the switch day): the stale paths have their own unit
  // tests, and fixtures should show free heroes.
  const fetchedAt = rotation.fetchedAt.slice(0, 10) > rotation.end ? `${rotation.end}T12:00:00.000Z` : rotation.fetchedAt;
  const fixtureRotation: Rotation = { ...rotation, fetchedAt, heroes: rotation.heroes.filter((id) => heroIds.has(id)) };

  // Synthetic pick/ban numbers stay; keep them keyed by the fixture entities.
  const pro = read<Pro>(OUT, 'pro.json');
  const fixturePro: Pro = { ...pro, heroes: pro.heroes.filter((r) => entityIds.has(r.hero)) };

  const liveMeta = read<HotsMeta>(src, 'meta.json');
  const shard = buildDraftShard({ build: liveMeta.extra.build, major: liveMeta.extra.major, heroes, maps, theory });

  const counts = {
    heroes: heroes.filter((h) => !h.members).length,
    maps: maps.length,
    patches: patches.length,
    proMaps: fixturePro.totals.maps,
    talents: heroes.filter((h) => !h.members).reduce((n, h) => n + Object.values(h.talents).reduce((m, list) => m + list.length, 0), 0),
    theoryCounters: theory.counters.length,
    theorySynergies: theory.synergies.length,
  };
  const note: Record<string, string> = {
    'heroes-data2': `fixture: ${heroes.length} hero records from the ${liveMeta.generatedAt.slice(0, 10)} live run`,
    'heroes-images': 'fixture: portraits, draft portraits and map images from the live run (no ability icons)',
    liquipedia: 'fixture: synthetic pick/ban numbers',
  };
  const files: Record<string, unknown> = {
    'heroes.json': heroes,
    'maps.json': maps,
    'patches.json': patches,
    'diffs.json': diffs,
    'theory.json': theory,
    'links.json': fixtureLinks,
    'rotation.json': fixtureRotation,
    'pro.json': fixturePro,
    'public/draft.json': shard,
  };
  const dataHash = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16);
  const meta: HotsMeta = {
    ...liveMeta,
    dataHash,
    counts,
    sources: liveMeta.sources.map((s) => (note[s.id] ? { ...s, detail: note[s.id] as string } : s)),
  };
  files['meta.json'] = meta;

  // The synthetic statistics sample keeps its numbers; its talent builds are re-pointed at real
  // talent ids (deterministically: build k takes the (k + level)-th talent of each tier), and its
  // overlay follows the new shard order.
  const stats = parseData(StatsSchema, read(OUT, '_private/stats.json'), 'fixtures/hots/_private/stats.json');
  const byId = new Map(heroes.map((h) => [h.id, h]));
  const TIERS = ['1', '4', '7', '10', '13', '16', '20'] as const;
  for (const mode of Object.values(stats.modes)) {
    for (const w of [mode.current, mode.previous]) {
      if (!w) continue;
      for (const [id, builds] of Object.entries(w.builds)) {
        const hero = byId.get(id);
        const kit = hero?.members ? byId.get(hero.members[0] as string) : hero;
        if (!kit) throw new Error(`stats builds name unknown hero ${id}`);
        builds.forEach((b, k) => {
          b.talents = b.talents.map((old, level) => {
            const tier = kit.talents[TIERS[level] as (typeof TIERS)[number]];
            return tier[(k + level) % tier.length]?.id ?? old;
          });
        });
      }
    }
  }
  parseData(StatsSchema, stats, 'fixtures/hots/_private/stats.json');
  const window = stats.modes.sl?.current;
  if (!window) throw new Error('fixtures/hots/_private/stats.json has no sl/current window');
  const overlay = { stats: statsBlockFromWindow(window, shard, { source: stats.source, mode: 'sl', timeframe: 'current', synthetic: true }) };

  for (const [rel, value] of Object.entries(files)) {
    const entry = HOTS_FILES[rel as keyof typeof HOTS_FILES];
    parseData(entry.schema, value, `fixtures/hots/${rel}`);
  }
  parseData(DraftStatsOverlaySchema, overlay, 'fixtures/hots/_private/public/draft.json');

  for (const [rel, value] of Object.entries(files)) writeJson(rel, value, rel.startsWith('public/'));
  writeJson('_private/public/draft.json', overlay, true);
  writeJson('_private/stats.json', stats, true);

  // Images: hero portraits, draft portraits and map images, nothing else.
  rmSync(path.join(OUT, 'img'), { recursive: true, force: true });
  const images = [...heroes.flatMap((h) => [h.portrait, h.draftPortrait]), ...maps.map((m) => m.image)].filter((p): p is string => typeof p === 'string');
  for (const rel of [...new Set(images)]) {
    const from = path.join(src, ...rel.split('/'));
    if (!existsSync(from)) continue;
    const to = path.join(OUT, ...rel.split('/'));
    mkdirSync(path.dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
  console.log(`fixtures/hots: ${heroes.length} heroes, ${maps.length} maps, ${patches.length} patches, ${theory.counters.length} counters, ${theory.synergies.length} synergies, ${theory.mapFit.length} map fits, ${images.length} images`);
}

main();
