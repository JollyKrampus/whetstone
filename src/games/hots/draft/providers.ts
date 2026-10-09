/**
 * Draft signal providers for Heroes of the Storm (SPEC §7, docs/METHODOLOGY.md §10).
 *
 * Every provider scores one candidate in one DraftContext and returns signals on the shared
 * scale (1.0 ≈ a 4 pp edge) with a reason each. Statistics (the Heroes Profile block merged into
 * the draft shard) are used per pair/hero/map when they pass the "hidden" gate (n ≥ 15); theory
 * edges fill the gaps and are always labelled as theory. Where both exist, statistics drive the
 * counters/synergy/map keys and theory adds a separate, lower-weighted `theory` signal.
 *
 * Perspective: `ctx.team` is the side the candidate would join. Ban steps are scored through
 * `asOpponent` (how good would this hero be for them?), so the same providers explain threats:
 * "Beats your Muradin". `ourTeam` says which side is the visitor's, for "your"/"their" wording.
 */
import type { DraftContext, Provider, Signal, Team } from '../../../core/draft.ts';
import { valueFromDelta, valueFromScore } from '../../../core/draft.ts';
import { pct } from '../../../core/format.ts';
import type { Reason } from '../../../core/game.ts';
import { GATES } from '../../../core/stats.ts';
import {
  statHero,
  statMap,
  statPair,
  theoryCounter,
  theoryMapFit,
  theorySynergy,
  type DraftData,
  type DraftHero,
} from './data.ts';
import { mentions } from '../pool.ts';
import { SL_ROLES, roleVerdicts, type RoleConfig } from './roles.ts';

export const HP_SOURCE = 'heroesprofile';

/** Theory counter edges at or above this score count as "hard counters" for blind-pick safety. */
export const STRONG_THEORY_SCORE = 70;

/** Tier midpoints in pp above/below 50 % (bands of core/tiers.ts HOTS_TIERS). */
const TIER_MID_PP: Readonly<Record<number, number>> = { 1: 3, 2: 1.75, 3: 0, 4: -1.75, 5: -3 };

export interface ProviderOptions {
  data: DraftData;
  /** The visitor's side (default 'A'). */
  ourTeam?: Team;
  /** Use the shard's statistics block (default: whenever it exists). */
  useStats?: boolean;
  roles?: RoleConfig;
  /** Entity ids, slugs or member ids the visitor marked as favourites. */
  favorites?: ReadonlySet<string>;
  /** Heroes our side may pick (pool filter), for "counters heroes you can still pick" on bans. */
  ourPool?: ReadonlySet<string> | null;
  /** Score blind-pick safety on picks (default true; ARAM has no draft to answer you). */
  blindSafety?: boolean;
}

type Whose = 'your' | 'their';

interface Env {
  data: DraftData;
  ourTeam: Team;
  stats: boolean;
  roles: RoleConfig;
  favorites: ReadonlySet<string>;
  ourPool: ReadonlySet<string> | null;
  meanBan: number;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

function thin(n: number): string {
  return n < GATES.greyBelow ? ' (thin data)' : '';
}

function statReason(text: string, n: number, delta: number): Reason {
  return { kind: 'stat', text: `${text}${thin(n)}`, n, delta: round1(delta), source: HP_SOURCE };
}

const theoryReasons = (texts: readonly string[]): Reason[] => texts.map((text) => ({ kind: 'theory', text }));

/** "your"/"their" for the candidate's teammates (ctx.allies) and opponents (ctx.enemies). */
const alliesOf = (ctx: DraftContext, env: Env): Whose => (ctx.team === env.ourTeam ? 'your' : 'their');
const enemiesOf = (ctx: DraftContext, env: Env): Whose => (ctx.team === env.ourTeam ? 'their' : 'your');
const sideName = (w: Whose): string => (w === 'your' ? 'you' : 'the enemy');

const availableCache = new WeakMap<DraftContext, Map<DraftData, DraftHero[]>>();

/** Heroes nobody has picked or banned yet, in shard order. Cached per context. */
export function availableHeroes(data: DraftData, ctx: DraftContext): DraftHero[] {
  let byData = availableCache.get(ctx);
  if (!byData) availableCache.set(ctx, (byData = new Map()));
  const hit = byData.get(data);
  if (hit) return hit;
  const taken = new Set([...ctx.allies, ...ctx.enemies, ...ctx.bans]);
  const list = data.heroes.filter((h) => !taken.has(h.id));
  byData.set(data, list);
  return list;
}

function heroes(data: DraftData, ids: readonly string[]): DraftHero[] {
  return ids.map((id) => data.byId.get(id)).filter((h): h is DraftHero => h !== undefined);
}

/** Is `a` a hard counter to `b`? Stats decide when the pair has data, theory otherwise. */
export function hardCounter(data: DraftData, useStats: boolean, a: DraftHero, b: DraftHero): 'stat' | 'theory' | null {
  if (useStats) {
    const st = statPair(data, 'counters', a.index, b.index);
    if (st) return st.n >= GATES.listMinN && st.delta >= GATES.listMinDeltaPp ? 'stat' : null;
  }
  const t = theoryCounter(data, a.index, b.index);
  return t && t.score >= STRONG_THEORY_SCORE ? 'theory' : null;
}

function names(list: readonly DraftHero[], max = 3): string {
  const shown = list.slice(0, max).map((h) => h.name);
  const more = list.length - shown.length;
  return more > 0 ? `${shown.join(', ')} +${more}` : shown.join(', ');
}

// ---- individual providers ----------------------------------------------------------------------

function winrate(env: Env): Provider {
  return (id) => {
    if (!env.stats) return null;
    const h = env.data.byId.get(id);
    const s = h && statHero(env.data, h.index);
    if (!s) return null;
    const delta = (s.shrunk - 0.5) * 100;
    return { key: 'winrate', value: valueFromDelta(delta), reasons: [statReason(`${pct(s.shrunk)} win rate this patch`, s.games, delta)] };
  };
}

function tier(env: Env): Provider {
  return (id, ctx) => {
    if (!env.stats) return null;
    const h = env.data.byId.get(id);
    const s = h && statHero(env.data, h.index);
    if (!s) return null;
    const out: Signal[] = [];
    if (s.tier !== null) {
      const mid = TIER_MID_PP[s.tier] ?? 0;
      out.push({
        key: 'tier',
        value: valueFromDelta(mid),
        reasons: [{ kind: 'stat', text: `Tier ${s.tier} this patch${thin(s.games)}`, n: s.games, source: HP_SOURCE }],
      });
    }
    // Bans: how often the field bans it is a direct read of perceived threat.
    if (ctx.action === 'ban' && env.meanBan > 0) {
      out.push({
        key: 'tier',
        value: (s.ban - env.meanBan) * 3,
        reasons: [{ kind: 'stat', text: `Banned in ${pct(s.ban)} of games this patch`, n: s.games, source: HP_SOURCE }],
      });
    }
    return out;
  };
}

function counters(env: Env): Provider {
  return (id, ctx) => {
    const c = env.data.byId.get(id);
    if (!c) return null;
    const whose = enemiesOf(ctx, env);
    const out: Signal[] = [];
    for (const e of heroes(env.data, ctx.enemies)) {
      const st = env.stats ? statPair(env.data, 'counters', c.index, e.index) : null;
      const theoryKey = st ? 'theory' : 'counters';
      if (st) {
        const text = st.delta >= 0 ? `Beats ${whose} ${e.name}` : `Struggles against ${whose} ${e.name}`;
        out.push({ key: 'counters', value: valueFromDelta(st.delta), reasons: [statReason(text, st.n, st.delta)] });
      }
      const fwd = theoryCounter(env.data, c.index, e.index);
      if (fwd) out.push({ key: theoryKey, value: valueFromScore(fwd.score), reasons: theoryReasons(fwd.reasons) });
      const rev = theoryCounter(env.data, e.index, c.index);
      if (rev) out.push({ key: theoryKey, value: -valueFromScore(rev.score), reasons: theoryReasons(rev.reasons) });
    }
    return out;
  };
}

function synergy(env: Env): Provider {
  return (id, ctx) => {
    const c = env.data.byId.get(id);
    if (!c) return null;
    const whose = alliesOf(ctx, env);
    const out: Signal[] = [];
    for (const a of heroes(env.data, ctx.allies)) {
      const st = env.stats ? statPair(env.data, 'synergies', c.index, a.index) : null;
      if (st) {
        const text = st.delta >= 0 ? `Works well with ${whose} ${a.name}` : `Awkward next to ${whose} ${a.name}`;
        out.push({ key: 'synergy', value: valueFromDelta(st.delta), reasons: [statReason(text, st.n, st.delta)] });
      }
      const t = theorySynergy(env.data, c.index, a.index);
      if (t) out.push({ key: st ? 'theory' : 'synergy', value: valueFromScore(t.score), reasons: theoryReasons(t.reasons) });
    }
    return out;
  };
}

function mapFit(env: Env): Provider {
  return (id, ctx) => {
    if (!ctx.map) return null;
    const c = env.data.byId.get(id);
    const m = env.data.mapById.get(ctx.map);
    if (!c || !m) return null;
    const out: Signal[] = [];
    const st = env.stats ? statMap(env.data, c.index, m.index) : null;
    if (st) {
      const text = st.delta >= 0 ? `Does well on ${m.name}` : `Weaker on ${m.name}`;
      out.push({ key: 'map', value: valueFromDelta(st.delta), reasons: [statReason(text, st.n, st.delta)] });
    }
    const t = theoryMapFit(env.data, c.index, m.index);
    if (t) out.push({ key: st ? 'theory' : 'map', value: valueFromScore(t.score), reasons: theoryReasons(t.reasons) });
    return out;
  };
}

function roles(env: Env): Provider {
  return (id, ctx) => {
    const c = env.data.byId.get(id);
    if (!c) return null;
    // On ban steps ctx is the opponent's view: their needs make a hero more (or less) of a threat.
    const team = heroes(env.data, ctx.allies);
    const verdicts = roleVerdicts(c, team, availableHeroes(env.data, ctx), ctx.picksLeft, env.roles, alliesOf(ctx, env));
    // A ban removes one of many heroes that could fill a role, so only the penalties carry over:
    // a hero they would not pick (second tank, impossible comp) is less of a threat.
    return (ctx.action === 'ban' ? verdicts.filter((v) => v.value < 0) : verdicts).map((v) => ({ key: 'role' as const, value: v.value, reasons: v.reasons }));
  };
}

function pool(env: Env): Provider {
  return (id, ctx) => {
    if (ctx.team !== env.ourTeam || ctx.action !== 'pick' || env.favorites.size === 0) return null;
    const c = env.data.byId.get(id);
    if (!c || !mentions(env.favorites, c)) return null;
    return { key: 'pool', value: 0.25, reasons: [{ kind: 'curated', text: 'One of your favourites' }] };
  };
}

/** Blind-pick safety: fewer hard counters still available to the other side is safer. */
function safety(env: Env): Provider {
  return (id, ctx) => {
    if (ctx.action !== 'pick' || ctx.enemyPicksLeft <= 0) return null;
    const c = env.data.byId.get(id);
    if (!c) return null;
    const pool = availableHeroes(env.data, ctx).filter((h) => h.id !== id);
    if (pool.length === 0) return null;
    const found: DraftHero[] = [];
    let anyStat = false;
    for (const e of pool) {
      const how = hardCounter(env.data, env.stats, e, c);
      if (how) {
        found.push(e);
        if (how === 'stat') anyStat = true;
      }
    }
    const factor = Math.min(1, ctx.enemyPicksLeft / 5);
    const other = sideName(enemiesOf(ctx, env));
    const kind = anyStat || (env.stats && found.length === 0) ? 'stat' : 'theory';
    if (found.length === 0) {
      const reason: Reason = { kind, text: `Safe blind pick: no hard counters left for ${other}` };
      if (kind === 'stat') reason.source = HP_SOURCE;
      return { key: 'counters', value: 0.1 * factor, reasons: [reason] };
    }
    const count = found.length;
    const reason: Reason = { kind, text: `${count} hero${count === 1 ? '' : 'es'} ${other} can still pick counter it: ${names(found)}` };
    if (kind === 'stat') reason.source = HP_SOURCE;
    return { key: 'counters', value: -0.12 * Math.min(count, 5) * factor, reasons: [reason] };
  };
}

/** Ban breadth: how many heroes the banning side could still pick does this one counter? */
function breadth(env: Env): Provider {
  return (id, ctx) => {
    if (ctx.action !== 'ban' || ctx.enemyPicksLeft <= 0) return null;
    const c = env.data.byId.get(id);
    if (!c) return null;
    const victims = enemiesOf(ctx, env);
    const restrict = victims === 'your' ? env.ourPool : null;
    const found: DraftHero[] = [];
    let anyStat = false;
    for (const u of availableHeroes(env.data, ctx)) {
      if (u.id === id || (restrict && !restrict.has(u.id))) continue;
      const how = hardCounter(env.data, env.stats, c, u);
      if (how) {
        found.push(u);
        if (how === 'stat') anyStat = true;
      }
    }
    if (found.length === 0) return null;
    const factor = Math.min(1, ctx.enemyPicksLeft / 5);
    const count = found.length;
    const reason: Reason = {
      kind: anyStat ? 'stat' : 'theory',
      text: `Counters ${count} hero${count === 1 ? '' : 'es'} ${sideName(victims)} can still pick: ${names(found)}`,
    };
    if (anyStat) reason.source = HP_SOURCE;
    return { key: 'counters', value: 0.06 * Math.min(count, 6) * factor, reasons: [reason] };
  };
}

// ---- assembly ----------------------------------------------------------------------------------

function envOf(opts: ProviderOptions): Env {
  const stats = opts.useStats ?? opts.data.stats !== null;
  let meanBan = 0;
  if (stats && opts.data.stats) {
    const rows = opts.data.heroes.map((h) => statHero(opts.data, h.index)).filter((s) => s !== null);
    meanBan = rows.length ? rows.reduce((sum, s) => sum + s.ban, 0) / rows.length : 0;
  }
  return {
    data: opts.data,
    ourTeam: opts.ourTeam ?? 'A',
    stats: stats && opts.data.stats !== null,
    roles: opts.roles ?? SL_ROLES,
    favorites: opts.favorites ?? new Set(),
    ourPool: opts.ourPool ?? null,
    meanBan,
  };
}

/** Providers for pick steps (the candidate joins ctx.team). */
export function pickProviders(opts: ProviderOptions): Provider[] {
  const env = envOf(opts);
  const list = [winrate(env), tier(env), counters(env), synergy(env), mapFit(env), roles(env), pool(env)];
  if (opts.blindSafety !== false) list.push(safety(env));
  return list;
}

/**
 * Providers for ban steps. Call scoreCandidates with `asOpponent(ctx)`: each candidate is scored
 * as the opponent's pick (meta, counters to our picks, synergy with theirs, map, their role
 * needs) plus how many of our remaining options it counters and how often the field bans it.
 */
export function banProviders(opts: ProviderOptions): Provider[] {
  const env = envOf(opts);
  return [winrate(env), tier(env), counters(env), synergy(env), mapFit(env), roles(env), breadth(env)];
}
