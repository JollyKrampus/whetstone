/**
 * heroes-data2 release → heroes.json records without `mechanics` (the theory hook adds those),
 * plus a per-hero model (stats, abilities, talents) used by the build-to-build diff. Pure.
 *
 * Ability selection: the hero's Basic (Q/W/E), Trait (D), Heroic (R), its own Mount (Z) unless
 * it is the generic "Summon Mount", talent-granted actives, then abilities of the hero's
 * secondary units (Abathur's Symbiote, D.Va's pilot, the Vikings) that are not already listed.
 * Hearthstone and "Cancel" buttons are skipped, as is anything without a name or tooltip.
 */
import type { ValidationIssue } from '../../../../core/game.ts';
import {
  HOTS_ROLES,
  TALENT_TIERS,
  type Ability,
  type AliasesFile,
  type Hero,
  type HeroRole,
  type Talent,
  type TalentTier,
  type Talents,
} from '../../schema.ts';
import { compareStrings, heroSlug, isoDate, round, searchKey, warn } from '../util.ts';
import { buildAliases, searchTextOwners, type AliasInput } from './aliases.ts';
import { parseCooldown, parseCost, renderGameText } from './gametext.ts';
import type { ImageRef } from './images.ts';
import { str, strList, type HdpAbility, type HdpHero, type RawRelease } from './release.ts';

/** A hero record before the theory hook adds `mechanics`. */
export type HeroInput = Omit<Hero, 'mechanics'>;

/** What the diff compares per hero (heroes.json content plus base stats). */
export interface HeroModel {
  id: string;
  name: string;
  /** Display name → value, e.g. { Health: 685, 'Basic Attack Damage': 26 }. */
  stats: Record<string, number>;
  abilities: Ability[];
  talents: Talents;
}

/** Composite draft entities (SPEC §5, §12 entry 8). Members keep their own records. */
export const COMPOSITES = [{ id: 'chogall', name: "Cho'gall", members: ['CCho', 'Gall'] as [string, string] }] as const;

/** Heroes released within this many days get `isNew` (badge, "early data"). */
export const NEW_HERO_DAYS = 90;

const KIND_BY_GROUP: Record<string, Ability['kind']> = {
  Basic: 'basic',
  Trait: 'trait',
  Heroic: 'heroic',
  Mount: 'mount',
  Activable: 'active',
};
const GROUP_ORDER = ['Basic', 'Trait', 'Heroic', 'Mount', 'Activable'];
const BASIC_ORDER = ['Q', 'W', 'E'];
const TALENT_ABILITY: Record<string, Talent['ability']> = {
  Q: 'Q',
  W: 'W',
  E: 'E',
  R: 'R',
  D: 'D',
  Z: 'Z',
  Heroic: 'R',
  Trait: 'D',
  Active: 'Active',
  Passive: 'Passive',
};
const FRANCHISES: Record<string, Hero['franchise']> = {
  warcraft: 'Warcraft',
  starcraft: 'StarCraft',
  diablo: 'Diablo',
  overwatch: 'Overwatch',
  classic: 'Classic',
  nexus: 'Classic',
};
const DIFFICULTIES = ['Easy', 'Medium', 'Hard', 'Very Hard'] as const;
const GENERIC_MOUNT = 'Mount|SummonMount|Z';

/** `storm_ui_icon_x.png` → `img/icons/storm_ui_icon_x.webp`. */
export function iconPath(file: string): string {
  return `img/icons/${webpName(file)}`;
}
export function portraitPath(file: string): string {
  return `img/heroes/${webpName(file)}`;
}
export function mapImagePath(file: string): string {
  return `img/maps/${webpName(file)}`;
}
/** Output file name: lowercase, only [a-z0-9._-] (Kel'Thuzad's icons carry an apostrophe). */
export function webpName(file: string): string {
  const base = file.split('/').pop() ?? file;
  return (
    base
      .toLowerCase()
      .replace(/\.(png|jpe?g|dds|tga|webp)$/i, '')
      .replace(/[^a-z0-9._-]+/g, '') + '.webp'
  );
}

function hotkeyFor(group: string, abilityType: string): string {
  if (group === 'Heroic') return 'R';
  if (group === 'Trait') return 'D';
  if (group === 'Mount') return 'Z';
  if (group === 'Activable') return '';
  return /^[QWE]$/.test(abilityType) ? abilityType : '';
}

function isCancel(a: HdpAbility, name: string): boolean {
  return /^cancel\b/i.test(name) || /cancel/i.test(a.icon ?? '') || /Cancel\|/.test(a.linkId);
}

function buildAbility(release: RawRelease, a: HdpAbility, group: string): Ability | null {
  const s = release.strings;
  const name = str(s, 'ability', 'name', a.linkId)?.trim();
  const text = renderGameText(str(s, 'ability', 'fullText', a.linkId));
  if (!name || !text || !a.icon || isCancel(a, name)) return null;
  const ability: Ability = {
    id: a.linkId,
    name,
    hotkey: hotkeyFor(group, a.abilityType),
    kind: KIND_BY_GROUP[group] ?? 'basic',
    text,
    icon: iconPath(a.icon),
  };
  const cd = parseCooldown(str(s, 'ability', 'cooldownText', a.linkId));
  if (cd !== undefined) ability.cooldown = cd;
  const cost = parseCost(str(s, 'ability', 'energyText', a.linkId) ?? str(s, 'ability', 'lifeText', a.linkId));
  if (cost) ability.cost = cost;
  return ability;
}

function groupAbilities(groups: Record<string, HdpAbility[]> | undefined): [string, HdpAbility][] {
  const out: [string, HdpAbility][] = [];
  for (const g of GROUP_ORDER) {
    let list = [...(groups?.[g] ?? [])];
    if (g === 'Basic') {
      list = list
        .map((a, i) => ({ a, i }))
        .sort((x, y) => {
          const kx = BASIC_ORDER.indexOf(x.a.abilityType);
          const ky = BASIC_ORDER.indexOf(y.a.abilityType);
          return (kx < 0 ? 9 : kx) - (ky < 0 ? 9 : ky) || x.i - y.i;
        })
        .map((x) => x.a);
    }
    for (const a of list) out.push([g, a]);
  }
  return out;
}

export function buildAbilities(release: RawRelease, hero: HdpHero): Ability[] {
  const out: Ability[] = [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const push = (group: string, a: HdpAbility, fromUnit: boolean): void => {
    if (group === 'Mount' && a.linkId === GENERIC_MOUNT) return;
    if (ids.has(a.linkId)) return;
    const ability = buildAbility(release, a, group);
    if (!ability) return;
    const nameKey = `${ability.kind}|${ability.name.toLowerCase()}`;
    if (fromUnit && names.has(nameKey)) return;
    ids.add(a.linkId);
    names.add(nameKey);
    out.push(ability);
  };
  for (const [g, a] of groupAbilities(hero.abilities)) push(g, a, false);
  for (const unit of Object.keys(hero.heroUnits ?? {}).sort(compareStrings)) {
    for (const [g, a] of groupAbilities(hero.heroUnits?.[unit]?.abilities)) push(g, a, true);
  }
  return out;
}

export function buildTalents(release: RawRelease, hero: HdpHero, issues: ValidationIssue[], heroName: string): Talents {
  const s = release.strings;
  const talents = Object.fromEntries(TALENT_TIERS.map((t) => [t, [] as Talent[]])) as unknown as Talents;
  for (const tier of TALENT_TIERS) {
    const list = [...(hero.talents?.[`Level${tier}`] ?? [])]
      .map((t, i) => ({ t, i }))
      .sort((x, y) => (x.t.sort ?? 99) - (y.t.sort ?? 99) || x.i - y.i);
    const seen = new Set<string>();
    for (const { t } of list) {
      const name = str(s, 'talent', 'name', t.linkId)?.trim();
      const text = renderGameText(str(s, 'talent', 'fullText', t.linkId));
      if (!name || !text || !t.icon || !t.talentId) {
        issues.push(warn(`${heroName}: level ${tier} talent ${t.talentId || t.linkId} has no name, text or icon; skipped`, 'heroes-data2'));
        continue;
      }
      if (seen.has(t.talentId)) continue;
      seen.add(t.talentId);
      const talent: Talent = { id: t.talentId, name, text, icon: iconPath(t.icon), sort: talents[tier].length + 1 };
      const ability = t.abilityType ? TALENT_ABILITY[t.abilityType] : undefined;
      if (ability) talent.ability = ability;
      if (t.isQuest) talent.quest = true;
      talents[tier].push(talent);
    }
  }
  return talents;
}

function franchiseOf(raw: string | undefined, name: string, issues: ValidationIssue[]): Hero['franchise'] {
  const f = FRANCHISES[(raw ?? '').toLowerCase()];
  if (f) return f;
  issues.push(warn(`${name}: unknown franchise "${raw}"; using Classic`, 'heroes-data2'));
  return 'Classic';
}

function roleOf(raw: string | undefined): HeroRole | null {
  return (HOTS_ROLES as readonly string[]).includes(raw ?? '') ? (raw as HeroRole) : null;
}

/**
 * Flex role for heroes whose legacy role list says "Multiclass" (Varian): the other frontline
 * role. Composites get theirs from their members.
 */
export function flexRole(role: HeroRole, legacyRoles: readonly string[]): HeroRole | undefined {
  if (!legacyRoles.includes('Multiclass')) return undefined;
  if (legacyRoles.includes('Warrior')) return role === 'Tank' ? 'Bruiser' : 'Tank';
  return undefined;
}

function difficultyOf(raw: string | undefined): Hero['difficulty'] {
  return (DIFFICULTIES as readonly string[]).includes(raw ?? '') ? (raw as Hero['difficulty']) : 'Medium';
}

function clampRating(v: number | undefined): number {
  return Math.max(0, Math.min(10, Math.round(v ?? 0)));
}

/** Base stats the diff tracks, by display name. */
export function heroStats(release: RawRelease, key: string, hero: HdpHero): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (name: string, v: number | undefined): void => {
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[name] = round(v, 4);
  };
  put('Health', hero.life?.amount);
  put('Health Regeneration', hero.life?.regenRate);
  const energyType = str(release.strings, 'hero', 'energyType', key)?.trim();
  if (energyType && hero.energy?.amount) put(energyType, hero.energy.amount);
  const w = hero.weapons?.[0];
  put('Basic Attack Damage', w?.damage);
  if (w?.period) put('Attack Speed', 1 / w.period);
  put('Attack Range', w?.range);
  return out;
}

export interface BuildHeroesOptions {
  aliases: AliasesFile;
  now: Date;
}

export interface BuiltHeroes {
  /** Every hero record (members and composites included), sorted by slug. */
  heroes: HeroInput[];
  models: Record<string, HeroModel>;
  /** Every image the records reference (portraits, ability and talent icons). */
  images: ImageRef[];
  issues: ValidationIssue[];
}

/** Images referenced by built hero records, with their heroes-images source names. */
export function heroImageRefs(release: RawRelease, heroes: readonly HeroInput[]): ImageRef[] {
  const refs = new Map<string, ImageRef>();
  const add = (file: string | undefined, out: string, folder: ImageRef['folder']): void => {
    if (file && !refs.has(out)) refs.set(out, { out, file: file.split('/').pop() ?? file, folder });
  };
  const used = new Set<string>();
  for (const h of heroes) {
    used.add(h.portrait);
    if (h.draftPortrait) used.add(h.draftPortrait);
    for (const a of h.abilities) used.add(a.icon);
    for (const tier of TALENT_TIERS) for (const t of h.talents[tier]) used.add(t.icon);
  }
  for (const h of Object.values(release.heroes)) {
    for (const f of [h.portraits?.heroSelect, h.portraits?.draftScreen]) if (f && used.has(portraitPath(f))) add(f, portraitPath(f), 'heroportraits');
    const groups = [h.abilities, ...Object.values(h.heroUnits ?? {}).map((u) => u.abilities)];
    for (const g of groups) for (const list of Object.values(g ?? {})) for (const a of list) if (a.icon && used.has(iconPath(a.icon))) add(a.icon, iconPath(a.icon), 'abilitytalents');
    for (const list of Object.values(h.talents ?? {})) for (const t of list) if (t.icon && used.has(iconPath(t.icon))) add(t.icon, iconPath(t.icon), 'abilitytalents');
  }
  return [...refs.values()].sort((a, b) => compareStrings(a.out, b.out));
}

export function buildHeroes(release: RawRelease, opts: BuildHeroesOptions): BuiltHeroes {
  const issues: ValidationIssue[] = [];
  const s = release.strings;
  const newSince = isoDate(new Date(opts.now.getTime() - NEW_HERO_DAYS * 86_400_000));
  const entries = Object.entries(release.heroes).sort(([a], [b]) => compareStrings(a, b));

  // Alias inputs for every hero first: searchText uniqueness is a roster-wide property.
  const aliasInputs = new Map<string, AliasInput>();
  for (const [key, h] of entries) {
    const name = str(s, 'hero', 'name', key)?.trim();
    if (!name) continue;
    const slug = heroSlug(name);
    aliasInputs.set(key, {
      slug,
      name,
      internalIds: [key, h.hyperlinkId ?? '', (h.unitId ?? '').replace(/^Hero/, '')].filter(Boolean),
      searchText: str(s, 'hero', 'searchText', key),
      localizedNames: Object.keys(release.localizedHeroNames)
        .sort(compareStrings)
        .map((loc) => release.localizedHeroNames[loc]?.[key])
        .filter((x): x is string => typeof x === 'string'),
      curated: opts.aliases.heroes[slug] ?? [],
    });
  }
  const owners = searchTextOwners([...aliasInputs.values()]);

  const heroes: HeroInput[] = [];
  const models: Record<string, HeroModel> = {};
  for (const [key, h] of entries) {
    const input = aliasInputs.get(key);
    const role = roleOf(str(s, 'hero', 'expandedRole', key));
    const title = str(s, 'hero', 'title', key)?.trim();
    if (!input || !role || !title || !/^[A-Za-z0-9]{4}$/.test(h.attributeId ?? '')) {
      issues.push(warn(`hero ${key}: missing name, title, role or attributeId; skipped`, 'heroes-data2'));
      continue;
    }
    const abilities = buildAbilities(release, h);
    if (abilities.length === 0) {
      issues.push(warn(`hero ${input.name}: no abilities with tooltips; skipped`, 'heroes-data2'));
      continue;
    }
    const talents = buildTalents(release, h, issues, input.name);
    const portrait = h.portraits?.heroSelect;
    if (!portrait) {
      issues.push(warn(`hero ${input.name}: no heroSelect portrait; skipped`, 'heroes-data2'));
      continue;
    }
    const hero: HeroInput = {
      id: h.attributeId,
      slug: input.slug,
      name: input.name,
      title,
      role,
      type: h.isMelee ? 'Melee' : 'Ranged',
      franchise: franchiseOf(h.franchise, input.name, issues),
      difficulty: difficultyOf(str(s, 'hero', 'difficulty', key)),
      ratings: {
        damage: clampRating(h.ratings?.damage),
        utility: clampRating(h.ratings?.utility),
        survivability: clampRating(h.ratings?.survivability),
        complexity: clampRating(h.ratings?.complexity),
      },
      aliases: buildAliases(input, owners),
      portrait: portraitPath(portrait),
      abilities,
      talents,
      isNew: false,
      hdpId: key,
    };
    const alt = flexRole(role, strList(s, 'hero', 'roles', key));
    if (alt) hero.roleAlt = alt;
    if (h.releaseDate && /^\d{4}-\d{2}-\d{2}$/.test(h.releaseDate)) {
      hero.releaseDate = h.releaseDate;
      hero.isNew = h.releaseDate > newSince;
    }
    if (h.portraits?.draftScreen) hero.draftPortrait = portraitPath(h.portraits.draftScreen);
    heroes.push(hero);
    models[hero.id] = { id: hero.id, name: hero.name, stats: heroStats(release, key, h), abilities, talents };
  }

  dedupeAliases(heroes, opts.aliases);

  for (const c of COMPOSITES) {
    const members = c.members.map((id) => heroes.find((x) => x.id === id));
    const [first, second] = members;
    if (!first || !second) {
      issues.push(warn(`composite ${c.id}: member hero missing (${c.members.join(', ')}); not emitted`, 'heroes-data2'));
      continue;
    }
    first.memberOf = c.id;
    second.memberOf = c.id;
    heroes.push(buildComposite(c, first, second, opts.aliases));
  }
  heroes.sort((a, b) => compareStrings(a.slug, b.slug));
  return { heroes, models, images: heroImageRefs(release, heroes), issues };
}

/**
 * An alias must point at one hero. Generated aliases that two heroes share ("zul" from Xul's
 * search text vs Zul'jin) or that spell another hero's name are dropped; a curated alias is kept
 * on the hero it was curated for.
 */
export function dedupeAliases(heroes: HeroInput[], aliases: AliasesFile): void {
  const curatedFor = (h: HeroInput, a: string): boolean => (aliases.heroes[h.slug] ?? []).some((x) => x.toLowerCase().trim() === a);
  const owners = new Map<string, Set<string>>();
  const nameOwner = new Map<string, string>();
  for (const h of heroes) {
    nameOwner.set(searchKey(h.slug), h.id);
    nameOwner.set(searchKey(h.name), h.id);
    for (const a of h.aliases) {
      const set = owners.get(a) ?? new Set<string>();
      set.add(h.id);
      owners.set(a, set);
    }
  }
  for (const h of heroes) {
    h.aliases = h.aliases.filter((a) => {
      if (curatedFor(h, a)) return true;
      const other = nameOwner.get(searchKey(a));
      if (other !== undefined && other !== h.id) return false;
      // A generated alias shared with another hero is ambiguous: drop it everywhere it was not curated.
      return (owners.get(a)?.size ?? 0) <= 1;
    });
  }
}

const DIFF_RANK = new Map(DIFFICULTIES.map((d, i) => [d, i] as const));

function buildComposite(c: (typeof COMPOSITES)[number], a: HeroInput, b: HeroInput, aliases: AliasesFile): HeroInput {
  const avg = (x: number, y: number): number => Math.round((x + y) / 2);
  const harder = (DIFF_RANK.get(a.difficulty) ?? 0) >= (DIFF_RANK.get(b.difficulty) ?? 0) ? a.difficulty : b.difficulty;
  const releaseDates = [a.releaseDate, b.releaseDate].filter((d): d is string => Boolean(d)).sort(compareStrings);
  const slug = c.id;
  const aliasSet = new Set<string>([...(aliases.heroes[slug] ?? []), c.name.toLowerCase()].map((x) => x.toLowerCase().trim()).filter((x) => x && x !== slug));
  const composite: HeroInput = {
    id: c.id,
    slug,
    name: c.name,
    title: a.title,
    role: a.role,
    type: a.type,
    franchise: a.franchise,
    difficulty: harder,
    ratings: {
      damage: avg(a.ratings.damage, b.ratings.damage),
      utility: avg(a.ratings.utility, b.ratings.utility),
      survivability: avg(a.ratings.survivability, b.ratings.survivability),
      complexity: avg(a.ratings.complexity, b.ratings.complexity),
    },
    aliases: [...aliasSet].sort(compareStrings),
    portrait: a.portrait,
    abilities: [],
    talents: Object.fromEntries(TALENT_TIERS.map((t) => [t, []])) as unknown as Talents,
    members: [a.id, b.id],
    isNew: a.isNew || b.isNew,
  };
  if (b.role !== a.role) composite.roleAlt = b.role;
  if (releaseDates[0]) composite.releaseDate = releaseDates[0];
  if (a.draftPortrait) composite.draftPortrait = a.draftPortrait;
  return composite;
}

/** Talent tier of a talent id in a hero model, if present. */
export function tierOf(model: HeroModel, talentId: string): TalentTier | undefined {
  return TALENT_TIERS.find((t) => model.talents[t].some((x) => x.id === talentId));
}
