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
import { errorMessage, failed, invalid, json, notSelected, ok, previousFile, warn, type SourceOutcome } from '../common.ts';
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
const MIN_SPECIES = 150;

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

function calcStatus(ctx: PipelineContext, check: CrossCheck | null, note?: string): SourceStatus {
  const base = `@smogon/calc ${calcVersion()} (Champions = generation 0)`;
  if (!check) return ok(ctx, 'smogon-calc', `${base}${note ? `; ${note}` : ''}`);
  const parts = [`${check.matched} species cross-checked`];
  if (check.missing.length > 0) parts.push(`${check.missing.length} not in the calc yet`);
  if (check.mismatches.length > 0) parts.push(`${check.mismatches.length} disagree with Showdown`);
  return ok(ctx, 'smogon-calc', `${base}: ${parts.join(', ')}`);
}

/** Attach sprite paths (and emit img/** when the roster's images changed). */
async function withSprites(ctx: PipelineContext, dex: DexFiles, spriteIds: Record<string, string> | null): Promise<{ dex: DexFiles; files: OutputFile[]; note: string; missing: string[] }> {
  const sprites = await collectSprites(ctx, dex.species, spriteIds);
  const species: Species[] = dex.species.map((s) => {
    const p = sprites.paths.get(s.id);
    const { sprite: _old, ...rest } = s;
    return p ? { ...rest, sprite: p } : rest;
  });
  const note = `${sprites.paths.size}/${dex.species.length} sprites (Showdown gen5 set)${sprites.fetched > 0 ? `, ${sprites.fetched} fetched` : ''}`;
  return { dex: { ...dex, species }, files: sprites.files, note, missing: sprites.missing };
}

export async function runDexSource(ctx: PipelineContext, regs: RegulationsFile, plan: RegulationPlan, selected: boolean): Promise<DexOutcome> {
  const previous = await previousDex(ctx);
  const prevExtra = PokemonMetaExtraSchema.partial().safeParse(ctx.previousMeta?.extra ?? {});
  const prev = prevExtra.success ? prevExtra.data : {};
  const prevShard = (await ctx.previous(DEX_FILES.shard)) as { regulation?: string } | null;
  const prevRegulation = prevShard?.regulation ?? prev.regulation ?? plan.current.id;
  const issues: ValidationIssue[] = [];

  const keepPrevious = (status: SourceStatus, calc: SourceStatus): DexOutcome => ({
    status,
    files: previous ? dexOutputs(previous, prevRegulation) : [],
    issues,
    regulation: prevRegulation,
    dex: previous,
    ...(prev.showdownSha ? { sha: prev.showdownSha } : {}),
    ...(prev.dexKey ? { dexKey: prev.dexKey } : {}),
    calc,
  });

  if (!selected) return keepPrevious(notSelected(ctx, 'showdown'), notSelected(ctx, 'smogon-calc'));

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
        const sprited = await withSprites(ctx, previous, null);
        return {
          status: ok(ctx, 'showdown', `unchanged at ${sha.slice(0, 7)}; ${sprited.note}`),
          files: [...dexOutputs(sprited.dex, prevRegulation), ...sprited.files],
          issues,
          regulation: prevRegulation,
          dex: sprited.dex,
          sha,
          dexKey: key,
          calc: calcStatus(ctx, null, 'dex unchanged'),
        };
      }
      const dist = await buildTree({ http: ctx.http, root: ctx.root, sha, log: ctx.log });
      raw = await exportDex(dist, request, sha);
    }
  } catch (err) {
    const msg = `dex export failed: ${errorMessage(err)}`;
    issues.push(previous ? warn('showdown', `${msg}; last-good dex kept`) : { level: 'error', source: 'showdown', message: msg });
    return keepPrevious(failed(ctx, 'showdown', msg, previous !== null), calcStatus(ctx, null, 'not run'));
  }

  const t = transformDex(raw);
  for (const w of t.warnings.slice(0, 10)) issues.push(warn('showdown', w));
  const fresh = dexOutputs(t.files, raw.dataRegulation);
  const problems = invalid(fresh, 'showdown');
  const check = crossCheckWithCalc(t.files.species);
  const legalNow = t.legalCounts[raw.dataRegulation];
  const prevSpecies = ctx.previousMeta?.counts.species ?? null;
  const counted = ctx.offline
    ? []
    : checkCount({
        name: 'species',
        count: t.files.species.length,
        // A new regulation may legitimately shrink the roster.
        previous: prevRegulation === raw.dataRegulation ? prevSpecies : null,
        maxDropPct: 15,
        min: MIN_SPECIES,
        source: 'showdown',
      });
  const rejection = [
    ...problems.map((p) => p.message),
    ...check.mismatches.map((m) => `differs from @smogon/calc: ${m}`),
    ...counted.map((c) => c.message),
  ];
  if (rejection.length > 0) {
    const msg = `rejected the export of ${raw.sha.slice(0, 7)}: ${rejection.slice(0, 5).join('; ')}${rejection.length > 5 ? ` (+${rejection.length - 5} more)` : ''}`;
    issues.push(previous ? warn('showdown', `${msg}; last-good dex kept`) : { level: 'error', source: 'showdown', message: msg });
    return keepPrevious(failed(ctx, 'showdown', msg, previous !== null), calcStatus(ctx, check));
  }
  if (check.missing.length > 0) issues.push(warn('smogon-calc', `not in @smogon/calc yet (the calc cannot use them): ${check.missing.slice(0, 12).join(', ')}${check.missing.length > 12 ? ', …' : ''}`));
  if (t.missingRegulations.length > 0) ctx.log(`showdown: no format for ${t.missingRegulations.join(', ')} in this tree`);

  const sprited = await withSprites(ctx, t.files, t.spriteIds);
  if (sprited.missing.length > 0 && !ctx.offline) issues.push(warn('showdown', `no sprite for ${sprited.missing.slice(0, 12).join(', ')}${sprited.missing.length > 12 ? ', …' : ''}`));
  const legal = Object.entries(t.legalCounts)
    .map(([id, c]) => `${id}: ${c.species} species + ${c.megas} Megas`)
    .join('; ');
  return {
    status: ok(ctx, 'showdown', `${ctx.offline ? 'recorded export' : 'commit'} ${raw.sha.slice(0, 7)} (${raw.dataMod} mod); ${legal}; ${sprited.note}`),
    files: [...dexOutputs(sprited.dex, raw.dataRegulation), ...sprited.files],
    issues,
    regulation: raw.dataRegulation,
    dex: sprited.dex,
    sha: raw.sha,
    dexKey: key,
    calc: calcStatus(ctx, check),
    counts: { legalSpecies: legalNow?.species ?? 0, legalMegas: legalNow?.megas ?? 0 },
  };
}
