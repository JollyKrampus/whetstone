/**
 * Limitless standings → anonymous teams → tournaments.json aggregates. Pure.
 *
 * Privacy: `anonymise` is the ingest boundary. It keeps placing, match record and the six
 * sets, and drops everything that identifies a player (name, handle, country, drop round,
 * deck ids). Nothing downstream ever sees a name.
 *
 * Usage ids follow Smogon: a Pokémon holding its own Mega Stone counts as the Mega. Win rates
 * are match-weighted (wins / (wins + losses), ties excluded) with a Wilson lower bound.
 */
import { z } from 'zod';
import type { Tournaments } from '../../schema.ts';
import { NATURES, type Nature } from '../../schema.ts';
import { wilsonLower } from '../../../../core/stats.ts';
import { compareStrings } from '../../../../../pipeline/hash.ts';
import { toId, type DexIndex } from '../ids.ts';

/** Placings up to this count as a top cut. */
export const TOP_CUT = 8;
export const MAX_TOP_TEAMS = 64;
export const MAX_ARCHETYPES = 12;

const Rec = z.looseObject({ wins: z.number().int().nonnegative(), losses: z.number().int().nonnegative(), ties: z.number().int().nonnegative() });
const DeckMon = z.looseObject({
  id: z.string().nullish(),
  name: z.string().nullish(),
  item: z.string().nullish(),
  ability: z.string().nullish(),
  attacks: z.array(z.string()).nullish(),
  nature: z.string().nullish(),
});
/** One standings row as Limitless returns it (only the fields we read are checked). */
export const StandingSchema = z.looseObject({ placing: z.number().int().positive().nullish(), record: Rec.nullish(), decklist: z.array(DeckMon).nullish() });
export const StandingsSchema = z.array(StandingSchema);

export const TournamentListSchema = z.array(
  z.looseObject({ id: z.string().min(1), name: z.string().min(1), date: z.string().min(1), format: z.string().nullish(), players: z.number().int().nonnegative() }),
);
export type TournamentListing = z.infer<typeof TournamentListSchema>[number];

export interface AnonMember {
  species: string;
  item?: string;
  ability?: string;
  moves: string[];
  nature?: Nature;
}
export interface AnonTeam {
  placing: number | null;
  record: { wins: number; losses: number; ties: number };
  members: AnonMember[];
}
export interface TournamentTeams {
  ref: Tournaments['tournaments'][number];
  teams: AnonTeam[];
}

export interface KnownIds {
  dex: DexIndex;
  moves: ReadonlySet<string>;
  items: ReadonlySet<string>;
  abilities: ReadonlySet<string>;
}

const NATURE_BY_ID = new Map(NATURES.map((n) => [n.toLowerCase(), n]));

/** The ingest boundary: standings rows → teams with no player data. Unknown ids are dropped. */
export function anonymise(rows: unknown, known: KnownIds): { teams: AnonTeam[]; unknownSpecies: string[] } {
  const parsed = StandingsSchema.parse(rows);
  const unknownSpecies: string[] = [];
  const teams: AnonTeam[] = [];
  for (const row of parsed) {
    const members: AnonMember[] = [];
    for (const mon of row.decklist ?? []) {
      const species = known.dex.species(mon.id ?? '') ?? known.dex.species(mon.name ?? '');
      if (!species) {
        unknownSpecies.push(String(mon.id ?? mon.name ?? '?'));
        continue;
      }
      const m: AnonMember = { species, moves: [] };
      const item = toId(mon.item);
      if (known.items.has(item)) m.item = item;
      const ability = toId(mon.ability);
      if (known.abilities.has(ability)) m.ability = ability;
      m.moves = [...new Set((mon.attacks ?? []).map(toId).filter((x) => known.moves.has(x)))].slice(0, 4);
      const nature = NATURE_BY_ID.get(toId(mon.nature));
      if (nature) m.nature = nature;
      if (!members.some((x) => x.species === species)) members.push(m);
    }
    if (members.length === 0 || !row.record) continue;
    teams.push({ placing: row.placing ?? null, record: { wins: row.record.wins, losses: row.record.losses, ties: row.record.ties }, members: members.slice(0, 6) });
  }
  return { teams, unknownSpecies };
}

interface Tally {
  teams: number;
  wins: number;
  losses: number;
  ties: number;
  topCut: number;
}
const tally = (): Tally => ({ teams: 0, wins: 0, losses: 0, ties: 0, topCut: 0 });
const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

function wrOf(t: Tally): { wr: number | null; wrLower: number | null } {
  const games = t.wins + t.losses;
  return games > 0 ? { wr: round4(t.wins / games), wrLower: round4(wilsonLower(t.wins, games)) } : { wr: null, wrLower: null };
}

export interface AggregateOptions {
  regulation: string;
  format: string;
  window: { label: string; from: string; to: string };
  dex: DexIndex;
}

export function aggregate(events: readonly TournamentTeams[], o: AggregateOptions): Tournaments {
  const species = new Map<string, Tally>();
  const pairs = new Map<string, Tally>();
  let teamCount = 0;
  for (const e of events) {
    for (const team of e.teams) {
      teamCount++;
      const ids = [...new Set(team.members.map((m) => o.dex.usageId(m.species, m.item)))].sort(compareStrings);
      const top = team.placing !== null && team.placing <= TOP_CUT;
      const add = (t: Tally): void => {
        t.teams++;
        t.wins += team.record.wins;
        t.losses += team.record.losses;
        t.ties += team.record.ties;
        if (top) t.topCut++;
      };
      for (const id of ids) {
        if (!species.has(id)) species.set(id, tally());
        add(species.get(id) as Tally);
      }
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const key = `${ids[i]}|${ids[j]}`;
          if (!pairs.has(key)) pairs.set(key, tally());
          add(pairs.get(key) as Tally);
        }
      }
    }
  }
  const share = (n: number): number => (teamCount > 0 ? round4(n / teamCount) : 0);
  const speciesOut = [...species]
    .map(([id, t]) => ({ id, teams: t.teams, share: share(t.teams), wins: t.wins, losses: t.losses, ties: t.ties, ...wrOf(t), topCut: t.topCut }))
    .sort((a, b) => b.teams - a.teams || compareStrings(a.id, b.id));
  const minPairTeams = Math.max(5, Math.ceil(teamCount * 0.04));
  const archetypes = [...pairs]
    .filter(([, t]) => t.teams >= minPairTeams)
    .sort((a, b) => b[1].teams - a[1].teams || compareStrings(a[0], b[0]))
    .slice(0, MAX_ARCHETYPES)
    .map(([key, t]) => {
      const core = key.split('|');
      return {
        id: core.join('-'),
        label: core.map((c) => o.dex.name(c)).join(' + '),
        core,
        teams: t.teams,
        share: share(t.teams),
        wins: t.wins,
        losses: t.losses,
        ties: t.ties,
        wr: wrOf(t).wr,
      };
    });
  const ordered = [...events].sort((a, b) => compareStrings(b.ref.date, a.ref.date) || compareStrings(a.ref.id, b.ref.id));
  const teams: Tournaments['teams'] = [];
  for (const e of ordered) {
    for (const team of [...e.teams].filter((t) => t.placing !== null && t.placing <= TOP_CUT).sort((a, b) => (a.placing as number) - (b.placing as number))) {
      if (teams.length >= MAX_TOP_TEAMS) break;
      teams.push({ tournamentId: e.ref.id, placing: team.placing as number, record: team.record, members: team.members.map((m) => ({ ...m })) });
    }
  }
  const tournaments = ordered.map((e) => e.ref);
  return {
    source: 'limitless',
    attribution: { source: 'limitless', text: 'Tournament data: Limitless (play.limitlesstcg.com); player names removed', url: 'https://play.limitlesstcg.com/' },
    regulation: o.regulation,
    format: o.format,
    window: o.window,
    totals: { tournaments: tournaments.length, players: tournaments.reduce((a, t) => a + t.players, 0), teams: teamCount },
    tournaments,
    species: speciesOut,
    archetypes,
    teams,
  };
}
