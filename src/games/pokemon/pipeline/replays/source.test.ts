import { describe, expect, it } from 'vitest';
import { H2HSchema, ReplayLedgerSchema, type H2H, type ReplayLedger, type Species } from '../../schema.ts';
import { dexIndex } from '../ids.ts';
import { regulationPlan } from '../regulations.ts';
import { fakeContext, fakeHttp, WITH_NEXT } from '../test-support.ts';
import { decodeGames, encodeLedger, LEDGER_FILE } from './ledger.ts';
import { MAX_LOGS, REPLAY_API, REPLAY_SPACING_MS, runReplaySource, searchNewReplays } from './source.ts';

const NOW = new Date('2026-10-09T01:30:00Z');
const FORMAT = 'gen9championsvgc2026regmcbo3';
const POOL = ['incineroar', 'rillaboom', 'sneasler', 'kingambit', 'pelipper', 'archaludon', 'farigiraf', 'gholdengo'];
const species: Species[] = POOL.map((id, i) => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  num: i + 1,
  types: ['Normal'],
  base: { hp: 1, atk: 1, def: 1, spa: 1, spd: 1, spe: 1 },
  abilities: ['x'],
  weightkg: 1,
  legal: ['M-C'],
}));
const dex = dexIndex(species, []);
const plan = regulationPlan(WITH_NEXT, NOW);

/** A minimal finished Bo3 log between two named players. */
function log(seed: number, winner: 1 | 2): string {
  const a = POOL.slice(seed % 3, (seed % 3) + 6);
  const b = [...POOL].reverse().slice(seed % 2, (seed % 2) + 6);
  const name = (n: string): string => n[0]!.toUpperCase() + n.slice(1);
  return [
    `|player|p1|Real Name ${seed}|1|1500`,
    `|player|p2|Other Person ${seed}|2|1490`,
    '|c|Real Name|good luck',
    ...a.map((s) => `|poke|p1|${name(s)}, L50|`),
    ...b.map((s) => `|poke|p2|${name(s)}, L50|`),
    ...a.slice(0, 4).map((s, i) => `|switch|p1${i % 2 ? 'b' : 'a'}: ${name(s)}|${name(s)}, L50|100/100`),
    ...b.slice(0, 4).map((s, i) => `|switch|p2${i % 2 ? 'b' : 'a'}: ${name(s)}|${name(s)}, L50|100/100`),
    `|win|${winner === 1 ? `Real Name ${seed}` : `Other Person ${seed}`}`,
  ].join('\n');
}

const searchRow = (n: number, t: number, extra: object = {}) => ({ uploadtime: t, id: `${FORMAT}-${n}`, format: '[Gen 9 Champions] VGC 2026 Reg M-C (Bo3)', players: [`Real Name ${n}`, `Other Person ${n}`], rating: 1500, private: 0, password: null, ...extra });

describe('searchNewReplays', () => {
  it('walks pages newest first down to the cursor, public replays only, within the budget', async () => {
    const page1 = Array.from({ length: 51 }, (_, i) => searchRow(200 - i, 2000 - i, i === 1 ? { private: 1 } : i === 2 ? { password: 'x' } : {}));
    const page2 = [searchRow(149, 1949), searchRow(148, 1948), searchRow(10, 1000)];
    const http = fakeHttp({
      [`${REPLAY_API}/search.json?format=${FORMAT}`]: page1,
      [`${REPLAY_API}/search.json?format=${FORMAT}&before=1951`]: page2,
    });
    const ctx = fakeContext({ http, now: NOW });
    const rows = await searchNewReplays(ctx, FORMAT, 1500, 100);
    // 50 of page 1 (the 51st only signals more), minus one private and one with a password, then page 2 down to the cursor.
    expect(rows).toHaveLength(48 + 2);
    expect(rows.some((r) => r.id.endsWith('-199') || r.id.endsWith('-198'))).toBe(false);
    expect(rows.at(-1)?.uploadtime).toBe(1948);
    expect(http.inits.every((i) => i?.spacingMs === REPLAY_SPACING_MS)).toBe(true);

    const capped = await searchNewReplays(fakeContext({ http, now: NOW }), FORMAT, 0, 5);
    expect(capped).toHaveLength(5);
    expect(MAX_LOGS).toBeLessThanOrEqual(500);
  });
});

describe('runReplaySource', () => {
  const rows = [searchRow(3, 1791508000), searchRow(2, 1791507000), searchRow(1, 1791506000)];
  const routes = {
    [`${REPLAY_API}/search.json?format=${FORMAT}`]: rows,
    [`${REPLAY_API}/${FORMAT}-3.log`]: log(3, 1),
    [`${REPLAY_API}/${FORMAT}-2.log`]: log(2, 2),
    [`${REPLAY_API}/${FORMAT}-1.log`]: '|player|p1|X|1|\n|player|p2|Y|1|\n|poke|p1|Incineroar, L50|',
  };

  it('parses new replays into an anonymous ledger and h2h.json', async () => {
    const http = fakeHttp(routes);
    const r = await runReplaySource(fakeContext({ http, now: NOW }), plan, dex, true);
    expect(r.status).toMatchObject({ id: 'showdown-replays', status: 'ok' });
    expect(r.files.map((f) => f.path)).toEqual(['h2h.json', LEDGER_FILE]);
    const ledger = r.files[1]?.data as ReplayLedger;
    expect(ReplayLedgerSchema.safeParse(ledger).success).toBe(true);
    expect(H2HSchema.safeParse(r.files[0]?.data).success).toBe(true);
    expect(ledger.games).toHaveLength(2);
    expect(ledger.cursor).toBe(1791508000);
    expect(r.counts).toMatchObject({ replays: 2 });
    expect(r.status.detail).toMatch(/^2 gen9championsvgc2026regmcbo3 games from 2026-10-09 to 2026-10-09; \d+ counter and \d+ synergy edges/);
    expect(r.issues).toEqual([expect.objectContaining({ level: 'warn', message: expect.stringMatching(/skipped 1 of 3 new replays \(1 no-result\)/) })]);
    const everything = JSON.stringify(r.files.map((f) => f.data));
    expect(everything).not.toMatch(/Real Name|Other Person|good luck|gen9championsvgc2026regmcbo3-\d|1500|1490/);
  });

  it('only reads replays newer than the cursor and merges them into the window', async () => {
    const old = encodeLedger({ regulation: 'M-C', format: FORMAT, cursor: 1791507000 }, [
      { date: '2026-10-01', winner: 1, sides: [{ team: ['incineroar'], brought: ['incineroar'] }, { team: ['rillaboom'], brought: ['rillaboom'] }] },
      { date: '2026-08-01', winner: 1, sides: [{ team: ['incineroar'], brought: ['incineroar'] }, { team: ['rillaboom'], brought: ['rillaboom'] }] },
    ]);
    const http = fakeHttp(routes);
    const r = await runReplaySource(fakeContext({ http, now: NOW, previous: { [LEDGER_FILE]: old } }), plan, dex, true);
    expect(http.calls.filter((c) => c.endsWith('.log'))).toEqual([`text ${REPLAY_API}/${FORMAT}-3.log`]);
    const ledger = r.files[1]?.data as ReplayLedger;
    expect(decodeGames(ledger).map((g) => g.date)).toEqual(['2026-10-01', '2026-10-09']);
    expect(ledger.cursor).toBe(1791508000);
    expect((r.files[0]?.data as H2H).window).toEqual({ label: 'Last 30 days', from: '2026-10-01', to: '2026-10-09' });
  });

  it('starts a new ledger when the regulation changes', async () => {
    const after = regulationPlan(WITH_NEXT, new Date('2026-12-03T00:00:00Z'));
    const http = fakeHttp({ [`${REPLAY_API}/search.json?format=gen9championsvgc2027regmdbo3`]: [searchRow(9, 1796000000)], [`${REPLAY_API}/${FORMAT}-9.log`]: log(9, 1) });
    http.calls.length = 0;
    const r = await runReplaySource(fakeContext({ http, now: new Date('2026-12-03T00:00:00Z') }), after, dex, true);
    // The search answered with an M-C row id, but the ledger is keyed by the M-D format now.
    expect((r.files[1]?.data as ReplayLedger | undefined)?.regulation).toBe('M-D');
  });

  it('keeps last-good data and reports failed when the crawl breaks', async () => {
    const prevH2H = (await runReplaySource(fakeContext({ http: fakeHttp(routes), now: NOW }), plan, dex, true)).files;
    const previous = Object.fromEntries(prevH2H.map((f) => [f.path, f.data]));
    const down = fakeHttp({ [REPLAY_API]: new Error('GET -> 502') });
    const r = await runReplaySource(fakeContext({ http: down, now: NOW, previous }), plan, dex, true);
    expect(r.status.status).toBe('failed');
    expect(r.files.map((f) => f.path)).toEqual(['h2h.json', LEDGER_FILE]);
    expect(r.issues[0]).toMatchObject({ level: 'warn', message: expect.stringMatching(/502.*last-good/) });

    const allLogsFail = fakeHttp({ [`${REPLAY_API}/search.json?format=${FORMAT}`]: rows, [`${REPLAY_API}/${FORMAT}-`]: new Error('GET -> 500') });
    const r2 = await runReplaySource(fakeContext({ http: allLogsFail, now: NOW }), plan, dex, true);
    expect(r2.status).toMatchObject({ status: 'failed', detail: expect.stringMatching(/all 3 replay logs failed/) });
  });
});
