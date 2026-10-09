/**
 * Dev/test-only adapter: builds theory `HeroInput[]` from an unpacked heroes-data2 release
 * (`data/herodata_<build>.json` + `gamestrings/gamestrings_<build>_enus.json`), so the extractor
 * can be developed and checked against every real kit. Node-only. The production pipeline builds
 * heroes.json itself (src/games/hots/pipeline/); this mirrors its shape closely enough for the
 * theory layer: names, ability kinds, talents by tier and rendered tooltip text.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { HeroInput } from '../types.ts';

// ---- raw heroes-data2 shapes (only the fields we read) ---------------------------------

interface RawAbility {
  linkId: string;
  abilityId?: string;
  icon?: string;
  abilityType: string;
}
interface RawTalent {
  linkId: string;
  talentId: string;
  icon?: string;
  abilityType: string;
  isQuest?: boolean;
  sort: number;
}
interface RawHero {
  attributeId: string;
  franchise: string;
  releaseDate?: string;
  isMelee?: boolean;
  ratings?: { complexity: number; damage: number; survivability: number; utility: number };
  portraits?: { heroSelect?: string };
  abilities?: Record<string, RawAbility[]>;
  heroUnits?: Record<string, { abilities?: Record<string, RawAbility[]> }>[] | Record<string, { abilities?: Record<string, RawAbility[]> }>;
  talents?: Record<string, RawTalent[]>;
}
type StringTable = Record<string, string>;
interface RawStrings {
  ability: { name: StringTable; fullText: StringTable; cooldownText: StringTable; energyText: StringTable };
  talent: { name: StringTable; fullText: StringTable };
  hero: { name: StringTable; title: StringTable; expandedRole: StringTable; difficulty: StringTable };
}

export interface HeroesDataExtract {
  heroes: Record<string, RawHero>;
  strings: RawStrings;
}

/** Reads the newest herodata/gamestrings pair from an unpacked heroes-data2 directory. */
export function readHeroesData(dir: string): HeroesDataExtract {
  const pick = (sub: string, re: RegExp): string => {
    const files = fs.readdirSync(path.join(dir, sub)).filter((f) => re.test(f)).sort();
    const last = files.at(-1);
    if (!last) throw new Error(`no file matching ${re} in ${path.join(dir, sub)}`);
    return path.join(dir, sub, last);
  };
  const heroes = (JSON.parse(fs.readFileSync(pick('data', /^herodata_\d+\.json$/), 'utf8')) as { items: Record<string, RawHero> }).items;
  const strings = (JSON.parse(fs.readFileSync(pick('gamestrings', /^gamestrings_\d+_enus\.json$/), 'utf8')) as { items: RawStrings }).items;
  return { heroes, strings };
}

// ---- text ------------------------------------------------------------------------------

/**
 * Renders heroes-data2 tooltip markup as plain text the way heroes.json stores it: tags removed,
 * `<n/>` as a line break, per-level scaling `~~0.04~~` as " (+4% per level)".
 */
export function renderGameText(raw: string): string {
  return raw
    .replace(/<n\/>/g, '\n')
    .replace(/<img[^>]*\/>/g, '')
    .replace(/~~([0-9.]+)~~/g, (_m, s: string) => ` (+${Math.round(Number(s) * 1000) / 10}% per level)`)
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Lowercase alphanumerics of the English name (`Li-Ming` → `liming`). */
export function heroSlug(name: string): string {
  return name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ---- mapping ---------------------------------------------------------------------------

const KIND: Record<string, HeroInput['abilities'][number]['kind'] | null> = {
  Basic: 'basic',
  Heroic: 'heroic',
  Trait: 'trait',
  Mount: 'mount',
  Activable: 'active',
  Hearth: null,
};
const HOTKEY: Record<string, string> = { Q: 'Q', W: 'W', E: 'E', Heroic: 'R', Trait: 'D', Z: 'Z' };
const TALENT_ABILITY: Record<string, NonNullable<HeroInput['talents']['1'][number]['ability']>> = {
  Q: 'Q',
  W: 'W',
  E: 'E',
  Heroic: 'R',
  Trait: 'D',
  Z: 'Z',
  Active: 'Active',
  Passive: 'Passive',
};
const ROLES = new Set(['Tank', 'Bruiser', 'Healer', 'Support', 'Ranged Assassin', 'Melee Assassin']);
const DIFFICULTIES = new Set(['Easy', 'Medium', 'Hard', 'Very Hard']);
const FRANCHISES: Record<string, HeroInput['franchise']> = {
  Starcraft: 'StarCraft',
  Warcraft: 'Warcraft',
  Diablo: 'Diablo',
  Overwatch: 'Overwatch',
  Classic: 'Classic',
};
const TIERS = ['1', '4', '7', '10', '13', '16', '20'] as const;

function icon(file: string | undefined): string {
  return `img/icons/${(file ?? 'unknown.png').toLowerCase().replace(/\.png$/, '.webp')}`;
}

function seconds(text: string | undefined): number | undefined {
  const m = /([0-9.]+)\s*seconds?/.exec(renderGameText(text ?? ''));
  return m ? Number(m[1]) : undefined;
}

function cost(text: string | undefined): string | undefined {
  const m = /^(\w+):\s*([0-9.]+)/.exec(renderGameText(text ?? ''));
  return m ? `${m[2]} ${m[1]}` : undefined;
}

function heroUnits(raw: RawHero): Record<string, { abilities?: Record<string, RawAbility[]> }>[] {
  if (!raw.heroUnits) return [];
  return Array.isArray(raw.heroUnits) ? raw.heroUnits : [raw.heroUnits];
}

function buildAbilities(raw: RawHero, s: RawStrings): HeroInput['abilities'] {
  const out: HeroInput['abilities'] = [];
  const seenName = new Set<string>();
  const seenId = new Set<string>();
  const add = (group: string, ab: RawAbility, unit: boolean) => {
    let kind = KIND[group];
    if (!kind) return;
    // Mount and Heroic entries of secondary units duplicate the main kit or are "cancel" buttons.
    if (unit && (kind === 'mount' || kind === 'heroic')) kind = 'active';
    const name = s.ability.name[ab.linkId];
    const text = s.ability.fullText[ab.linkId];
    if (!name || !text || seenName.has(name) || seenId.has(ab.linkId)) return;
    if (unit && /^Cancel\b/.test(name)) return;
    seenName.add(name);
    seenId.add(ab.linkId);
    const cd = seconds(s.ability.cooldownText[ab.linkId]);
    const c = cost(s.ability.energyText[ab.linkId]);
    out.push({
      id: ab.linkId,
      name,
      hotkey: kind === 'basic' ? (HOTKEY[ab.abilityType] ?? '') : kind === 'heroic' ? 'R' : kind === 'trait' ? 'D' : kind === 'mount' ? 'Z' : '',
      kind,
      ...(cd === undefined ? {} : { cooldown: cd }),
      ...(c === undefined ? {} : { cost: c }),
      text: renderGameText(text),
      icon: icon(ab.icon),
    });
  };
  for (const [group, list] of Object.entries(raw.abilities ?? {})) for (const ab of list) add(group, ab, false);
  for (const unit of heroUnits(raw)) {
    for (const u of Object.values(unit)) for (const [group, list] of Object.entries(u.abilities ?? {})) for (const ab of list) add(group, ab, true);
  }
  return out;
}

function buildTalents(raw: RawHero, s: RawStrings): HeroInput['talents'] {
  const talents = { '1': [], '4': [], '7': [], '10': [], '13': [], '16': [], '20': [] } as HeroInput['talents'];
  for (const tier of TIERS) {
    const list = [...(raw.talents?.[`Level${tier}`] ?? [])].sort((a, b) => a.sort - b.sort);
    for (const t of list) {
      const name = s.talent.name[t.linkId];
      const text = s.talent.fullText[t.linkId];
      if (!name || !text) continue;
      const ability = TALENT_ABILITY[t.abilityType];
      talents[tier].push({
        id: t.talentId,
        name,
        text: renderGameText(text),
        icon: icon(t.icon),
        ...(ability ? { ability } : {}),
        sort: t.sort,
        ...(t.isQuest ? { quest: true } : {}),
      });
    }
  }
  return talents;
}

/**
 * Every hero record the theory layer sees, sorted by slug: playable heroes, Cho and Gall as
 * members, and the composite `chogall` (no kit of its own; the engine merges its members).
 */
export function heroInputsFromHeroesData(src: HeroesDataExtract): HeroInput[] {
  const s = src.strings;
  const out: HeroInput[] = [];
  for (const [key, raw] of Object.entries(src.heroes)) {
    const name = s.hero.name[key] ?? key;
    const role = s.hero.expandedRole[key] ?? '';
    const difficulty = s.hero.difficulty[key] ?? '';
    if (!ROLES.has(role)) throw new Error(`${key}: unknown role ${role}`);
    if (!DIFFICULTIES.has(difficulty)) throw new Error(`${key}: unknown difficulty ${difficulty}`);
    const slug = heroSlug(name);
    out.push({
      id: raw.attributeId,
      slug,
      name,
      title: s.hero.title[key] ?? name,
      role: role as HeroInput['role'],
      type: raw.isMelee ? 'Melee' : 'Ranged',
      franchise: FRANCHISES[raw.franchise] ?? 'Classic',
      difficulty: difficulty as HeroInput['difficulty'],
      ratings: raw.ratings ?? { damage: 5, utility: 5, survivability: 5, complexity: 5 },
      ...(raw.releaseDate ? { releaseDate: raw.releaseDate } : {}),
      aliases: [],
      portrait: icon(raw.portraits?.heroSelect).replace('img/icons/', 'img/heroes/'),
      abilities: buildAbilities(raw, s),
      talents: buildTalents(raw, s),
      ...(slug === 'cho' || slug === 'gall' ? { memberOf: 'chogall' } : {}),
      isNew: false,
      hdpId: key,
    });
  }
  const cho = out.find((h) => h.slug === 'cho');
  const gall = out.find((h) => h.slug === 'gall');
  if (cho && gall) {
    out.push({
      id: 'chogall',
      slug: 'chogall',
      name: "Cho'gall",
      title: 'Twilight’s Hammer Chieftains',
      role: 'Tank',
      roleAlt: 'Ranged Assassin',
      type: 'Melee',
      franchise: 'Warcraft',
      difficulty: 'Hard',
      ratings: cho.ratings,
      ...(cho.releaseDate ? { releaseDate: cho.releaseDate } : {}),
      aliases: [],
      portrait: 'img/heroes/storm_ui_ingame_heroselect_btn_chogall.webp',
      abilities: [],
      talents: { '1': [], '4': [], '7': [], '10': [], '13': [], '16': [], '20': [] },
      members: [cho.id, gall.id],
      isNew: false,
    });
  }
  return out.sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}
