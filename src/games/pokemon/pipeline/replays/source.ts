/**
 * Source `showdown-replays`: public Bo3 replays of the regulation's VGC format (open team
 * sheets are forced there). Each run walks the replay search API back from the newest upload to
 * the ledger's cursor, fetches at most MAX_LOGS logs at ~1 request per second (critique U14:
 * stay around 500 a day until Showdown staff say otherwise), parses them into anonymous games,
 * appends them to the 30-day ledger and recomputes h2h.json from the whole ledger.
 *
 * Nothing that identifies a player is kept: names only map `|win|` to a side while a log is
 * parsed; replay ids, ratings and upload times stay in memory (the ledger keeps a single
 * upload-time cursor and each game's date).
 */
import { z } from 'zod';
import type { PipelineContext, ValidationIssue } from '../../../../core/game.ts';
import { H2HSchema, ReplayLedgerSchema, type H2H, type ReplayLedger } from '../../schema.ts';
import { errorMessage, failed, invalid, isoDate, json, notSelected, ok, previousFile, warn, type SourceOutcome } from '../common.ts';
import type { DexIndex } from '../ids.ts';
import { candidateRegulations, type RegulationPlan } from '../regulations.ts';
import { h2hFromGames } from './h2h.ts';
import { decodeGames, emptyLedger, encodeLedger, LEDGER_FILE, LEDGER_WINDOW_DAYS, pruneGames, type LedgerGame } from './ledger.ts';
import { scrubReplayLog, scrubReplaySearch } from '../scrub.ts';
import { parseLog, type ParseFailure } from './parse.ts';

export const REPLAY_API = 'https://replay.pokemonshowdown.com';
export const MAX_LOGS = 500;
export const REPLAY_SPACING_MS = 1_000;
const MAX_SEARCH_PAGES = 20;
/**
 * A few unusable logs a day are normal (forfeits at team preview, custom-rule challenges filed
 * under the format with species Champions does not have); more than this share is reported.
 */
export const SKIP_WARN_SHARE = 0.1;
const PAGE = 50;

const SearchRowSchema = z.looseObject({
  id: z.string().regex(/^[a-z0-9-]+$/),
  uploadtime: z.number().int().nonnegative(),
  private: z.union([z.number(), z.boolean()]).nullish(),
  password: z.string().nullish(),
});
const SearchSchema = z.array(SearchRowSchema);
type SearchRow = z.infer<typeof SearchRowSchema>;

/**
 * Status detail of the head-to-head data in effect. It describes the window, not the run, so a
 * run that adds nothing leaves meta.json (and dataHash) alone.
 */
export function describeH2H(h2h: H2H): string {
  return `${h2h.replays} ${h2h.format} games from ${h2h.window.from} to ${h2h.window.to}; ${h2h.counters.length} counter and ${h2h.synergies.length} synergy edges (n ≥ 15)`;
}

export interface H2HOutcome extends SourceOutcome {
  h2h: H2H | null;
}

/** Newest-first replays uploaded after `cursor`, at most `budget`, public ones only. */
export async function searchNewReplays(ctx: PipelineContext, format: string, cursor: number, budget: number): Promise<SearchRow[]> {
  const out: SearchRow[] = [];
  const seen = new Set<string>();
  let before: number | null = null;
  for (let page = 0; page < MAX_SEARCH_PAGES && out.length < budget; page++) {
    const url = `${REPLAY_API}/search.json?format=${encodeURIComponent(format)}${before === null ? '' : `&before=${before}`}`;
    const rows = SearchSchema.parse(await ctx.http.json(url, { spacingMs: REPLAY_SPACING_MS, ttlHours: 1, fixture: `replays/search-${format}${before === null ? '' : `-before-${before}`}`, scrub: scrubReplaySearch }));
    let reachedCursor = false;
    for (const r of rows.slice(0, PAGE)) {
      if (r.uploadtime <= cursor) {
        reachedCursor = true;
        break;
      }
      if (seen.has(r.id) || r.private || r.password) continue;
      seen.add(r.id);
      out.push(r);
      if (out.length >= budget) break;
    }
    // A 51st row means older replays exist.
    const last = rows[PAGE - 1];
    if (reachedCursor || rows.length <= PAGE || !last) break;
    before = last.uploadtime;
  }
  return out;
}

export async function runReplaySource(ctx: PipelineContext, plan: RegulationPlan, dex: DexIndex | null, selected: boolean, maxLogs = MAX_LOGS): Promise<H2HOutcome> {
  const prevLedger = await previousFile(ctx, LEDGER_FILE, ReplayLedgerSchema);
  const prevH2H = await previousFile(ctx, 'h2h.json', H2HSchema);
  const usableH2H = prevH2H && !prevH2H.synthetic ? prevH2H : null;
  const issues: ValidationIssue[] = [];
  const keep = (status: H2HOutcome['status']): H2HOutcome => ({
    status,
    files: [...(usableH2H ? [json('h2h.json', usableH2H)] : []), ...(prevLedger ? [json(LEDGER_FILE, prevLedger)] : [])],
    issues,
    h2h: usableH2H,
    ...(usableH2H ? { regulation: usableH2H.regulation } : {}),
  });
  if (!selected) return keep(notSelected(ctx, 'showdown-replays'));
  if (!dex) {
    issues.push(warn('showdown-replays', 'no dex to resolve species against; last-good head-to-head kept'));
    return keep(failed(ctx, 'showdown-replays', 'no dex available', usableH2H !== null));
  }

  try {
    const today = isoDate(ctx.now);
    for (const reg of candidateRegulations(plan)) {
      const format = reg.formats.doublesBo3;
      const base: ReplayLedger = prevLedger && prevLedger.regulation === reg.id && prevLedger.format === format ? prevLedger : emptyLedger(reg.id, format);
      const rows = await searchNewReplays(ctx, format, base.cursor, maxLogs);
      const kept = pruneGames(decodeGames(base), today);
      if (rows.length === 0 && kept.length === 0) {
        ctx.log(`showdown-replays: no ${format} replays yet`);
        continue;
      }
      const fresh: LedgerGame[] = [];
      const skipped: Record<ParseFailure | 'fetch', number> = { 'no-result': 0, 'no-teams': 0, 'unknown-species': 0, fetch: 0 };
      for (const row of rows) {
        let log: string;
        try {
          log = await ctx.http.text(`${REPLAY_API}/${row.id}.log`, { spacingMs: REPLAY_SPACING_MS, ttlHours: 24 * 7, fixture: `replays/log-${row.id}`, scrub: scrubReplayLog });
        } catch (err) {
          skipped.fetch++;
          ctx.log(`showdown-replays: ${row.id}: ${errorMessage(err)}`);
          continue;
        }
        const game = parseLog(log, dex);
        if (typeof game === 'string') {
          skipped[game]++;
          continue;
        }
        fresh.push({ date: isoDate(row.uploadtime * 1000), winner: game.winner as 1 | 2, sides: game.sides });
      }
      if (rows.length > 0 && skipped.fetch === rows.length) throw new Error(`all ${rows.length} replay logs failed to download`);
      const games = pruneGames([...kept, ...fresh], today);
      const cursor = Math.max(base.cursor, ...rows.map((r) => r.uploadtime));
      const ledger = encodeLedger({ regulation: reg.id, format, cursor }, games);
      const window = { label: `Last ${LEDGER_WINDOW_DAYS} days`, from: games[0]?.date ?? today, to: today };
      const names: Record<string, string> = {};
      for (const g of games) for (const s of g.sides) for (const id of s.brought) names[id] = dex.name(id);
      const h2h = h2hFromGames(
        [...games].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
        { regulation: reg.id, format, window: { ...window, from: games.reduce((m, g) => (g.date < m ? g.date : m), today) }, names },
      );
      const files = [json('h2h.json', h2h), json(LEDGER_FILE, ledger)];
      const problems = invalid(files, 'showdown-replays');
      if (problems.length > 0) throw new Error(problems.slice(0, 3).map((p) => p.message).join('; '));
      ctx.log(`showdown-replays: parsed ${fresh.length} of ${rows.length} new ${format} replays; ${games.length} games in the ${LEDGER_WINDOW_DAYS}-day window`);
      const skippedTotal = Object.values(skipped).reduce((a, b) => a + b, 0);
      if (skippedTotal > 0) {
        const parts = Object.entries(skipped).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`);
        const line = `skipped ${skippedTotal} of ${rows.length} new replays (${parts.join(', ')})`;
        if (skippedTotal > rows.length * SKIP_WARN_SHARE) issues.push(warn('showdown-replays', line));
        else ctx.log(`showdown-replays: ${line}`);
      }
      return {
        status: ok(ctx, 'showdown-replays', describeH2H(h2h)),
        files,
        issues,
        h2h,
        regulation: reg.id,
        counts: { replays: games.length, h2hEdges: h2h.counters.length + h2h.synergies.length },
      };
    }
    const msg = `no replays for ${candidateRegulations(plan).map((r) => r.formats.doublesBo3).join(' or ')}`;
    issues.push(warn('showdown-replays', msg));
    return keep(failed(ctx, 'showdown-replays', msg, usableH2H !== null));
  } catch (err) {
    const msg = `replay crawl failed: ${errorMessage(err)}`;
    issues.push(warn('showdown-replays', usableH2H ? `${msg}; last-good head-to-head kept` : msg));
    return keep(failed(ctx, 'showdown-replays', msg, usableH2H !== null));
  }
}
