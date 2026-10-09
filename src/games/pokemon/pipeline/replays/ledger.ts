/**
 * ledger/showdown-replays.json: the rolling, anonymous store of parsed replays (see
 * ReplayLedgerSchema). Games are kept for WINDOW_DAYS and dropped when the regulation or
 * format changes. Pure encode/decode/merge helpers.
 */
import { compareStrings } from '../../../../../pipeline/hash.ts';
import type { ReplayLedger } from '../../schema.ts';
import type { GameSide } from './parse.ts';

export const LEDGER_FILE = 'ledger/showdown-replays.json';
export const LEDGER_WINDOW_DAYS = 30;

export interface LedgerGame {
  date: string;
  winner: 1 | 2;
  sides: [GameSide, GameSide];
}

export function emptyLedger(regulation: string, format: string): ReplayLedger {
  return { schema: 1, source: 'showdown-replays', regulation, format, cursor: 0, species: [], games: [] };
}

export function decodeGames(ledger: ReplayLedger): LedgerGame[] {
  const name = (i: string): string => ledger.species[Number(i)] as string;
  return ledger.games.map((row) => {
    const [date, winner, t1, b1, t2, b2] = row.split(' ') as [string, string, string, string, string, string];
    const side = (t: string, b: string): GameSide => ({ team: t.split(',').map(name), brought: b.split(',').map(name) });
    return { date, winner: winner === '2' ? 2 : 1, sides: [side(t1, b1), side(t2, b2)] };
  });
}

export function encodeLedger(base: Pick<ReplayLedger, 'regulation' | 'format' | 'cursor'>, games: readonly LedgerGame[]): ReplayLedger {
  const species = [...new Set(games.flatMap((g) => g.sides.flatMap((s) => [...s.team, ...s.brought])))].sort(compareStrings);
  const index = new Map(species.map((s, i) => [s, i]));
  const ids = (list: readonly string[]): string => list.map((s) => index.get(s)).join(',');
  // Rows start with the date, so sorting the encoded rows orders by date and then content:
  // the file does not depend on the order replays were fetched in.
  const rows = games.map((g) => `${g.date} ${g.winner} ${ids(g.sides[0].team)} ${ids(g.sides[0].brought)} ${ids(g.sides[1].team)} ${ids(g.sides[1].brought)}`).sort(compareStrings);
  return {
    schema: 1,
    source: 'showdown-replays',
    regulation: base.regulation,
    format: base.format,
    cursor: base.cursor,
    species,
    games: rows,
  };
}

/** Keep games dated within `days` before `today` (inclusive). */
export function pruneGames(games: readonly LedgerGame[], today: string, days = LEDGER_WINDOW_DAYS): LedgerGame[] {
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  return games.filter((g) => g.date >= from && g.date <= today);
}
