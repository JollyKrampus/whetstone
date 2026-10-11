/**
 * Test helpers for the draft modules: load the committed fixture shard (and, for stats mode,
 * merge a stats block built from the synthetic private fixture). Node-only; used by *.test.ts.
 */
import { readFileSync } from 'node:fs';
import type { DraftContext, Provider, Signal } from '../../../core/draft.ts';
import { decodeShard, type DraftData } from './data.ts';
import { statsBlockFromWindow } from './statsblock.ts';
import type { DraftShard, Stats } from '../schema.ts';

const root = new URL('../../../../', import.meta.url);

export function fixtureJson<T>(rel: string): T {
  return JSON.parse(readFileSync(new URL(rel, root), 'utf8')) as T;
}

export function fixtureShard(): DraftShard {
  return fixtureJson<DraftShard>('fixtures/hots/public/draft.json');
}

/** The fixture shard, theory only (no match statistics). */
export function theoryData(): DraftData {
  return decodeShard(fixtureShard());
}

/** The fixture shard plus a stats block from fixtures/hots/_private/stats.json. */
export function statsData(mode: 'sl' | 'aram' = 'sl'): DraftData {
  const shard = fixtureShard();
  const stats = fixtureJson<Stats>('fixtures/hots/_private/stats.json');
  const window = stats.modes[mode]?.current;
  if (!window) throw new Error(`fixture stats lack mode ${mode}`);
  return decodeShard({ ...shard, stats: statsBlockFromWindow(window, shard, { mode, timeframe: 'current', synthetic: true }) });
}

/** Entity id by display name (fixture names are unique). */
export function idOf(data: DraftData, name: string): string {
  const h = data.heroes.find((x) => x.name === name);
  if (!h) throw new Error(`no hero named ${name}`);
  return h.id;
}

/** A scoring context with neutral defaults (team A picking, five picks left each). */
export function ctxOf(partial: Partial<DraftContext>): DraftContext {
  return { team: 'A', action: 'pick', allies: [], enemies: [], bans: [], picksLeft: 5, enemyPicksLeft: 5, ...partial };
}

/** Every signal the providers return for one candidate, flattened. */
export function signalsOf(list: readonly Provider[], candidate: string, c: DraftContext): Signal[] {
  return list.flatMap((p) => {
    const out = p(candidate, c);
    return out ? (Array.isArray(out) ? out : [out]) : [];
  }) as Signal[];
}
