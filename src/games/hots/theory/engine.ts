/**
 * Theory engine (SPEC §5.1.6): mechanics + curated YAML → theory.json. Browser-safe and pure:
 * the same heroes, maps and curated bundle always give byte-identical output.
 *
 *   x(a, b) = Σ over matching rules of  weight × factor(a) × factor(b)   (each rule once per pair)
 *           + curated pair weight,                                         clamped to ±2
 *   score   = round(50 + 50 · tanh(x))
 *
 * factor = 1 for a tag the hero always has (a basic ability, its trait, every Heroic choice, a
 * curated trait, a role/type selector) and OPTIONAL_FACTOR (0.6) for a tag it only gets from a
 * talent or from one of several Heroic choices.
 *
 * Counters are directed (a counters b) and emitted for every ordered pair with x ≠ 0.
 * Synergies are symmetric (a rule matches either way round) and stored with a < b.
 * Map fit: per (hero, map), Σ of maps.yaml `fit` rules whose map tag and hero tag both match.
 * Reasons: curated "why" lines first, then rule templates rendered with the evidence names.
 */
import type { Edge, Reason } from '../../../core/game.ts';
import { HERO_TAGS, type GameMap, type Hero, type HeroTag, type Mechanic, type MapFit, type Rule, type RuleAtom, type Theory } from '../schema.ts';
import type { CuratedBundle, MergedPair } from './types.ts';
import { OPTIONAL_FACTOR, theoryScore } from './weights.ts';

/**
 * Version of the extraction + scoring logic. Bump it when extract.ts or engine.ts change what
 * they produce; theory.json `rulesVersion` = `${RULES_VERSION}+<hash of the curated inputs>`.
 */
export const RULES_VERSION = '1.0';

/** Most evidence names quoted in one reason. */
export const MAX_REASON_EVIDENCE = 2;

// ---- labels ----------------------------------------------------------------------------

const TAG_LABEL: Partial<Record<RuleAtom, string>> = {
  'time-stop': 'Time Stop',
  unstoppable: 'Unstoppable',
  invulnerable: 'invulnerability',
  'spell-armor': 'Spell Armor',
  'physical-armor': 'Physical Armor',
  'heal-self': 'self-healing',
  'heal-ally': 'healing',
  'percent-hp-damage': 'percent-Health damage',
  'anti-heal': 'healing reduction',
  'armor-shred': 'Armor reduction',
  burst: 'burst damage',
  'sustained-dps': 'sustained damage',
  aoe: 'area damage',
  dot: 'damage over time',
  summons: 'summoned units',
  global: 'global presence',
  channel: 'channelled abilities',
  'aa-reliant': 'Basic Attack damage',
  'mana-hungry': 'Mana use',
  'split-push': 'split-pushing',
  'vulnerable-body': 'vulnerable body',
  displace: 'displacement',
  pull: 'pulls',
  'role:tank': 'Tank frontline',
  'role:bruiser': 'Bruiser frontline',
  'role:healer': 'healing',
  'role:support': 'support kit',
  'role:ranged-assassin': 'ranged damage',
  'role:melee-assassin': 'melee damage',
  'type:melee': 'melee range',
  'type:ranged': 'range',
};

/** Human label for a tag or selector used in rule templates ({aTag}, {bTag}, {heroTag}). */
export function tagLabel(atom: RuleAtom): string {
  return TAG_LABEL[atom] ?? atom.replace(/-/g, ' ');
}

// ---- tag strengths ---------------------------------------------------------------------

interface TagInfo {
  /** 1 = always available, OPTIONAL_FACTOR = talent-only or one-of-several Heroics. */
  factor: number;
  /** Ability/talent names that justify the tag, strongest first. */
  evidence: string[];
}

/** One hero's matchable atoms: mechanics tags plus role/type selectors. */
export interface HeroProfile {
  id: string;
  slug: string;
  name: string;
  atoms: Map<RuleAtom, TagInfo>;
}

interface Kit {
  abilities: Hero['abilities'];
  talentNames: Set<string>;
}

function kitOf(hero: Hero): Kit {
  const talentNames = new Set<string>();
  for (const list of Object.values(hero.talents)) for (const t of list) talentNames.add(t.name);
  return { abilities: hero.abilities, talentNames };
}

function roleAtom(role: string): RuleAtom {
  return `role:${role.toLowerCase().replace(/ /g, '-')}` as RuleAtom;
}

/**
 * Strength of each tag for a hero. `kits` are the hero's own kit plus its members' kits for a
 * composite, used to tell basic abilities from Heroic choices.
 */
export function heroProfile(hero: Hero, kits: Kit[]): HeroProfile {
  const atoms = new Map<RuleAtom, TagInfo>();
  const abilityKind = new Map<string, { kind: string; kit: Kit }>();
  for (const kit of kits) for (const a of kit.abilities) if (!abilityKind.has(a.name)) abilityKind.set(a.name, { kind: a.kind, kit });

  for (const m of hero.mechanics) {
    let core = false;
    const heroicByKit = new Map<Kit, Set<string>>();
    const ranked: { name: string; rank: number }[] = [];
    for (const ev of m.evidence) {
      if (ev.kind === 'curated') {
        core = true;
        continue;
      }
      if (ev.kind === 'talent') {
        ranked.push({ name: ev.name, rank: 2 });
        continue;
      }
      const info = abilityKind.get(ev.name);
      if (info?.kind === 'heroic') {
        const set = heroicByKit.get(info.kit) ?? new Set<string>();
        set.add(ev.name);
        heroicByKit.set(info.kit, set);
        ranked.push({ name: ev.name, rank: 1 });
      } else {
        core = true;
        ranked.push({ name: ev.name, rank: 0 });
      }
    }
    // Every Heroic choice of a kit grants the tag → the hero always has it.
    for (const [kit, names] of heroicByKit) {
      const heroics = kit.abilities.filter((a) => a.kind === 'heroic').map((a) => a.name);
      if (heroics.length > 0 && heroics.every((n) => names.has(n))) core = true;
    }
    const seen = new Set<string>();
    const evidence = ranked
      .sort((a, b) => a.rank - b.rank)
      .map((r) => r.name)
      .filter((n) => (seen.has(n) ? false : (seen.add(n), true)));
    atoms.set(m.tag, { factor: core ? 1 : OPTIONAL_FACTOR, evidence });
  }
  atoms.set(roleAtom(hero.role), { factor: 1, evidence: [] });
  if (hero.roleAlt) atoms.set(roleAtom(hero.roleAlt), { factor: 1, evidence: [] });
  atoms.set(hero.type === 'Melee' ? 'type:melee' : 'type:ranged', { factor: 1, evidence: [] });
  return { id: hero.id, slug: hero.slug, name: hero.name, atoms };
}

// ---- rule matching ---------------------------------------------------------------------

export interface SideMatch {
  factor: number;
  /** The first hero tag of the matching expression (or the selector), for {aTag}/{bTag}. */
  tag: RuleAtom;
  evidence: string[];
}

/** Best match of a rule side (list of `tag` / `tag&tag` expressions) against a hero. */
export function matchSide(exprs: readonly string[], profile: HeroProfile): SideMatch | null {
  let best: SideMatch | null = null;
  for (const expr of exprs) {
    const parts = expr.split('&') as RuleAtom[];
    let factor = 1;
    const evidence: string[] = [];
    let ok = true;
    for (const part of parts) {
      const info = profile.atoms.get(part);
      if (!info) {
        ok = false;
        break;
      }
      factor = Math.min(factor, info.factor);
      for (const e of info.evidence) if (!evidence.includes(e)) evidence.push(e);
    }
    if (!ok) continue;
    const tag = parts.find((p) => !p.includes(':')) ?? (parts[0] as RuleAtom);
    if (!best || factor > best.factor) best = { factor, tag, evidence };
  }
  return best;
}

const PLACEHOLDER = /\{(\w+)\}/g;

/** Renders a rule template; " ({evidence})" disappears when there is no evidence. */
export function renderTemplate(template: string, values: Record<string, string>, evidence: readonly string[]): string {
  const ev = evidence.slice(0, MAX_REASON_EVIDENCE).join(', ');
  let tpl = template;
  if (!ev) tpl = tpl.replace(/\s*\(\{evidence\}\)/g, '').replace(/\{evidence\}/g, '');
  return tpl
    .replace(PLACEHOLDER, (m, key: string) => (key === 'evidence' ? ev : (values[key] ?? m)))
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;])/g, '$1')
    .trim();
}

interface Contribution {
  value: number;
  id: string;
  reason: Reason;
}

function ruleReason(text: string, evidence: readonly string[]): Reason {
  const ev = evidence.slice(0, MAX_REASON_EVIDENCE);
  return ev.length ? { kind: 'theory', text, evidence: [...ev] } : { kind: 'theory', text };
}

function applyRule(rule: Rule, a: HeroProfile, b: HeroProfile): Contribution | null {
  const ma = matchSide(rule.a, a);
  if (!ma) return null;
  const mb = matchSide(rule.b, b);
  if (!mb) return null;
  const text = renderTemplate(rule.why, { a: a.name, b: b.name, aTag: tagLabel(ma.tag), bTag: tagLabel(mb.tag) }, ma.evidence);
  return { value: rule.weight * ma.factor * mb.factor, id: rule.id, reason: ruleReason(text, ma.evidence) };
}

/** A synergy rule counts once per pair, in whichever direction contributes most. */
function applySynergyRule(rule: Rule, x: HeroProfile, y: HeroProfile): Contribution | null {
  const one = applyRule(rule, x, y);
  const two = applyRule(rule, y, x);
  if (!one) return two;
  if (!two) return one;
  return Math.abs(two.value) > Math.abs(one.value) ? two : one;
}

function curatedReasons(pair: MergedPair): Reason[] {
  return pair.why.map((text, i) => (i === 0 && pair.evidence.length ? { kind: 'curated', text, evidence: [...pair.evidence] } : { kind: 'curated', text }));
}

const round = (x: number): number => Math.round(x * 1e9) / 1e9;

function byContribution(a: Contribution, b: Contribution): number {
  return Math.abs(b.value) - Math.abs(a.value) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function edge(a: string, b: string, contributions: Contribution[], pair: MergedPair | undefined): Edge | null {
  const x = round(contributions.reduce((s, c) => s + c.value, 0) + (pair?.weight ?? 0));
  if (x === 0) return null;
  const reasons = [...(pair ? curatedReasons(pair) : []), ...[...contributions].sort(byContribution).map((c) => c.reason)];
  return { a, b, score: theoryScore(x), source: pair ? 'curated' : 'theory', reasons };
}

// ---- mechanics merging and curated traits ----------------------------------------------

const TAG_ORDER = new Map<string, number>(HERO_TAGS.map((t, i) => [t, i]));
const byTag = (a: Mechanic, b: Mechanic): number => (TAG_ORDER.get(a.tag) ?? 0) - (TAG_ORDER.get(b.tag) ?? 0);

/** Union of mechanics lists by tag; evidence de-duplicated, first occurrence first. */
export function mergeMechanics(...lists: readonly (readonly Mechanic[])[]): Mechanic[] {
  const out = new Map<HeroTag, Mechanic>();
  for (const list of lists) {
    for (const m of list) {
      const cur = out.get(m.tag) ?? { tag: m.tag, evidence: [] };
      for (const ev of m.evidence) {
        if (!cur.evidence.some((e) => e.kind === ev.kind && e.name === ev.name && e.snippet === ev.snippet)) cur.evidence.push({ ...ev });
      }
      out.set(m.tag, cur);
    }
  }
  return [...out.values()].sort(byTag);
}

/**
 * Merges curated traits (traits.yaml and per-hero files; op add/remove) into each hero's
 * mechanics with evidence kind `curated`. A composite (Cho'gall) whose members are in `heroes`
 * first takes the union of its members' mechanics. Pure and idempotent; order of `heroes` kept.
 */
export function applyCuratedTraits(heroes: readonly Hero[], curated: CuratedBundle): Hero[] {
  const byId = new Map(heroes.map((h) => [h.id, h]));
  return heroes.map((hero) => {
    const members = (hero.members ?? []).map((id) => byId.get(id)).filter((h): h is Hero => h !== undefined);
    let mechanics = mergeMechanics(hero.mechanics, ...members.map((m) => m.mechanics));
    for (const trait of curated.traits[hero.slug] ?? []) {
      if (trait.op === 'remove') {
        mechanics = mechanics.filter((m) => m.tag !== trait.tag);
        continue;
      }
      mechanics = mergeMechanics(mechanics, [{ tag: trait.tag, evidence: [{ kind: 'curated', name: trait.source, snippet: trait.why }] }]);
    }
    return { ...hero, mechanics };
  });
}

// ---- rules version ---------------------------------------------------------------------

/** Stable JSON: object keys sorted, so equal values always serialise identically. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** 64-bit FNV-1a over UTF-16 code units, as 16 hex digits (browser-safe, no crypto needed). */
export function fnv1a64(text: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < text.length; i++) {
    h ^= BigInt(text.charCodeAt(i));
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/** `${RULES_VERSION}+<12 hex>`: changes whenever the engine or any curated input changes. */
export function theoryRulesVersion(curated: CuratedBundle): string {
  const inputs = { rules: curated.rules, maps: curated.maps, traits: curated.traits, counters: curated.counters, synergies: curated.synergies };
  return `${RULES_VERSION}+${fnv1a64(stable(inputs)).slice(0, 12)}`;
}

// ---- build -----------------------------------------------------------------------------

export interface BuildTheoryInput {
  /** Draftable entities (Cho'gall as the composite) with mechanics; members may be included too. */
  heroes: Hero[];
  maps: GameMap[];
  curated: CuratedBundle;
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Builds theory.json. Curated traits are (re-)applied here, so callers may pass heroes with or
 * without them. Curated pairs naming heroes that are not in `heroes` are ignored (the curated
 * validator reports them). Output arrays are sorted: counters and synergies by (a, b), map fit
 * by (hero, map).
 */
export function buildTheory(input: BuildTheoryInput): Theory {
  const { curated } = input;
  const heroes = applyCuratedTraits(input.heroes, curated);
  const byId = new Map(heroes.map((h) => [h.id, h]));
  const entities = heroes.filter((h) => !h.memberOf).sort((a, b) => cmp(a.id, b.id));
  const profiles = new Map<string, HeroProfile>();
  for (const h of entities) {
    const kits = [kitOf(h), ...(h.members ?? []).map((id) => byId.get(id)).filter((m): m is Hero => m !== undefined).map(kitOf)];
    profiles.set(h.id, heroProfile(h, kits));
  }
  // Curated pairs are keyed by slug; members resolve to their composite.
  const idBySlug = new Map<string, string>();
  for (const h of heroes) idBySlug.set(h.slug, h.memberOf ?? h.id);
  const resolve = (slug: string): string | undefined => {
    const id = idBySlug.get(slug);
    return id !== undefined && profiles.has(id) ? id : undefined;
  };

  const curatedCounters = new Map<string, MergedPair>();
  for (const p of curated.counters) {
    const a = resolve(p.a);
    const b = resolve(p.b);
    if (a && b && a !== b) curatedCounters.set(`${a}>${b}`, p);
  }
  const curatedSynergies = new Map<string, MergedPair>();
  for (const p of curated.synergies) {
    const a = resolve(p.a);
    const b = resolve(p.b);
    if (a && b && a !== b) curatedSynergies.set(a < b ? `${a}+${b}` : `${b}+${a}`, p);
  }

  const list = [...profiles.values()];
  const counters: Edge[] = [];
  const synergies: Edge[] = [];
  for (const A of list) {
    for (const B of list) {
      if (A.id === B.id) continue;
      const contributions = curated.rules.counters.map((r) => applyRule(r, A, B)).filter((c): c is Contribution => c !== null);
      const e = edge(A.id, B.id, contributions, curatedCounters.get(`${A.id}>${B.id}`));
      if (e) counters.push(e);
      if (A.id < B.id) {
        const syn = curated.rules.synergies.map((r) => applySynergyRule(r, A, B)).filter((c): c is Contribution => c !== null);
        const s = edge(A.id, B.id, syn, curatedSynergies.get(`${A.id}+${B.id}`));
        if (s) synergies.push(s);
      }
    }
  }

  const mapFit: MapFit[] = [];
  const maps = [...input.maps].sort((a, b) => cmp(a.id, b.id));
  for (const hero of list) {
    for (const map of maps) {
      const contributions: Contribution[] = [];
      for (const rule of curated.maps.fit) {
        const mapTag = rule.map.find((t) => map.profile.tags.includes(t));
        if (!mapTag) continue;
        const m = matchSide(rule.hero, hero);
        if (!m) continue;
        const text = renderTemplate(rule.why, { hero: hero.name, map: map.name, heroTag: tagLabel(m.tag), mapTag: mapTag.replace(/-/g, ' ') }, m.evidence);
        contributions.push({ value: rule.weight * m.factor, id: rule.id, reason: ruleReason(text, m.evidence) });
      }
      if (contributions.length === 0) continue;
      const x = round(contributions.reduce((s, c) => s + c.value, 0));
      mapFit.push({ hero: hero.id, map: map.id, score: theoryScore(x), reasons: contributions.sort(byContribution).map((c) => c.reason) });
    }
  }

  return {
    rulesVersion: theoryRulesVersion(curated),
    counters: counters.sort((a, b) => cmp(a.a, b.a) || cmp(a.b, b.b)),
    synergies: synergies.sort((a, b) => cmp(a.a, b.a) || cmp(a.b, b.b)),
    mapFit: mapFit.sort((a, b) => cmp(a.hero, b.hero) || cmp(a.map, b.map)),
  };
}
