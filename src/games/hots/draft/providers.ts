/**
 * Draft signal providers for Heroes of the Storm (SPEC §7, docs/METHODOLOGY.md §10).
 *
 * Every provider scores one candidate in one DraftContext and returns signals on the shared
 * scale (1.0 ≈ a 4 pp edge) with a reason each. Match statistics (the class-B block merged into
 * the draft shard, when a licensed source provides one) are used per pair/hero/map when they
 * pass the "hidden" gate (n ≥ 15); theory edges fill the gaps and are always labelled as theory.
 * Where both exist, statistics drive the counters/synergy/map keys and theory adds a separate,
 * lower-weighted `theory` signal.
 *
 * Perspective: `ctx.team` is the side the candidate would join. Ban steps are scored through
 * `asOpponent` (how good would this hero be for them?), so the same providers explain threats:
 * "Beats your Muradin". `ourTeam` says which side is the visitor's, for "your"/"their" wording.
 *
 * Scale control: one signal per enemy or ally edge keeps every reason, but four or five strong
 * edges used to add up to 2–3 and drown the role guardrails late in the draft. Each provider's
 * signals of one key are therefore soft-capped together (KEY_CAP · tanh(sum / KEY_CAP), spread
 * over the signals in proportion), so one more edge always helps a little and never swamps the
 * composition rules.
 */
import type { DraftContext, Provider, Signal, SignalKey, Team } from '../../../core/draft.ts';
import { valueFromDelta, valueFromScore } from '../../../core/draft.ts';
import { int, pct, pp } from '../../../core/format.ts';
import type { Reason } from '../../../core/game.ts';
import { GATES, isListable } from '../../../core/stats.ts';
import {
  statHero,
  statMap,
  statPair,
  theoryCounter,
  theoryMapFit,
  theorySynergy,
  type DraftData,
  type DraftHero,
  type TheoryLink,
} from './data.ts';
import { mentions } from '../pool.ts';
import { SL_ROLES, roleVerdicts, type RoleConfig } from './roles.ts';

/** Theory counter edges at or above this score count as "hard counters" for blind-pick safety. */
export const STRONG_THEORY_SCORE = 70;

/** Soft cap per provider and key (see the module comment): about a 4 pp edge at most (1.0 on the signal scale). */
export const KEY_CAP = 1.0;

/**
 * Ban breadth: BREADTH_MAX · (1 − e^(−S / BREADTH_SCALE)), where S sums the strength of every
 * hard counter the hero has among the heroes the other side can still pick. Smooth and never
 * flat, so a hero that counters 26 heroes outranks one that counters 6.
 */
export const BREADTH_MAX = 0.45;
export const BREADTH_SCALE = 12;

/** Pro ban rates are shrunk toward the mean with this many pseudo-maps. */
export const PRO_PRIOR_MAPS = 20;

/** Tier midpoints in pp above/below 50 % (bands of core/tiers.ts HOTS_TIERS). */
const TIER_MID_PP: Readonly<Record<number, number>> = { 1: 3, 2: 1.75, 3: 0, 4: -1.75, 5: -3 };

/**
 * A reason with draft-only display hints, read by suggest.ts when it picks what to show.
 * Plain `Reason` objects carry them as optional extra fields.
 */
export interface DraftReason extends Reason {
  /**
   * Reasons with the same key say the same thing (one rule's line for another enemy, one
   * template): the strongest is shown, the rest stay in the breakdown.
   */
  dedupeKey?: string;
  /** Breakdown only: a further line of an edge whose first line already explains it, or a statistic below the list bar. */
  detail?: boolean;
}

/** A signal that can also order exact ties (higher first), e.g. uncapped ban breadth. */
export interface DraftSignal extends Signal {
  tiebreak?: number;
}

/**
 * Pro-play ban prior for theory mode (class A-SA, Liquipedia via pro.json): how often pros ban
 * each hero. Built at build time and handed to the island; credited inline wherever it is used.
 */
export interface ProPrior {
  /** SourceRef id of the data (its credit is shown next to the suggestions). */
  source: string;
  /** Window label, e.g. "2026 tournaments". */
  label: string;
  /** Drafted maps in the window. */
  maps: number;
  /** Entity id → bans in the window (missing = 0). */
  bans: Readonly<Record<string, number>>;
  /** Fixture sample numbers, not real tournament data. */
  synthetic?: boolean;
}

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
  /** Pro ban rates for ban steps when no match statistics are in use. */
  pro?: ProPrior | null;
}

type Whose = 'your' | 'their';

interface Env {
  data: DraftData;
  ourTeam: Team;
  stats: boolean;
  /** SourceRef id of the statistics, for reason labels and credits. */
  statsSource: string | undefined;
  roles: RoleConfig;
  favorites: ReadonlySet<string>;
  ourPool: ReadonlySet<string> | null;
  meanBan: number;
  pro: (ProPrior & { meanBan: number }) | null;
}

const round1 = (x: number): number => Math.round(x * 10) / 10;

function thin(n: number): string {
  return n < GATES.greyBelow ? ' (thin data)' : '';
}

function statReason(env: Env, text: string, n: number, delta: number, detail = false): DraftReason {
  const r: DraftReason = { kind: 'stat', text: `${text}${thin(n)}`, n, delta: round1(delta) };
  if (env.statsSource) r.source = env.statsSource;
  if (detail) r.detail = true;
  return r;
}

/**
 * A statistic worded by the SPEC §6 list gate: a verdict ("Beats your Muradin") only when the
 * pair would be listed on a hero page (n ≥ 50 and |Δ| ≥ 1.5 pp); otherwise neutral text kept
 * for the breakdown. The value stays proportional either way.
 */
function gatedStat(env: Env, n: number, delta: number, verdict: () => string, neutral: string): DraftReason {
  return isListable(n, delta) ? statReason(env, verdict(), n, delta) : statReason(env, `${pp(delta)} ${neutral}: too small to call`, n, delta, true);
}

/**
 * Dedupe key of a theory line: its template with the bracketed evidence dropped, so one rule
 * matched through different abilities ("{a}'s stun (Impale) holds targets still for {b}'s
 * burst", "{a}'s stun (Hammer of Justice) …") counts as the same reason.
 */
export function templateKey(template: string): string {
  return `theory:${template.replace(/\s*\([^)]*\)/g, '')}`;
}

/** Reasons of a theory edge: its first line is the headline, later lines (paraphrases, extra rules) are breakdown detail. */
export function theoryReasons(link: TheoryLink): DraftReason[] {
  return link.lines.map((line, i) => {
    const r: DraftReason = { kind: 'theory', text: line.text, dedupeKey: templateKey(line.template) };
    if (line.conditions.length > 0) r.conditions = [...line.conditions];
    if (i > 0) r.detail = true;
    return r;
  });
}

/** Soft-caps the sum of each key at ±cap (see the module comment), scaling its signals alike. */
export function softCap<S extends Signal>(signals: readonly S[], cap = KEY_CAP): S[] {
  const sums = new Map<SignalKey, number>();
  for (const s of signals) sums.set(s.key, (sums.get(s.key) ?? 0) + s.value);
  return signals.map((s) => {
    const sum = sums.get(s.key) ?? 0;
    if (Math.abs(sum) < 1e-9) return s;
    const scale = (cap * Math.tanh(sum / cap)) / sum;
    return scale === 1 ? s : { ...s, value: s.value * scale };
  });
}

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

/**
 * How hard `a` counters `b`, or null when it is not a hard counter. Statistics decide when the
 * pair has data (a listable edge: n ≥ 50 and Δ ≥ 1.5 pp), theory otherwise (score ≥ 70).
 * Strength is on the signal scale: Δ / 4 pp, or the theory score through the ring inverse.
 */
export function counterStrength(data: DraftData, useStats: boolean, a: DraftHero, b: DraftHero): { how: 'stat' | 'theory'; strength: number } | null {
  if (useStats) {
    const st = statPair(data, 'counters', a.index, b.index);
    if (st) return st.n >= GATES.listMinN && st.delta >= GATES.listMinDeltaPp ? { how: 'stat', strength: valueFromDelta(st.delta) } : null;
  }
  const t = theoryCounter(data, a.index, b.index);
  return t && t.score >= STRONG_THEORY_SCORE ? { how: 'theory', strength: valueFromScore(t.score) } : null;
}

/** Is `a` a hard counter to `b`? Stats decide when the pair has data, theory otherwise. */
export function hardCounter(data: DraftData, useStats: boolean, a: DraftHero, b: DraftHero): 'stat' | 'theory' | null {
  return counterStrength(data, useStats, a, b)?.how ?? null;
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
    return { key: 'winrate', value: valueFromDelta(delta), reasons: [statReason(env, `${pct(s.shrunk)} win rate this patch`, s.games, delta)] };
  };
}

function tier(env: Env): Provider {
  return (id, ctx) => {
    if (!env.stats) return null;
    const h = env.data.byId.get(id);
    const s = h && statHero(env.data, h.index);
    if (!s) return null;
    const out: Signal[] = [];
    const meta = (text: string): Reason => {
      const r: Reason = { kind: 'stat', text, n: s.games };
      if (env.statsSource) r.source = env.statsSource;
      return r;
    };
    if (s.tier !== null) {
      const mid = TIER_MID_PP[s.tier] ?? 0;
      out.push({ key: 'tier', value: valueFromDelta(mid), reasons: [meta(`Tier ${s.tier} this patch${thin(s.games)}`)] });
    }
    // Bans: how often the field bans it is a direct read of perceived threat.
    if (ctx.action === 'ban' && env.meanBan > 0) {
      out.push({ key: 'tier', value: (s.ban - env.meanBan) * 3, reasons: [meta(`Banned in ${pct(s.ban)} of games this patch`)] });
    }
    return out;
  };
}

/**
 * Theory-mode ban prior: how often pros ban the hero (shrunk toward the mean ban rate with
 * PRO_PRIOR_MAPS pseudo-maps), on the same scale as the statistics ban signal.
 */
function proBans(env: Env): Provider {
  return (id, ctx) => {
    const pro = env.pro;
    if (ctx.action !== 'ban' || env.stats || !pro || pro.maps <= 0) return null;
    const bans = pro.bans[id] ?? 0;
    const shrunk = (bans + pro.meanBan * PRO_PRIOR_MAPS) / (pro.maps + PRO_PRIOR_MAPS);
    const reason: Reason = {
      kind: 'pro',
      text: `Banned in ${pct(bans / pro.maps, 0)} of ${int(pro.maps)} pro maps${pro.synthetic ? ' (sample data)' : ''}`,
      n: pro.maps,
      source: pro.source,
    };
    return { key: 'tier', value: (shrunk - pro.meanBan) * 3, reasons: [reason] };
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
        const reason = gatedStat(env, st.n, st.delta, () => (st.delta >= 0 ? `Beats ${whose} ${e.name}` : `Struggles against ${whose} ${e.name}`), `against ${whose} ${e.name}`);
        out.push({ key: 'counters', value: valueFromDelta(st.delta), reasons: [reason] });
      }
      const fwd = theoryCounter(env.data, c.index, e.index);
      if (fwd) out.push({ key: theoryKey, value: valueFromScore(fwd.score), reasons: theoryReasons(fwd) });
      const rev = theoryCounter(env.data, e.index, c.index);
      if (rev) out.push({ key: theoryKey, value: -valueFromScore(rev.score), reasons: theoryReasons(rev) });
    }
    return softCap(out);
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
        const reason = gatedStat(env, st.n, st.delta, () => (st.delta >= 0 ? `Works well with ${whose} ${a.name}` : `Awkward next to ${whose} ${a.name}`), `next to ${whose} ${a.name}`);
        out.push({ key: 'synergy', value: valueFromDelta(st.delta), reasons: [reason] });
      }
      const t = theorySynergy(env.data, c.index, a.index);
      if (t) out.push({ key: st ? 'theory' : 'synergy', value: valueFromScore(t.score), reasons: theoryReasons(t) });
    }
    return softCap(out);
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
      const reason = gatedStat(env, st.n, st.delta, () => (st.delta >= 0 ? `Does well on ${m.name}` : `Weaker on ${m.name}`), `on ${m.name}`);
      out.push({ key: 'map', value: valueFromDelta(st.delta), reasons: [reason] });
    }
    const t = theoryMapFit(env.data, c.index, m.index);
    if (t) out.push({ key: st ? 'theory' : 'map', value: valueFromScore(t.score), reasons: theoryReasons(t) });
    return softCap(out);
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
    const withSource = (r: Reason): Reason => (kind === 'stat' && env.statsSource ? { ...r, source: env.statsSource } : r);
    if (found.length === 0) {
      return { key: 'counters', value: 0.1 * factor, reasons: [withSource({ kind, text: `Safe blind pick: no hard counters left for ${other}` })] };
    }
    const count = found.length;
    const reason = withSource({ kind, text: `${count} hero${count === 1 ? '' : 'es'} ${other} can still pick counter it: ${names(found)}` });
    return { key: 'counters', value: -0.12 * Math.min(count, 5) * factor, reasons: [reason] };
  };
}

/** Ban breadth: how many (and how hard) heroes the banning side could still pick does this one counter? */
function breadth(env: Env): Provider {
  return (id, ctx) => {
    if (ctx.action !== 'ban' || ctx.enemyPicksLeft <= 0) return null;
    const c = env.data.byId.get(id);
    if (!c) return null;
    const victims = enemiesOf(ctx, env);
    const restrict = victims === 'your' ? env.ourPool : null;
    const found: { hero: DraftHero; strength: number }[] = [];
    let anyStat = false;
    for (const u of availableHeroes(env.data, ctx)) {
      if (u.id === id || (restrict && !restrict.has(u.id))) continue;
      const hit = counterStrength(env.data, env.stats, c, u);
      if (hit) {
        found.push({ hero: u, strength: hit.strength });
        if (hit.how === 'stat') anyStat = true;
      }
    }
    if (found.length === 0) return null;
    const total = found.reduce((s, f) => s + f.strength, 0);
    const factor = Math.min(1, ctx.enemyPicksLeft / 5);
    const count = found.length;
    // Name the hardest-countered heroes first.
    const shown = [...found].sort((x, y) => y.strength - x.strength || x.hero.index - y.hero.index).map((f) => f.hero);
    const reason: Reason = {
      kind: anyStat ? 'stat' : 'theory',
      text: `Counters ${count} hero${count === 1 ? '' : 'es'} ${sideName(victims)} can still pick: ${names(shown)}`,
    };
    if (anyStat && env.statsSource) reason.source = env.statsSource;
    const signal: DraftSignal = { key: 'counters', value: BREADTH_MAX * (1 - Math.exp(-total / BREADTH_SCALE)) * factor, reasons: [reason], tiebreak: total };
    return signal;
  };
}

// ---- assembly ----------------------------------------------------------------------------------

function envOf(opts: ProviderOptions): Env {
  const stats = (opts.useStats ?? opts.data.stats !== null) && opts.data.stats !== null;
  let meanBan = 0;
  if (stats && opts.data.stats) {
    const rows = opts.data.heroes.map((h) => statHero(opts.data, h.index)).filter((s) => s !== null);
    meanBan = rows.length ? rows.reduce((sum, s) => sum + s.ban, 0) / rows.length : 0;
  }
  let pro: Env['pro'] = null;
  if (opts.pro && opts.pro.maps > 0 && opts.data.heroes.length > 0) {
    const total = opts.data.heroes.reduce((sum, h) => sum + (opts.pro!.bans[h.id] ?? 0), 0);
    pro = { ...opts.pro, meanBan: total / opts.pro.maps / opts.data.heroes.length };
  }
  return {
    data: opts.data,
    ourTeam: opts.ourTeam ?? 'A',
    stats,
    statsSource: opts.data.statsSource ?? undefined,
    roles: opts.roles ?? SL_ROLES,
    favorites: opts.favorites ?? new Set(),
    ourPool: opts.ourPool ?? null,
    meanBan,
    pro,
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
 * needs) plus how many of our remaining options it counters and how often it is banned (the
 * field's ban rate with statistics, the pro ban rate without).
 */
export function banProviders(opts: ProviderOptions): Provider[] {
  const env = envOf(opts);
  return [winrate(env), tier(env), proBans(env), counters(env), synergy(env), mapFit(env), roles(env), breadth(env)];
}
