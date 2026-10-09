/**
 * Source `smogon`: monthly chaos JSON for the regulation's VGC doubles, Bo3 and Battle Stadium
 * Singles formats at cutoffs 0 / 1500 / 1760 → usage/<format>-<cutoff>.json + usage/index.json.
 *
 * Month rollover: the stats index lists one folder per month (published around the 1st). A run
 * downloads only when the newest month (or the set of files it offers) differs from the
 * last-good usage index; otherwise it re-emits the last-good files. A new regulation has no
 * Smogon month for up to ~4 weeks: meanwhile the previous regulation's newest files are used
 * and the regulation is reported as warming up.
 */
import type { PipelineContext, ValidationIssue } from '../../../../core/game.ts';
import { compareStrings } from '../../../../../pipeline/hash.ts';
import { UsageIndexSchema, UsageSchema, usageFile, type Cutoff, type Regulation, type Usage, type UsageIndex } from '../../schema.ts';
import { errorMessage, failed, invalid, json, notSelected, ok, previousFile, warn, type SourceOutcome } from '../common.ts';
import type { DexIndex } from '../ids.ts';
import { candidateRegulations, type RegulationPlan } from '../regulations.ts';
import { ChaosSchema, chaosToUsage, monthLabel } from './chaos.ts';

export const STATS_ROOT = 'https://www.smogon.com/stats/';
export const CUTOFFS: readonly Cutoff[] = [0, 1500, 1760];
/** Chaos files run to ~16 MB decoded; Smogon's server can be slow. */
const CHAOS_TIMEOUT_MS = 300_000;
const SMOGON_SPACING_MS = 1_000;

export interface UsageOutcome extends SourceOutcome {
  usage: Usage[];
  index: UsageIndex;
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

export function formatsOf(reg: Regulation): string[] {
  return [reg.formats.doubles, reg.formats.doublesBo3, reg.formats.singles];
}

/**
 * Files to fetch from a month: the current regulation's when the month has its doubles
 * format, otherwise the previous regulation's (warming up).
 */
export function chooseTargets(plan: RegulationPlan, listing: ReadonlySet<string>): UsageTarget[] {
  for (const reg of candidateRegulations(plan)) {
    if (!listing.has(`${reg.formats.doubles}-${CUTOFFS[CUTOFFS.length - 1]}.json`) && !listing.has(`${reg.formats.doubles}-0.json`)) continue;
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

function outputs(usage: readonly Usage[]) {
  return [json('usage/index.json', indexOf(usage)), ...usage.map((u) => json(usageFile(u.format, u.cutoff), u))];
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
  return { index: indexOf(usage), usage };
}

export interface UsageDeps {
  dex: DexIndex;
  moves: ReadonlySet<string>;
  items: ReadonlySet<string>;
  abilities: ReadonlySet<string>;
}

export async function runSmogonSource(ctx: PipelineContext, plan: RegulationPlan, deps: UsageDeps | null, selected: boolean): Promise<UsageOutcome> {
  const previous = await previousUsage(ctx);
  const issues: ValidationIssue[] = [];
  const keep = (status: UsageOutcome['status']): UsageOutcome => ({
    status,
    files: previous ? outputs(previous.usage) : [],
    issues,
    usage: previous?.usage ?? [],
    index: previous?.index ?? [],
    ...(previous?.usage[0] ? { regulation: previous.usage[0].regulation, month: previous.usage[0].month } : {}),
  });
  if (!selected) return keep(notSelected(ctx, 'smogon'));
  if (!deps) {
    issues.push(warn('smogon', 'no dex to resolve usage ids against; last-good usage kept'));
    return keep(failed(ctx, 'smogon', 'no dex available', previous !== null));
  }

  try {
    const months = parseMonths(await ctx.http.text(STATS_ROOT, { fixture: 'smogon/index', ttlHours: 6 }));
    const month = months.at(-1);
    if (!month) throw new Error('the stats index lists no months');
    const prevMonth = previous?.usage[0]?.month;
    if (prevMonth && month < prevMonth) {
      issues.push(warn('smogon', `newest Smogon month ${month} is older than the last-good ${prevMonth}; kept last-good`));
      return keep(failed(ctx, 'smogon', `month went backwards (${month} < ${prevMonth})`, true));
    }
    const listing = parseChaosListing(await ctx.http.text(`${STATS_ROOT}${month}/chaos/`, { fixture: `smogon/${month}-chaos-index`, ttlHours: 6 }));
    const targets = chooseTargets(plan, listing);
    if (targets.length === 0) {
      const msg = `${month} has no chaos files for ${candidateRegulations(plan).map((r) => r.formats.doubles).join(' or ')}`;
      issues.push(warn('smogon', previous ? `${msg}; last-good usage kept` : msg));
      return keep(failed(ctx, 'smogon', msg, previous !== null));
    }
    const same =
      previous !== null &&
      previous.usage.length === targets.length &&
      targets.every((t) => previous.usage.some((u) => u.month === month && u.format === t.format && u.cutoff === t.cutoff && u.regulation === t.regulation));
    if (same) {
      const out = keep(ok(ctx, 'smogon', `${monthLabel(month)} unchanged (${targets.length} files)`));
      return out;
    }

    const usage: Usage[] = [];
    const unknown = new Set<string>();
    for (const t of targets) {
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
    }
    usage.sort((a, b) => compareStrings(usageFile(a.format, a.cutoff), usageFile(b.format, b.cutoff)));
    if (unknown.size > 0) issues.push(warn('smogon', `species not in the dex, dropped from usage: ${[...unknown].sort(compareStrings).slice(0, 12).join(', ')}`));
    const files = outputs(usage);
    const problems = invalid(files, 'smogon');
    if (problems.length > 0) throw new Error(problems.slice(0, 3).map((p) => p.message).join('; '));
    const regulation = targets[0]?.regulation as string;
    return {
      status: ok(ctx, 'smogon', `${monthLabel(month)}: ${usage.length} files (${[...new Set(targets.map((t) => t.format))].join(', ')} at ${CUTOFFS.join('/')})`),
      files,
      issues,
      usage,
      index: indexOf(usage),
      regulation,
      month,
      counts: { usageFiles: usage.length },
    };
  } catch (err) {
    const msg = `usage fetch failed: ${errorMessage(err)}`;
    issues.push(warn('smogon', previous ? `${msg}; last-good usage kept` : msg));
    return keep(failed(ctx, 'smogon', msg, previous !== null));
  }
}
