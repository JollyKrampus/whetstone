/**
 * Source `smogon`: monthly chaos JSON for the regulation's VGC doubles, Bo3 and Battle Stadium
 * Singles formats at cutoffs 0 / 1500 / 1760 → usage/<format>-<cutoff>.json + usage/index.json.
 *
 * Month rollover: the stats index lists one folder per month (published around the 1st). The
 * newest month's files are wanted; a file already fetched for that month (last-good) is reused,
 * so an ordinary day downloads nothing and re-emits the last-good files.
 *
 * Progressive downloads: chaos files are up to ~16 MB and smogon.com sometimes serves them at
 * ~60 KB/s (one took 276 s on 2026-10-08), so a new month is fetched in priority order (doubles
 * at the highest cutoff first) within DOWNLOAD_BUDGET_MS. Targets left over keep their last-good
 * file of an older month (each file and index entry names its own month) and the next run
 * continues where this one stopped.
 *
 * A new regulation has no Smogon month for up to ~4 weeks: meanwhile the newest month's files of
 * the previous regulation are used and the regulation is reported as warming up.
 */
import type { PipelineContext, ValidationIssue } from '../../../../core/game.ts';
import { compareStrings } from '../../../../../pipeline/hash.ts';
import { UsageIndexSchema, UsageSchema, usageFile, type Cutoff, type Regulation, type Usage, type UsageIndex } from '../../schema.ts';
import { errorMessage, failed, invalid, json, notSelected, ok, previousFile, warn, type SourceOutcome } from '../common.ts';
import type { DexIndex } from '../ids.ts';
import { candidateRegulations, type RegulationPlan } from '../regulations.ts';
import { ChaosSchema, chaosToUsage, monthLabel } from './chaos.ts';

export const STATS_ROOT = 'https://www.smogon.com/stats/';
/** Highest first: the order files are fetched in. */
export const CUTOFFS: readonly Cutoff[] = [1760, 1500, 0];
/** Per chaos file. Http retries a timeout, so one stuck file can cost up to four times this. */
export const CHAOS_TIMEOUT_MS = 240_000;
/** Downloads start only while the run has spent less than this on chaos files. */
export const DOWNLOAD_BUDGET_MS = 20 * 60_000;
const SMOGON_SPACING_MS = 1_000;

export interface UsageOutcome extends SourceOutcome {
  usage: Usage[];
  index: UsageIndex;
  /** Month of the primary file (doubles at the highest cutoff available). */
  month?: string;
}

/** Month folders (YYYY-MM) linked from the stats index, ascending. */
export function parseMonths(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href="(\d{4}-\d{2})\/"/g)) out.add(m[1] as string);
  return [...out].sort(compareStrings);
}

/** `<format>-<cutoff>.json` files linked from a month's chaos/ listing. */
export function parseChaosListing(html: string): Set<string> {
  const out = new Set<string>();
  for (const m of html.matchAll(/href="([a-z0-9]+-\d+\.json)"/g)) out.add(m[1] as string);
  return out;
}

export interface UsageTarget {
  regulation: string;
  format: string;
  cutoff: Cutoff;
}

/** Doubles (VGC), its Bo3 variant, then Battle Stadium Singles. */
export function formatsOf(reg: Regulation): string[] {
  return [reg.formats.doubles, reg.formats.doublesBo3, reg.formats.singles];
}

/**
 * Files to fetch from a month, in priority order: the current regulation's when the month has
 * its doubles format, otherwise the previous regulation's (warming up).
 */
export function chooseTargets(plan: RegulationPlan, listing: ReadonlySet<string>): UsageTarget[] {
  for (const reg of candidateRegulations(plan)) {
    if (!CUTOFFS.some((c) => listing.has(`${reg.formats.doubles}-${c}.json`))) continue;
    const targets: UsageTarget[] = [];
    for (const format of formatsOf(reg)) for (const cutoff of CUTOFFS) if (listing.has(`${format}-${cutoff}.json`)) targets.push({ regulation: reg.id, format, cutoff });
    return targets;
  }
  return [];
}

export function indexOf(usage: readonly Usage[]): UsageIndex {
  return usage
    .map((u) => ({ regulation: u.regulation, format: u.format, cutoff: u.cutoff, month: u.month, battles: u.battles, file: usageFile(u.format, u.cutoff) }))
    .sort((a, b) => compareStrings(a.file, b.file));
}

/**
 * Status detail of the usage in effect. It describes the data, not the run, so re-emitting an
 * unchanged month reports the same text as the run that fetched it (meta.json is hashed).
 */
export function describeUsage(usage: readonly Usage[]): string {
  if (usage.length === 0) return 'no usage files';
  const byMonth = new Map<string, Usage[]>();
  for (const u of usage) byMonth.set(u.month, [...(byMonth.get(u.month) ?? []), u]);
  return [...byMonth]
    .sort((a, b) => compareStrings(b[0], a[0]))
    .map(([month, list]) => {
      const formats = [...new Set(list.map((u) => u.format))].sort(compareStrings);
      const cutoffs = [...new Set(list.map((u) => u.cutoff))].sort((a, b) => a - b);
      const regs = [...new Set(list.map((u) => u.regulation))].sort(compareStrings);
      return `${monthLabel(month)}, ${regs.join('/')}: ${list.length} files (${formats.join(', ')}; cutoffs ${cutoffs.join('/')})`;
    })
    .join('; ');
}

function outputs(usage: readonly Usage[]) {
  return [json('usage/index.json', indexOf(usage)), ...usage.map((u) => json(usageFile(u.format, u.cutoff), u))];
}

/** The doubles file at the highest cutoff (the one pages show first). */
export function primaryUsage(usage: readonly Usage[], targets: readonly UsageTarget[]): Usage | undefined {
  for (const t of targets) {
    const u = usage.find((x) => x.format === t.format && x.cutoff === t.cutoff);
    if (u) return u;
  }
  return usage[0];
}

async function previousUsage(ctx: PipelineContext): Promise<{ index: UsageIndex; usage: Usage[] } | null> {
  const index = await previousFile(ctx, 'usage/index.json', UsageIndexSchema);
  if (!index) return null;
  const usage: Usage[] = [];
  for (const e of index) {
    if (e.synthetic) continue;
    const u = await previousFile(ctx, e.file, UsageSchema);
    if (!u) return null;
    usage.push(u);
  }
  return usage.length > 0 ? { index: indexOf(usage), usage } : null;
}

export interface UsageDeps {
  dex: DexIndex;
  moves: ReadonlySet<string>;
  items: ReadonlySet<string>;
  abilities: ReadonlySet<string>;
}

export interface SmogonOptions {
  budgetMs?: number;
  /** Wall clock for the download budget (tests). */
  clock?: () => number;
}

const sameFile = (u: Usage, t: UsageTarget): boolean => u.format === t.format && u.cutoff === t.cutoff;

export async function runSmogonSource(ctx: PipelineContext, plan: RegulationPlan, deps: UsageDeps | null, selected: boolean, opts: SmogonOptions = {}): Promise<UsageOutcome> {
  const budgetMs = opts.budgetMs ?? DOWNLOAD_BUDGET_MS;
  const clock = opts.clock ?? Date.now;
  const previous = await previousUsage(ctx);
  const issues: ValidationIssue[] = [];
  const keep = (status: UsageOutcome['status']): UsageOutcome => {
    const primary = previous ? primaryUsage(previous.usage, []) : undefined;
    return {
      status,
      files: previous ? outputs(previous.usage) : [],
      issues,
      usage: previous?.usage ?? [],
      index: previous?.index ?? [],
      ...(primary ? { regulation: primary.regulation, month: [...new Set(previous?.usage.map((u) => u.month))].sort(compareStrings).at(-1) as string, counts: { usageFiles: previous?.usage.length ?? 0 } } : {}),
    };
  };
  if (!selected) return keep(notSelected(ctx, 'smogon'));
  if (!deps) {
    issues.push(warn('smogon', 'no dex to resolve usage ids against; last-good usage kept'));
    return keep(failed(ctx, 'smogon', 'no dex available', previous !== null));
  }

  try {
    const months = parseMonths(await ctx.http.text(STATS_ROOT, { fixture: 'smogon/index', ttlHours: 6 }));
    const month = months.at(-1);
    if (!month) throw new Error('the stats index lists no months');
    const prevMonth = previous?.usage.map((u) => u.month).sort(compareStrings).at(-1);
    if (prevMonth && month < prevMonth) {
      const msg = `newest Smogon month ${month} is older than the last-good ${prevMonth}`;
      issues.push(warn('smogon', `${msg}; last-good usage kept`));
      return keep(failed(ctx, 'smogon', msg, true));
    }
    const listing = parseChaosListing(await ctx.http.text(`${STATS_ROOT}${month}/chaos/`, { fixture: `smogon/${month}-chaos-index`, ttlHours: 6 }));
    const targets = chooseTargets(plan, listing);
    if (targets.length === 0) {
      const msg = `${month} has no chaos files for ${candidateRegulations(plan).map((r) => r.formats.doubles).join(' or ')}`;
      issues.push(warn('smogon', previous ? `${msg}; last-good usage kept` : msg));
      return keep(failed(ctx, 'smogon', msg, previous !== null));
    }

    const usage: Usage[] = [];
    const deferred: UsageTarget[] = [];
    const errors: string[] = [];
    const unknown = new Set<string>();
    const started = clock();
    let fetched = 0;
    for (const t of targets) {
      const reuse = previous?.usage.find((u) => sameFile(u, t) && u.month === month && u.regulation === t.regulation);
      if (reuse) {
        usage.push(reuse);
        continue;
      }
      if (clock() - started >= budgetMs) {
        deferred.push(t);
        continue;
      }
      try {
        const raw = await ctx.http.json(`${STATS_ROOT}${month}/chaos/${t.format}-${t.cutoff}.json`, {
          timeoutMs: CHAOS_TIMEOUT_MS,
          spacingMs: SMOGON_SPACING_MS,
          ttlHours: 24 * 7,
          fixture: `smogon/${month}-${t.format}-${t.cutoff}`,
        });
        const chaos = ChaosSchema.parse(raw);
        if (chaos.info.metagame !== t.format) throw new Error(`${t.format}-${t.cutoff}.json describes ${chaos.info.metagame}`);
        const r = chaosToUsage(chaos, { ...t, month, ...deps });
        for (const name of r.unknown) unknown.add(name);
        usage.push(r.usage);
        fetched++;
      } catch (err) {
        errors.push(`${t.format}-${t.cutoff}: ${errorMessage(err)}`);
        deferred.push(t);
      }
    }
    if (usage.length === 0) throw new Error(errors[0] ?? 'no usage file could be read');
    // Targets not done yet keep their last-good file (older month) until a later run gets them.
    for (const t of deferred) {
      const old = previous?.usage.find((u) => sameFile(u, t) && u.regulation === t.regulation);
      if (old) usage.push(old);
    }
    if (deferred.length > 0) {
      const what = deferred.map((t) => `${t.format}-${t.cutoff}`).join(', ');
      issues.push(warn('smogon', `${monthLabel(month)}: ${deferred.length} file(s) not fetched yet (${what}); ${errors.length > 0 ? `errors: ${errors.slice(0, 3).join('; ')}` : 'download budget spent'}; the next run continues`));
    }
    if (unknown.size > 0) issues.push(warn('smogon', `species not in the dex, dropped from usage: ${[...unknown].sort(compareStrings).slice(0, 12).join(', ')}`));
    usage.sort((a, b) => compareStrings(usageFile(a.format, a.cutoff), usageFile(b.format, b.cutoff)));
    const files = outputs(usage);
    const problems = invalid(files, 'smogon');
    if (problems.length > 0) throw new Error(problems.slice(0, 3).map((p) => p.message).join('; '));
    ctx.log(fetched > 0 ? `smogon: ${monthLabel(month)}: fetched ${fetched} of ${targets.length} chaos files in ${((clock() - started) / 1000).toFixed(0)} s` : `smogon: ${month} unchanged; re-emitting ${usage.length} usage files`);
    const primary = primaryUsage(usage, targets) as Usage;
    return {
      status: ok(ctx, 'smogon', describeUsage(usage)),
      files,
      issues,
      usage,
      index: indexOf(usage),
      regulation: primary.regulation,
      month: primary.month,
      counts: { usageFiles: usage.length },
    };
  } catch (err) {
    const msg = `usage fetch failed: ${errorMessage(err)}`;
    issues.push(warn('smogon', previous ? `${msg}; last-good usage kept` : msg));
    return keep(failed(ctx, 'smogon', msg, previous !== null));
  }
}
