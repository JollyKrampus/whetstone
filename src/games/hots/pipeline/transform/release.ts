/**
 * Reads a heroes-data2 release (the `heroes-data-no-maps-<build>.zip` asset, already unzipped
 * into a path → bytes map) into the raw shapes the hero/map transforms use. Pure.
 *
 * Archive layout (verified for 2.55.17.98025 … 2.57.0.98348):
 *   data/herodata_<n>.json        { meta: { heroesVersion }, items: { <HdpId>: HdpHero } }
 *   data/mapdata_<n>.json         { items: { <English name>: HdpMap } }
 *   gamestrings/gamestrings_<n>_<locale>.json   { items: { hero|ability|talent: { <field>: { <key>: RawText } } } }
 */
import { isRecord } from '../util.ts';

export interface HdpAbility {
  linkId: string;
  abilityId?: string;
  buttonId?: string;
  icon?: string;
  abilityType: string;
}

export interface HdpTalent {
  linkId: string;
  talentId: string;
  abilityId?: string;
  icon?: string;
  abilityType?: string;
  isQuest?: boolean;
  sort?: number;
}

export interface HdpUnit {
  abilities?: Record<string, HdpAbility[]>;
}

export interface HdpHero {
  unitId?: string;
  hyperlinkId?: string;
  attributeId: string;
  franchise?: string;
  releaseDate?: string;
  isMelee?: boolean;
  ratings?: { complexity?: number; damage?: number; survivability?: number; utility?: number };
  portraits?: { heroSelect?: string; draftScreen?: string };
  life?: { amount?: number; regenRate?: number };
  energy?: { amount?: number; regenRate?: number };
  shield?: { amount?: number };
  weapons?: { damage?: number; period?: number; range?: number }[];
  speed?: number;
  abilities?: Record<string, HdpAbility[]>;
  talents?: Record<string, HdpTalent[]>;
  heroUnits?: Record<string, HdpUnit>;
}

export interface HdpMap {
  mapId?: string;
  replayPreviewImage?: string;
  loadingScreenImage?: string;
}

/** `items.<section>.<field>.<key>` of a gamestrings file. */
export type GameStrings = Record<string, Record<string, Record<string, unknown>>>;

export interface RawRelease {
  /** `meta.heroesVersion` of herodata (e.g. `2.57.0.98348`). */
  build: string;
  heroes: Record<string, HdpHero>;
  maps: Record<string, HdpMap>;
  /** enUS game strings. */
  strings: GameStrings;
  /** Other locales: locale code → hero key → localized name. */
  localizedHeroNames: Record<string, Record<string, string>>;
}

const decoder = new TextDecoder('utf-8');

function parseJson(bytes: Uint8Array, name: string): unknown {
  const text = decoder.decode(bytes);
  try {
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch (err) {
    throw new Error(`${name} is not valid JSON (${(err as Error).message})`, { cause: err });
  }
}

/** Which archive entries a release read needs (use as the unzip filter). */
export function wantedEntry(name: string, opts: { locales: boolean }): boolean {
  if (/(^|\/)data\/(herodata|mapdata)_\d+\.json$/.test(name)) return true;
  if (/(^|\/)gamestrings\/gamestrings_\d+_enus\.json$/.test(name)) return true;
  return opts.locales && /(^|\/)gamestrings\/gamestrings_\d+_[a-z]{4}\.json$/.test(name);
}

function itemsOf(json: unknown, name: string): Record<string, unknown> {
  if (!isRecord(json) || !isRecord(json.items)) throw new Error(`${name} has no "items" object`);
  return json.items;
}

export function readRelease(files: Readonly<Record<string, Uint8Array>>): RawRelease {
  const names = Object.keys(files);
  const find = (re: RegExp): string => {
    const hit = names.find((n) => re.test(n));
    if (!hit) throw new Error(`release archive has no entry matching ${re}`);
    return hit;
  };
  const heroName = find(/(^|\/)data\/herodata_\d+\.json$/);
  const heroJson = parseJson(files[heroName] as Uint8Array, heroName);
  const heroes = itemsOf(heroJson, heroName) as Record<string, HdpHero>;
  const meta = isRecord(heroJson) && isRecord(heroJson.meta) ? heroJson.meta : {};
  const build = typeof meta.heroesVersion === 'string' ? meta.heroesVersion : '';
  if (!/^\d+\.\d+\.\d+\.\d+(_ptr)?$/.test(build)) throw new Error(`${heroName}: meta.heroesVersion "${build}" is not a build`);

  const mapName = names.find((n) => /(^|\/)data\/mapdata_\d+\.json$/.test(n));
  const maps = mapName ? (itemsOf(parseJson(files[mapName] as Uint8Array, mapName), mapName) as Record<string, HdpMap>) : {};

  const enName = find(/(^|\/)gamestrings\/gamestrings_\d+_enus\.json$/);
  const strings = itemsOf(parseJson(files[enName] as Uint8Array, enName), enName) as GameStrings;

  const localizedHeroNames: Record<string, Record<string, string>> = {};
  for (const n of names.sort()) {
    const m = /(^|\/)gamestrings\/gamestrings_\d+_([a-z]{4})\.json$/.exec(n);
    if (!m || m[2] === 'enus') continue;
    const items = itemsOf(parseJson(files[n] as Uint8Array, n), n) as GameStrings;
    const heroNames = items.hero?.name ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(heroNames)) if (typeof v === 'string' && v.trim()) out[k] = v.trim();
    localizedHeroNames[m[2] as string] = out;
  }
  return { build, heroes, maps, strings, localizedHeroNames };
}

/** A game string as plain RawText, or undefined. */
export function str(strings: GameStrings, section: string, field: string, key: string): string | undefined {
  const v = strings[section]?.[field]?.[key];
  return typeof v === 'string' ? v : undefined;
}

export function strList(strings: GameStrings, section: string, field: string, key: string): string[] {
  const v = strings[section]?.[field]?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
