/**
 * Pokémon Champions data pipeline (SPEC §4, critique D14: VGC Doubles first, Battle Stadium
 * Singles usage alongside because Smogon publishes it in the same run).
 *
 *   regulations  curated/pokemon/regulations.yaml → regulations.json; picks the regulation in force
 *   showdown     Champions dex exported from Pokémon Showdown at an exact commit (+ sprites)
 *   smogon-calc  cross-check of that dex against @smogon/calc generation 0
 *   smogon       monthly chaos usage → usage/<format>-<cutoff>.json + usage/index.json
 *   limitless    grassroots tournaments of the last 30 days → tournaments.json (no player data)
 *   showdown-replays  public Bo3 replays → ledger/showdown-replays.json → h2h.json
 *   speed        derived from the dex and the doubles usage → speed.json
 *
 * Every source falls back to its own last-good files (ctx.previous) and reports `failed` with a
 * warning; only a missing dex on the very first run (nothing to show at all) or invalid output
 * is an error, which makes the runner keep the whole game's last-good data. After a regulation
 * change, sources that have no data for the new one yet keep the previous regulation's data and
 * meta.extra.warmingUp says so.
 */
import type { DataPipeline, OutputFile, PipelineContext, PipelineResult, SourceStatus, ValidationIssue } from '../../../core/game.ts';
import { isSelected } from '../../../../pipeline/context.ts';
import { compareStrings } from '../../../../pipeline/hash.ts';
import { validateData, validateFiles } from '../../../../pipeline/validate.ts';
import { POKEMON_FILES, PokemonMetaExtraSchema, RegulationsFileSchema, type PokemonMeta, type RegulationsFile, type SpeedTiers, type Usage } from '../schema.ts';
import { errorMessage, json, SOURCE_IDS, type SourceId } from './common.ts';
import { dexIndex } from './ids.ts';
import { runLimitlessSource } from './limitless/source.ts';
import { loadRegulations, regulationPlan, REGULATIONS_FILE, type RegulationPlan } from './regulations.ts';
import { runReplaySource } from './replays/source.ts';
import { runDexSource, type DexOutcome, type DexSourceOptions } from './showdown/source.ts';
import type { DexFiles } from './showdown/transform.ts';
import { runSmogonSource } from './smogon/source.ts';
import { speedTiers } from './speed.ts';
import { SPRITE_CREDIT, SPRITE_SOURCE } from './sprites.ts';

/** meta.json schema version of this game. */
export const META_SCHEMA = 1;
export const SPEED_FILE = 'speed.json';

type Extra = PokemonMeta['extra'];

/** Ids every ingesting source resolves against. */
export function knownIds(dex: DexFiles) {
  return {
    dex: dexIndex(dex.species, dex.items),
    moves: new Set(dex.moves.map((m) => m.id)),
    items: new Set(dex.items.map((i) => i.id)),
    abilities: new Set(dex.abilities.map((a) => a.id)),
  };
}

/**
 * Usage behind the speed tiers: the doubles format of the regulation the usage describes, at
 * the highest cutoff available (the most competitive spreads).
 */
export function speedUsage(usage: readonly Usage[], plan: RegulationPlan): Usage | null {
  for (const reg of [plan.current, ...(plan.previous ? [plan.previous] : [])]) {
    const pick = usage.filter((u) => u.regulation === reg.id && u.format === reg.formats.doubles).sort((a, b) => b.cutoff - a.cutoff)[0];
    if (pick) return pick;
  }
  return null;
}

/**
 * The "data warming up" state: sources whose data still describes another regulation than the
 * current one. Absent when every source with data is on the current regulation.
 */
export function warmingUp(plan: RegulationPlan, regulations: Readonly<Partial<Record<SourceId, string | undefined>>>): Extra['warmingUp'] | undefined {
  const behind = Object.entries(regulations)
    .filter((e): e is [SourceId, string] => typeof e[1] === 'string' && e[1] !== plan.current.id)
    .sort((a, b) => SOURCE_IDS.indexOf(a[0]) - SOURCE_IDS.indexOf(b[0]));
  if (behind.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const [, reg] of behind) counts.set(reg, (counts.get(reg) ?? 0) + 1);
  const showing = [...counts].sort((a, b) => b[1] - a[1] || compareStrings(a[0], b[0]))[0]?.[0];
  return {
    regulation: plan.current.id,
    since: plan.current.start,
    sources: behind.map(([id]) => id),
    ...(showing ? { showing } : {}),
  };
}

/** Ids in `ids` the dex does not know (data kept from an older dex, for example). */
function unknownIds(ids: Iterable<string>, dex: DexFiles): string[] {
  const known = new Set(dex.species.map((s) => s.id));
  return [...new Set([...ids].filter((id) => !known.has(id)))].sort(compareStrings);
}

function crossFileIssues(dex: DexFiles | null, outcome: { usage: readonly Usage[]; tournamentIds: string[]; h2hIds: string[]; speed: SpeedTiers | null }): ValidationIssue[] {
  if (!dex) return [];
  const out: ValidationIssue[] = [];
  const check = (source: SourceId, what: string, ids: Iterable<string>): void => {
    const missing = unknownIds(ids, dex);
    if (missing.length > 0) out.push({ level: 'warn', source, message: `${what} names species the dex does not have: ${missing.slice(0, 10).join(', ')}${missing.length > 10 ? ', …' : ''}` });
  };
  check('smogon', 'usage', outcome.usage.flatMap((u) => u.pokemon.map((p) => p.id)));
  check('limitless', 'tournaments.json', outcome.tournamentIds);
  check('showdown-replays', 'h2h.json', outcome.h2hIds);
  if (outcome.speed) check('smogon', SPEED_FILE, outcome.speed.entries.map((e) => e.id));
  return out;
}

function sinceDate(iso: string): string {
  return iso.slice(0, 10);
}

/** A result that only carries an error (the runner keeps the last-good data of the game). */
function fatal(ctx: PipelineContext, message: string): PipelineResult {
  const prev = ctx.previousMeta;
  return {
    meta: {
      game: 'pokemon',
      schema: META_SCHEMA,
      version: prev?.version ?? { label: 'Pokémon Champions' },
      sources: prev?.sources ?? SOURCE_IDS.map((id) => ({ id, fetchedAt: null, status: 'failed' as const })),
      counts: prev?.counts ?? {},
      ...(prev?.extra ? { extra: prev.extra } : {}),
    },
    files: [],
    issues: [{ level: 'error', message }],
  };
}

export interface PokemonRunOptions {
  /** Regulations to use instead of the curated file (tests). */
  regulations?: RegulationsFile;
  dex?: DexSourceOptions;
}

export async function runPokemon(ctx: PipelineContext, opts: PokemonRunOptions = {}): Promise<PipelineResult> {
  const started = Date.now();
  let regs: RegulationsFile;
  try {
    regs = opts.regulations ? RegulationsFileSchema.parse(opts.regulations) : loadRegulations(ctx.root);
  } catch (err) {
    return fatal(ctx, `${REGULATIONS_FILE} is invalid: ${errorMessage(err)}`);
  }
  const plan = regulationPlan(regs, ctx.now);
  ctx.log(`regulation ${plan.current.id}${plan.season ? `, season ${plan.season.id}` : ''}${plan.previous ? ` (previous ${plan.previous.id})` : ''}`);

  const dex: DexOutcome = await runDexSource(ctx, regs, plan, isSelected(ctx, 'showdown'), opts.dex);
  const known = dex.dex ? knownIds(dex.dex) : null;

  // Different hosts (smogon.com, play.limitlesstcg.com, replay.pokemonshowdown.com): each keeps
  // its own spacing in Http, so they can crawl at the same time.
  const [usage, tours, replays] = await Promise.all([
    runSmogonSource(ctx, plan, known, isSelected(ctx, 'smogon')),
    runLimitlessSource(ctx, plan, known, isSelected(ctx, 'limitless')),
    runReplaySource(ctx, plan, known?.dex ?? null, isSelected(ctx, 'showdown-replays')),
  ]);

  const files: OutputFile[] = [json('regulations.json', regs), ...dex.files, ...usage.files, ...tours.files, ...replays.files];
  const issues: ValidationIssue[] = [...dex.issues, ...usage.issues, ...tours.issues, ...replays.issues];

  let speed: SpeedTiers | null = null;
  const forSpeed = speedUsage(usage.usage, plan);
  if (dex.dex && forSpeed) {
    speed = speedTiers(forSpeed, dex.dex.species);
    files.push(json(SPEED_FILE, speed));
  }

  issues.push(
    ...crossFileIssues(dex.dex, {
      usage: usage.usage,
      tournamentIds: tours.tournaments ? [...tours.tournaments.species.map((s) => s.id), ...tours.tournaments.teams.flatMap((t) => t.members.map((m) => m.species))] : [],
      h2hIds: replays.h2h ? [...replays.h2h.counters, ...replays.h2h.synergies].flatMap((e) => [e.a, e.b]) : [],
      speed,
    }),
  );
  issues.push(...validateFiles(files, POKEMON_FILES));

  const warming = warmingUp(plan, { showdown: dex.regulation, smogon: usage.regulation, limitless: tours.regulation, 'showdown-replays': replays.regulation });
  if (warming) ctx.log(`data warming up for ${warming.regulation}: ${warming.sources.join(', ')} still show ${warming.showing ?? 'older data'}`);
  const sprites = dex.dex ? dex.dex.species.filter((s) => s.sprite).length : 0;
  const extra: Extra = {
    regulation: plan.current.id,
    regulationLabel: plan.current.label,
    window: { start: plan.current.start, end: plan.current.end },
    ...(plan.season ? { season: plan.season } : {}),
    formats: plan.current.formats,
    ...(usage.month ? { smogonMonth: usage.month } : {}),
    ...(dex.sha ? { showdownSha: dex.sha } : {}),
    ...(warming ? { warmingUp: warming } : {}),
    ...(dex.dexKey ? { dexKey: dex.dexKey } : {}),
    ...(sprites > 0 ? { sprites: { count: sprites, source: SPRITE_SOURCE, credit: SPRITE_CREDIT } } : {}),
  };

  // meta.json is written by the runner, so validateFiles never sees it: check the extras here.
  const checkedExtra = validateData(PokemonMetaExtraSchema, extra, { file: 'meta.json extra' });
  if (!checkedExtra.ok) issues.push(...checkedExtra.issues);

  const statuses: Record<SourceId, SourceStatus> = {
    showdown: dex.status,
    smogon: usage.status,
    limitless: tours.status,
    'showdown-replays': replays.status,
    'smogon-calc': dex.calc,
  };
  const counts: Record<string, number> = {
    ...(dex.dex
      ? { species: dex.dex.species.length, moves: dex.dex.moves.length, items: dex.dex.items.length, abilities: dex.dex.abilities.length, sprites }
      : {}),
    ...dex.counts,
    ...usage.counts,
    ...tours.counts,
    ...replays.counts,
    ...(speed ? { speedEntries: speed.entries.length } : {}),
  };
  const sortedCounts = Object.fromEntries(Object.entries(counts).sort((a, b) => compareStrings(a[0], b[0])));
  ctx.log(`done in ${((Date.now() - started) / 1000).toFixed(1)} s: ${Object.entries(sortedCounts).map(([k, v]) => `${k}=${v}`).join(' ')}`);

  return {
    meta: {
      game: 'pokemon',
      schema: META_SCHEMA,
      version: { label: `Reg ${plan.current.id}`, since: sinceDate(plan.current.start) },
      sources: SOURCE_IDS.map((id) => statuses[id]),
      counts: sortedCounts,
      extra,
    },
    files,
    issues,
  };
}

export const pipeline: DataPipeline = { run: (ctx) => runPokemon(ctx) };
