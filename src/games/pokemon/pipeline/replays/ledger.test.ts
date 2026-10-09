import { describe, expect, it } from 'vitest';
import { ReplayLedgerSchema } from '../../schema.ts';
import { decodeGames, emptyLedger, encodeLedger, pruneGames, type LedgerGame } from './ledger.ts';

const g = (date: string, winner: 1 | 2, a: string[], b: string[]): LedgerGame => ({
  date,
  winner,
  sides: [
    { team: a, brought: a.slice(0, 4) },
    { team: b, brought: b.slice(0, 4) },
  ],
});

const games: LedgerGame[] = [
  g('2026-10-08', 1, ['rillaboom', 'incineroar', 'sneasler', 'kingambit', 'pelipper', 'archaludon'], ['garchompmegaz', 'farigiraf', 'indeedeef', 'torkoal', 'rillaboom', 'incineroar']),
  g('2026-10-01', 2, ['pelipper', 'archaludon'], ['rillaboom', 'kingambit']),
];

describe('replay ledger', () => {
  it('round-trips games through the compact encoding', () => {
    const ledger = encodeLedger({ regulation: 'M-C', format: 'gen9championsvgc2026regmcbo3', cursor: 1791508164 }, games);
    expect(ReplayLedgerSchema.safeParse(ledger).success).toBe(true);
    expect(ledger.species).toEqual([...ledger.species].sort());
    expect(new Set(ledger.species).size).toBe(ledger.species.length);
    const back = decodeGames(ledger);
    expect(back).toHaveLength(2);
    expect(back).toEqual(expect.arrayContaining(games));
  });

  it('is independent of the order replays were fetched in', () => {
    const a = encodeLedger({ regulation: 'M-C', format: 'f', cursor: 1 }, games);
    const b = encodeLedger({ regulation: 'M-C', format: 'f', cursor: 1 }, [...games].reverse());
    expect(a).toEqual(b);
    expect(a.games[0]?.startsWith('2026-10-01')).toBe(true);
  });

  it('holds no names, ids or ratings', () => {
    const ledger = encodeLedger({ regulation: 'M-C', format: 'gen9championsvgc2026regmcbo3', cursor: 5 }, games);
    expect(Object.keys(ledger).sort()).toEqual(['cursor', 'format', 'games', 'regulation', 'schema', 'source', 'species']);
    for (const row of ledger.games) expect(row).toMatch(/^\d{4}-\d{2}-\d{2} [12]( [\d,]+){4}$/);
  });

  it('rejects out-of-range indexes', () => {
    const bad = { ...emptyLedger('M-C', 'f'), species: ['a'], games: ['2026-10-01 1 0 0 0 1'] };
    expect(ReplayLedgerSchema.safeParse(bad).success).toBe(false);
  });

  it('keeps a rolling window of days ending today', () => {
    const dates = ['2026-09-08', '2026-09-09', '2026-10-08', '2026-10-09'];
    const kept = pruneGames(dates.map((d) => g(d, 1, ['a'], ['b'])), '2026-10-08', 30);
    // 30 days ending 2026-10-08 start on 2026-09-09; a future date (clock skew) is dropped too.
    expect(kept.map((x) => x.date)).toEqual(['2026-09-09', '2026-10-08']);
  });
});
