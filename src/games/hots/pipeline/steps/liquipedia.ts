/**
 * liquipedia step (class A-SA): pro picks/bans/presence from tournament wikitext (pro.json),
 * and which heroes have a Liquipedia page (for links.json). MediaWiki API only, 2 s apart,
 * custom User-Agent (see sources/liquipedia.ts).
 *
 * Incremental: with last-good data fetched less than RC_MAX_DAYS ago, one `recentchanges` call
 * decides whether anything changed. No main-namespace edits since the last fetch ⇒ last-good
 * pro.json and page checks are reused (1 call). Otherwise tournaments are searched and their
 * wikitext fetched in batches of 50 (about 4 calls), and only heroes that are new or whose page
 * title changed are re-checked. Every FULL_REFRESH_DAY (UTC) everything is refetched, which
 * bounds what a truncated change list or a parser update can leave stale.
 *
 * Liquipedia data is never merged into class-A files: links.json carries only the existence of
 * a page (a URL), not its content.
 */
import type { Link } from '../../schema.ts';
import { LinksSchema, ProSchema, type Pro } from '../../schema.ts';
import { createLiquipediaClient, existingPages, fetchPages, recentChanges, searchTournaments } from '../sources/liquipedia.ts';
import type { HeroInput } from '../transform/heroes.ts';
import { COMPOSITES } from '../transform/heroes.ts';
import { liquipediaTitles } from '../transform/links.ts';
import { aggregatePro, buildEntityIndex, inheritFromParents, parseTournament, type ParsedTournament } from '../transform/pro.ts';
import { compareStrings, warn } from '../util.ts';
import { hoursSince } from './builds.ts';
import { lastFetchedAt, previousFile, selected, setFallback, setNotSelected, setOk, type RunEnv } from './common.ts';

/** MediaWiki keeps 30 days of recent changes by default; stay well inside that. */
const RC_MAX_DAYS = 7;
/** Weekly full refresh on this UTC weekday (1 = Monday). */
export const FULL_REFRESH_DAY = 1;
/** With fewer drafted maps than this in the current year, the window also covers last year. */
const MIN_MAPS_FOR_YEAR = 50;

export interface LiquipediaResult {
  pro: Pro | null;
  /** Hero id → existing Liquipedia page title. */
  heroPages: Map<string, string>;
}

/** Hero id → Liquipedia title from a last-good links.json. */
export function pagesFromLinks(links: { heroes: Record<string, readonly Link[]> } | null): Map<string, string> {
  const out = new Map<string, string>();
  for (const [id, list] of Object.entries(links?.heroes ?? {})) {
    const lp = list.find((l) => l.site === 'liquipedia');
    const m = lp ? /^https:\/\/liquipedia\.net\/heroes\/(.+)$/.exec(lp.url) : null;
    if (m?.[1]) out.set(id, decodeURI(m[1]));
  }
  return out;
}

/** Year window: the current year, extended back a year while the current one is thin. */
export function proWindow(today: string, mapsThisYear: number): { label: string; from: string; to: string; years: number[] } {
  const year = Number(today.slice(0, 4));
  if (mapsThisYear >= MIN_MAPS_FOR_YEAR) return { label: `${year} tournaments`, from: `${year}-01-01`, to: `${year}-12-31`, years: [year] };
  return { label: `${year - 1}–${year} tournaments`, from: `${year - 1}-01-01`, to: `${year}-12-31`, years: [year - 1, year] };
}

function memberTitles(heroes: readonly HeroInput[]): Map<string, string[]> {
  const composite = new Map<string, string>();
  for (const c of COMPOSITES) for (const m of c.members) composite.set(m, c.name);
  const out = new Map<string, string[]>();
  for (const h of heroes) if (!h.members) out.set(h.id, liquipediaTitles(h, composite.get(h.id)));
  return out;
}

export async function runLiquipedia(env: RunEnv, heroes: readonly HeroInput[]): Promise<LiquipediaResult> {
  const { ctx } = env;
  const prevPro = await previousFile(env, 'pro.json', ProSchema);
  const prevLinks = await previousFile(env, 'links.json', LinksSchema);
  const prevPages = pagesFromLinks(prevLinks);
  const checkedBefore = new Set(Object.keys(prevLinks?.heroes ?? {}));
  if (!selected(env, 'liquipedia')) {
    setNotSelected(env, 'liquipedia');
    return { pro: prevPro, heroPages: prevPages };
  }

  const lp = createLiquipediaClient(ctx.http, ctx.secrets.LIQUIPEDIA_UA_CONTACT);
  const titlesByHero = memberTitles(heroes);
  try {
    const since = lastFetchedAt(env, 'liquipedia');
    let changed: Set<string> | null = null;
    const weekly = env.now.getUTCDay() === FULL_REFRESH_DAY;
    if (since && prevPro && prevLinks && !weekly && hoursSince(since, env.nowIso) < RC_MAX_DAYS * 24) {
      changed = new Set((await recentChanges(lp, since)).map((t) => t.replace(/ /g, '_')));
    }

    // Hero pages: check new heroes and heroes whose candidate titles changed.
    const toCheck = [...titlesByHero]
      .filter(([id, titles]) => changed === null || !checkedBefore.has(id) || titles.some((t) => changed.has(t)))
      .sort(([a], [b]) => compareStrings(a, b));
    const heroPages = new Map([...prevPages].filter(([id]) => titlesByHero.has(id)));
    if (toCheck.length > 0) {
      const titles = [...new Set(toCheck.flatMap(([, t]) => t))].sort(compareStrings);
      const exists = await existingPages(lp, titles);
      for (const [id, candidates] of toCheck) {
        const hit = candidates.map((t) => exists.get(t)).find((x): x is string => Boolean(x));
        if (hit) heroPages.set(id, hit.replace(/ /g, '_'));
        else heroPages.delete(id);
      }
    }

    if (changed !== null && changed.size === 0 && prevPro) {
      setOk(env, 'liquipedia', 'no wiki changes since the last fetch');
      return { pro: prevPro, heroPages };
    }

    const entityIndex = buildEntityIndex(heroes);
    const parseAll = async (years: readonly number[]): Promise<ParsedTournament[]> => {
      const titles = new Set<string>();
      for (const y of years) for (const t of await searchTournaments(lp, y)) titles.add(t);
      const pages = await fetchPages(lp, [...titles].sort(compareStrings), `revisions-${years.join('-')}`);
      return inheritFromParents(pages.map(parseTournament).filter((t) => t !== null));
    };
    const year = Number(env.today.slice(0, 4));
    let tournaments = await parseAll([year]);
    const thisYearMaps = tournaments.filter((t) => t.startDate.startsWith(String(year))).reduce((s, t) => s + t.maps.length, 0);
    let window = proWindow(env.today, thisYearMaps);
    if (window.years.length > 1) {
      tournaments = [...tournaments, ...(await parseAll([year - 1]))];
      window = proWindow(env.today, thisYearMaps);
    }
    const unique = [...new Map(tournaments.map((t) => [t.id, t])).values()];
    const { pro, issues } = aggregatePro(unique, { entityIndex, from: window.from, to: window.to, label: window.label });
    env.issues.push(...issues);
    if (pro.totals.maps === 0) env.issues.push(warn(`liquipedia: no drafted maps found for ${window.label}`, 'liquipedia'));
    setOk(env, 'liquipedia', `${pro.totals.tournaments} tournaments, ${pro.totals.maps} drafted maps`);
    return { pro, heroPages };
  } catch (err) {
    setFallback(env, 'liquipedia', err, prevPro !== null, 'pro.json');
    return { pro: prevPro, heroPages: prevPages };
  }
}
