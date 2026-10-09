/**
 * Source `limitless`: grassroots VGC tournaments from the public play.limitlesstcg.com API (no
 * key needed for tournaments). The API allows 50 requests per 5 minutes, so requests are spaced
 * 6.5 s apart and a run makes at most ~8 list calls plus MAX_TOURNAMENTS standings calls: the
 * largest finished events of the regulation in the last 30 days that published team lists.
 * Standings are anonymised as they arrive (aggregate.ts); raw standings are never stored.
 */
import type { PipelineContext, ValidationIssue } from '../../../../core/game.ts';
import { compareStrings } from '../../../../../pipeline/hash.ts';
import { TournamentsSchema, type Tournaments } from '../../schema.ts';
import { errorMessage, failed, invalid, isoDate, json, notSelected, ok, previousFile, warn, type SourceOutcome } from '../common.ts';
import { candidateRegulations, type RegulationPlan } from '../regulations.ts';
import { aggregate, anonymise, TournamentListSchema, type KnownIds, type TournamentListing, type TournamentTeams } from './aggregate.ts';

export const LIMITLESS_API = 'https://play.limitlesstcg.com/api';
export const LIMITLESS_SPACING_MS = 6_500;
export const WINDOW_DAYS = 30;
export const MAX_TOURNAMENTS = 40;
export const MIN_PLAYERS = 16;
const PAGE_SIZE = 50;
const MAX_PAGES = 8;
/** Events that started less than this long ago may still be running. */
const SETTLE_HOURS = 12;
const DAY_MS = 86_400_000;

export interface TournamentOutcome extends SourceOutcome {
  tournaments: Tournaments | null;
}

/** Largest finished events in the window, biggest first (ties: newest, then id). */
export function selectTournaments(list: readonly TournamentListing[], now: Date, max = MAX_TOURNAMENTS): TournamentListing[] {
  const from = now.getTime() - WINDOW_DAYS * DAY_MS;
  const until = now.getTime() - SETTLE_HOURS * 3_600_000;
  const seen = new Set<string>();
  return list
    .filter((t) => {
      const at = Date.parse(t.date);
      if (seen.has(t.id) || !(at >= from && at <= until) || t.players < MIN_PLAYERS) return false;
      seen.add(t.id);
      return true;
    })
    .sort((a, b) => b.players - a.players || compareStrings(b.date, a.date) || compareStrings(a.id, b.id))
    .slice(0, max);
}

async function listTournaments(ctx: PipelineContext, format: string): Promise<TournamentListing[]> {
  const from = ctx.now.getTime() - WINDOW_DAYS * DAY_MS;
  const out: TournamentListing[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${LIMITLESS_API}/tournaments?game=VGC&format=${encodeURIComponent(format)}&limit=${PAGE_SIZE}&page=${page}`;
    const rows = TournamentListSchema.parse(await ctx.http.json(url, { spacingMs: LIMITLESS_SPACING_MS, ttlHours: 3, fixture: `limitless/tournaments-${format}-p${page}` }));
    out.push(...rows.filter((r) => !r.format || r.format === format));
    const last = rows.at(-1);
    if (rows.length < PAGE_SIZE || !last || Date.parse(last.date) < from) break;
  }
  return out;
}

export async function runLimitlessSource(ctx: PipelineContext, plan: RegulationPlan, known: KnownIds | null, selected: boolean): Promise<TournamentOutcome> {
  const previous = await previousFile(ctx, 'tournaments.json', TournamentsSchema);
  const usable = previous && !previous.synthetic ? previous : null;
  const issues: ValidationIssue[] = [];
  const keep = (status: TournamentOutcome['status']): TournamentOutcome => ({
    status,
    files: usable ? [json('tournaments.json', usable)] : [],
    issues,
    tournaments: usable,
    ...(usable ? { regulation: usable.regulation } : {}),
  });
  if (!selected) return keep(notSelected(ctx, 'limitless'));
  if (!known) {
    issues.push(warn('limitless', 'no dex to resolve team ids against; last-good tournaments kept'));
    return keep(failed(ctx, 'limitless', 'no dex available', usable !== null));
  }

  try {
    for (const reg of candidateRegulations(plan)) {
      const picked = selectTournaments(await listTournaments(ctx, reg.limitlessFormat), ctx.now);
      const events: TournamentTeams[] = [];
      const unknown = new Set<string>();
      const failures: string[] = [];
      for (const t of picked) {
        let anon: ReturnType<typeof anonymise>;
        try {
          const rows = await ctx.http.json(`${LIMITLESS_API}/tournaments/${encodeURIComponent(t.id)}/standings`, {
            spacingMs: LIMITLESS_SPACING_MS,
            ttlHours: 24,
            fixture: `limitless/standings-${t.id}`,
          });
          anon = anonymise(rows, known);
        } catch (err) {
          // One broken event should not cost the other thirty-nine.
          failures.push(`${t.id}: ${errorMessage(err)}`);
          continue;
        }
        const { teams, unknownSpecies } = anon;
        for (const s of unknownSpecies) unknown.add(s);
        if (teams.length === 0) continue;
        events.push({
          ref: { id: t.id, name: t.name, date: isoDate(Date.parse(t.date)), players: t.players, url: `https://play.limitlesstcg.com/tournament/${encodeURIComponent(t.id)}/standings` },
          teams,
        });
      }
      if (failures.length > 0 && failures.length * 2 > picked.length) throw new Error(`${failures.length} of ${picked.length} standings failed: ${failures.slice(0, 2).join('; ')}`);
      if (failures.length > 0) issues.push(warn('limitless', `left out ${failures.length} of ${picked.length} events whose standings failed: ${failures.slice(0, 3).join('; ')}`));
      if (unknown.size > 0) issues.push(warn('limitless', `species not in the dex, left out of team lists: ${[...unknown].sort(compareStrings).slice(0, 10).join(', ')}`));
      if (events.length === 0) {
        ctx.log(`limitless: no ${reg.limitlessFormat} events with team lists in the last ${WINDOW_DAYS} days`);
        continue;
      }
      const data = aggregate(events, {
        regulation: reg.id,
        format: reg.limitlessFormat,
        window: { label: `Last ${WINDOW_DAYS} days`, from: isoDate(ctx.now.getTime() - WINDOW_DAYS * DAY_MS), to: isoDate(ctx.now) },
        dex: known.dex,
      });
      const files = [json('tournaments.json', data)];
      const problems = invalid(files, 'limitless');
      if (problems.length > 0) throw new Error(problems.slice(0, 3).map((p) => p.message).join('; '));
      return {
        status: ok(ctx, 'limitless', `${data.totals.tournaments} ${reg.limitlessFormat} events (largest of the last ${WINDOW_DAYS} days with team lists), ${data.totals.teams} teams`),
        files,
        issues,
        tournaments: data,
        regulation: reg.id,
        counts: { tournaments: data.totals.tournaments, teams: data.totals.teams },
      };
    }
    const msg = `no events with team lists for ${candidateRegulations(plan).map((r) => r.limitlessFormat).join(' or ')} in the last ${WINDOW_DAYS} days`;
    issues.push(warn('limitless', msg));
    return keep(failed(ctx, 'limitless', msg, usable !== null));
  } catch (err) {
    const msg = `tournament fetch failed: ${errorMessage(err)}`;
    issues.push(warn('limitless', usable ? `${msg}; last-good tournaments kept` : msg));
    return keep(failed(ctx, 'limitless', msg, usable !== null));
  }
}
