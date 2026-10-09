/**
 * Build the draft shard's `stats` block (DraftStatsBlockSchema) from one Heroes Profile stats
 * window (stats.json, class B). This is the shape `pipeline/stage.ts` overlays onto the public
 * shard; the draft tests use it to run the tool on the synthetic fixture stats.
 *
 * Dense matrices are row-major over the shard's hero order: entry [i·H + j] is "i vs j"
 * (counters) or "i with j" (synergies, mirrored). Pairs below the hide gate stay null.
 */
import { GATES } from '../../../core/stats.ts';
import type { DraftShard, DraftStatsBlock, GameMode, StatsWindow, Timeframe } from '../schema.ts';

export interface StatsBlockOptions {
  mode: GameMode;
  timeframe: Timeframe;
  synthetic?: boolean;
}

export function statsBlockFromWindow(window: StatsWindow, shard: Pick<DraftShard, 'heroes' | 'maps'>, opts: StatsBlockOptions): DraftStatsBlock {
  const ids = shard.heroes.id;
  const H = ids.length;
  const M = shard.maps.id.length;
  const heroIndex = new Map(ids.map((id, i) => [id, i]));
  const mapIndex = new Map(shard.maps.id.map((id, i) => [id, i]));

  const hero = {
    games: ids.map((id) => window.heroes[id]?.games ?? 0),
    shrunk: ids.map((id) => window.heroes[id]?.shrunk ?? 0.5),
    pick: ids.map((id) => window.heroes[id]?.pick ?? 0),
    ban: ids.map((id) => window.heroes[id]?.ban ?? 0),
    tier: ids.map((id) => window.heroes[id]?.tier ?? null),
  };

  const dense = () => ({
    score: new Array<number | null>(H * H).fill(null),
    delta: new Array<number | null>(H * H).fill(null),
    n: new Array<number>(H * H).fill(0),
  });
  const counters = dense();
  const synergies = dense();
  const put = (m: ReturnType<typeof dense>, a: number, b: number, e: { score: number; delta?: number; n?: number }) => {
    const k = a * H + b;
    m.score[k] = e.score;
    m.delta[k] = e.delta ?? 0;
    m.n[k] = e.n ?? 0;
  };
  for (const e of window.counters) {
    const a = heroIndex.get(e.a);
    const b = heroIndex.get(e.b);
    if (a !== undefined && b !== undefined) put(counters, a, b, e);
  }
  for (const e of window.synergies) {
    const a = heroIndex.get(e.a);
    const b = heroIndex.get(e.b);
    if (a === undefined || b === undefined) continue;
    put(synergies, a, b, e);
    put(synergies, b, a, e);
  }

  const maps = { delta: new Array<number | null>(H * M).fill(null), n: new Array<number>(H * M).fill(0) };
  for (const [heroId, perMap] of Object.entries(window.maps)) {
    const i = heroIndex.get(heroId);
    if (i === undefined) continue;
    for (const [mapId, s] of Object.entries(perMap)) {
      const j = mapIndex.get(mapId);
      if (j === undefined) continue;
      maps.delta[i * M + j] = s.games >= GATES.hideBelow ? s.delta : null;
      maps.n[i * M + j] = s.games;
    }
  }

  return {
    ...(opts.synthetic ? { synthetic: true as const } : {}),
    source: 'heroesprofile',
    mode: opts.mode,
    timeframe: opts.timeframe,
    label: window.label,
    games: window.games,
    hero,
    counters,
    synergies,
    maps,
  };
}
