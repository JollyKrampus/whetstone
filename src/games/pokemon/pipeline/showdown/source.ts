/**
 * Source `showdown`: the Champions dex (species, moves, items, abilities, type chart,
 * learnsets, browser shard) plus sprites, with the `smogon-calc` cross-check.
 *
 * Skip rule: the export is keyed by Showdown commit + exporter/tree versions + the regulation
 * formats (meta.extra.dexKey). An unchanged key re-emits the last-good dex without downloading
 * anything but the commit SHA. Offline runs use the recorded export in fixtures/raw/showdown/.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { OutputFile, PipelineContext, SourceStatus, ValidationIssue } from '../../../../core/game.ts';
import { parseData } from '../../../../core/schemas.ts';
import { sha256 } from '../../../../../pipeline/hash.ts';
import { checkCount } from '../../../../../pipeline/validate.ts';
import {
  AbilitiesFileSchema,
  ItemsFileSchema,
  LearnsetsSchema,
  MovesFileSchema,
  PokemonMetaExtraSchema,
  SpeciesFileSchema,
  TypeChartSchema,
  type DexShard,
  type RegulationsFile,
  type Species,
} from '../../schema.ts';
import { error, errorMessage, failed, invalid, json, notSelected, ok, previousFile, warn, type SourceOutcome } from '../common.ts';
import type { RegulationPlan } from '../regulations.ts';
import { collectSprites } from '../sprites.ts';
import { buildTree, exportDex, latestSha, TREE_VERSION } from './build.ts';
import { crossCheckWithCalc, type CrossCheck } from './crosscheck.ts';
import { EXPORTER_VERSION, type ExportRequest } from './export.ts';
import { RawDexExportSchema, type RawDexExport } from './raw.ts';
import { transformDex, type DexFiles } from './transform.ts';

export const DEX_FILES = {
  species: 'dex/species.json',
  moves: 'dex/moves.json',
  items: 'dex/items.json',
  abilities: 'dex/abilities.json',
  typechart: 'dex/typechart.json',
  learnsets: 'dex/learnsets.json',
  shard: 'public/dex.json',
} as const;

/** Recorded export used by --offline runs and tests (a trimmed real export). */
export const RECORDED_EXPORT = 'src/games/pokemon/fixtures/raw/showdown/export.json';
/** Online sanity floor: Champions has had 180+ legal entries since launch. */
export const MIN_SPECIES = 150;

export interface DexSourceOptions {
  /** Produces the raw export of a commit (default: build the tree and run export.ts). Tests inject one. */
  exporter?: (ctx: PipelineContext, sha: string, request: ExportRequest) => Promise<RawDexExport>;
  /** Minimum number of entries an online export must have (default MIN_SPECIES). */
  minSpecies?: number;
}

async function buildAndExport(ctx: PipelineContext, sha: string, request: ExportRequest): Promise<RawDexExport> {
  const dist = await buildTree({ http: ctx.http, root: ctx.root, sha, log: ctx.log });
  return exportDex(dist, request, sha);
}

export interface DexOutcome extends SourceOutcome {
  /** The dex in effect after this run (fresh or last-good), or null when there is none. */
  dex: DexFiles | null;
  sha?: string;
  dexKey?: string;
  calc: SourceStatus;
}

export function dexRequest(regs: RegulationsFile, plan: RegulationPlan): ExportRequest {
  return {
    regulations: regs.regulations.map((r) => ({ id: r.id, format: r.formats.doubles })),
    dataRegulations: [plan.current.id, ...(plan.previous ? [plan.previous.id] : [])],
  };
}

export function dexKey(sha: string, request: ExportRequest): string {
  return sha256(`${sha}|exporter ${EXPORTER_VERSION}|tree ${TREE_VERSION}|${JSON.stringify(request)}`).slice(0, 16);
}

export function dexOutputs(dex: DexFiles, regulation: string): OutputFile[] {
  const shard: DexShard = { schema: 1, regulation, ...dex };
  return [
    json(DEX_FILES.species, dex.species),
    json(DEX_FILES.moves, dex.moves),
    json(DEX_FILES.items, dex.items),
    json(DEX_FILES.abilities, dex.abilities),
    json(DEX_FILES.typechart, dex.typechart),
    json(DEX_FILES.learnsets, dex.learnsets),
    json(DEX_FILES.shard, shard),
  ];
}

export async function previousDex(ctx: PipelineContext): Promise<DexFiles | null> {
  const species = await previousFile(ctx, DEX_FILES.species, SpeciesFileSchema);
  const moves = await previousFile(ctx, DEX_FILES.moves, MovesFileSchema);
  const items = await previousFile(ctx, DEX_FILES.items, ItemsFileSchema);
  const abilities = await previousFile(ctx, DEX_FILES.abilities, AbilitiesFileSchema);
  const typechart = await previousFile(ctx, DEX_FILES.typechart, TypeChartSchema);
  const learnsets = await previousFile(ctx, DEX_FILES.learnsets, LearnsetsSchema);
  if (!species || !moves || !items || !abilities || !typechart || !learnsets) return null;
  return { species, moves, items, abilities, typechart, learnsets };
}

export function readRecordedExport(root: string): RawDexExport {
  const file = path.join(root, RECORDED_EXPORT);
  return parseData(RawDexExportSchema, JSON.parse(readFileSync(file, 'utf8')), RECORDED_EXPORT, { roundTrip: false });
}

function calcVersion(): string {
  try {
    const file = createRequire(import.meta.url).resolve('@smogon/calc/package.json');
    const pkg = JSON.parse(readFileSync(file, 'utf8')) as { version?: string };
    return pkg.version ?? '?';
  } catch {
    return '?';
  }
}

/** Status of `smogon-calc`: how the dex in effect compares with the calc's Champions table. */
export function calcStatus(ctx: PipelineContext, check: CrossCheck | null, note?: string): SourceStatus {
  const base = `@smogon/calc ${calcVersion()} (Champions = generation 0)`;
  if (!check) return ok(ctx, 'smogon-calc', `${base}${note ? `; ${note}` : ''}`);
  const parts = [`${check.matched} species match the dex`];
  if (check.missing.length > 0) parts.push(`${check.missing.length} not in the calc yet`);
  if (check.mismatches.length > 0) parts.push(`${check.mismatches.length} disagree with the dex`);
  return ok(ctx, 'smogon-calc', `${base}: ${parts.join(', ')}`);
}

/** Legal species (without Megas) and Megas of one regulation in a dex. */
export function legalCounts(dex: DexFiles, regulation: string): { species: number; megas: number } {
  let species = 0;
  let megas = 0;
  for (const s of dex.species) {
    if (!s.legal.includes(regulation)) continue;
    if (s.megaOf) megas++;
    else species++;
  }
  return { species, megas };
}

/**
 * Status detail of the dex in effect. It describes the data, not what this run did, so a run
 * that reuses an unchanged dex reports exactly what the run that built it reported (the detail
 * is part of meta.json and so of dataHash).
 */
export function describeDex(dex: DexFiles, o: { sha: string; regulation: string; regulations: readonly string[]; recorded?: boolean }): string {
  const legal = o.regulations
    .map((id) => ({ id, ...legalCounts(dex, id) }))
    .filter((c) => c.species + c.megas > 0)
    .map((c) => `${c.id}: ${c.species} species + ${c.megas} Megas`);
  const sprites = dex.species.filter((s) => s.sprite).length;
  return `${o.recorded ? 'recorded export of ' : ''}${o.sha.slice(0, 7)}, data for ${o.regulation}; ${legal.join('; ')}; ${sprites}/${dex.species.length} sprites`;
}

/** Attach sprite paths (and emit img/** when the roster's images changed). */
async function withSprites(ctx: PipelineContext, dex: DexFiles, spriteIds: Record<string, string> | null): Promise<{ dex: DexFiles; files: OutputFile[]; missing: string[] }> {
  const sprites = await collectSprites(ctx, dex.species, spriteIds);
  const species: Species[] = dex.species.map((s) => {
    const p = sprites.paths.get(s.id);
    const { sprite: _old, ...rest } = s;
    return p ? { ...rest, sprite: p } : rest;
  });
  if (sprites.fetched > 0) ctx.log(`showdown: converted ${sprites.fetched} new sprites to WebP`);
  return { dex: { ...dex, species }, files: sprites.files, missing: sprites.missing };
}

const list = (ids: readonly string[], max = 12): string => `${ids.slice(0, max).join(', ')}${ids.length > max ? ', …' : ''}`;

function countsOf(c: { species: number; megas: number }): Record<string, number> {
  return { legalSpecies: c.species, legalMegas: c.megas };
}

export async function runDexSource(ctx: PipelineContext, regs: RegulationsFile, plan: RegulationPlan, selected: boolean, opts: DexSourceOptions = {}): Promise<DexOutcome> {
  const previous = await previousDex(ctx);
  const prevExtra = PokemonMetaExtraSchema.partial().safeParse(ctx.previousMeta?.extra ?? {});
  const prev = prevExtra.success ? prevExtra.data : {};
  const prevShard = (await ctx.previous(DEX_FILES.shard)) as { regulation?: unknown } | null;
  const prevRegulation = typeof prevShard?.regulation === 'string' ? prevShard.regulation : (prev.regulation ?? plan.current.id);
  const regulationIds = regs.regulations.map((r) => r.id);
  const issues: ValidationIssue[] = [];

  const keepPrevious = (status: SourceStatus, calc?: SourceStatus): DexOutcome => ({
    status,
    files: previous ? dexOutputs(previous, prevRegulation) : [],
    issues,
    regulation: prevRegulation,
    dex: previous,
    ...(prev.showdownSha ? { sha: prev.showdownSha } : {}),
    ...(prev.dexKey ? { dexKey: prev.dexKey } : {}),
    calc: calc ?? calcStatus(ctx, previous ? crossCheckWithCalc(previous.species) : null, previous ? undefined : 'no dex to compare'),
    ...(previous ? { counts: countsOf(legalCounts(previous, prevRegulation)) } : {}),
  });

  // The calc cross-check is local and cheap: it still describes the dex that stays in effect.
  if (!selected) return keepPrevious(notSelected(ctx, 'showdown'));

  const request = dexRequest(regs, plan);
  let raw: RawDexExport;
  let key: string;
  try {
    if (ctx.offline) {
      raw = readRecordedExport(ctx.root);
      key = dexKey(raw.sha, request);
    } else {
      const sha = await latestSha(ctx.http, ctx.log);
      key = dexKey(sha, request);
      if (previous && prev.dexKey === key) {
        ctx.log(`showdown: ${sha.slice(0, 7)} already exported; re-emitting the last-good dex`);
        const sprited = await withSprites(ctx, previous, null);
        const check = crossCheckWithCalc(sprited.dex.species);
        if (check.mismatches.length > 0) issues.push(warn('smogon-calc', `@smogon/calc disagrees with the dex: ${list(check.mismatches, 5)}`));
        return {
          status: ok(ctx, 'showdown', describeDex(sprited.dex, { sha, regulation: prevRegulation, regulations: regulationIds })),
          files: [...dexOutputs(sprited.dex, prevRegulation), ...sprited.files],
          issues,
          regulation: prevRegulation,
          dex: sprited.dex,
          sha,
          dexKey: key,
          calc: calcStatus(ctx, check),
          counts: countsOf(legalCounts(sprited.dex, prevRegulation)),
        };
      }
      raw = await (opts.exporter ?? buildAndExport)(ctx, sha, request);
    }
  } catch (err) {
    const msg = `dex export failed: ${errorMessage(err)}`;
    issues.push(previous ? warn('showdown', `${msg}; last-good dex kept`) : error('showdown', msg));
    return keepPrevious(failed(ctx, 'showdown', msg, previous !== null));
  }

  let t: ReturnType<typeof transformDex>;
  try {
    t = transformDex(raw);
  } catch (err) {
    const msg = `dex transform failed for ${raw.sha.slice(0, 7)}: ${errorMessage(err)}`;
    issues.push(previous ? warn('showdown', `${msg}; last-good dex kept`) : error('showdown', msg));
    return keepPrevious(failed(ctx, 'showdown', msg, previous !== null));
  }
  for (const w of t.warnings.slice(0, 10)) issues.push(warn('showdown', w));
  const problems = invalid(dexOutputs(t.files, raw.dataRegulation), 'showdown');
  const check = crossCheckWithCalc(t.files.species);
  const prevSpecies = ctx.previousMeta?.counts.species ?? null;
  const counted = ctx.offline
    ? []
    : checkCount({
        name: 'species',
        count: t.files.species.length,
        // A new regulation may legitimately shrink the roster.
        previous: prevRegulation === raw.dataRegulation ? prevSpecies : null,
        maxDropPct: 15,
        min: opts.minSpecies ?? MIN_SPECIES,
        source: 'showdown',
      });
  const rejection = [...problems.map((p) => p.message), ...check.mismatches.map((m) => `differs from @smogon/calc: ${m}`), ...counted.map((c) => c.message)];
  if (rejection.length > 0) {
    const msg = `rejected the export of ${raw.sha.slice(0, 7)}: ${list(rejection, 5)}`;
    issues.push(previous ? warn('showdown', `${msg}; last-good dex kept`) : error('showdown', msg));
    return keepPrevious(failed(ctx, 'showdown', msg, previous !== null), calcStatus(ctx, check));
  }
  if (check.missing.length > 0) issues.push(warn('smogon-calc', `not in @smogon/calc yet (the calc cannot use them): ${list(check.missing)}`));
  if (t.missingRegulations.length > 0) ctx.log(`showdown: no format for ${t.missingRegulations.join(', ')} in this tree`);

  const sprited = await withSprites(ctx, t.files, t.spriteIds);
  if (sprited.missing.length > 0 && !ctx.offline) issues.push(warn('showdown', `no sprite for ${list(sprited.missing)}`));
  ctx.log(`showdown: exported ${raw.sha.slice(0, 7)} (${raw.dataMod} mod): ${t.files.species.length} species/formes, ${t.files.moves.length} moves, ${t.files.items.length} items`);
  return {
    status: ok(ctx, 'showdown', describeDex(sprited.dex, { sha: raw.sha, regulation: raw.dataRegulation, regulations: regulationIds, recorded: ctx.offline })),
    files: [...dexOutputs(sprited.dex, raw.dataRegulation), ...sprited.files],
    issues,
    regulation: raw.dataRegulation,
    dex: sprited.dex,
    sha: raw.sha,
    dexKey: key,
    calc: calcStatus(ctx, check),
    counts: countsOf(legalCounts(sprited.dex, raw.dataRegulation)),
  };
}
