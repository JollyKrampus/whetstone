/**
 * links.json: outbound guide/wiki/stats links per hero (SPEC §5, hots-meta-extra §3.2). Pure.
 *
 * Slug rule (verified 91/91 on Psionic Storm and Nexus Compendium, 89/91 on Icy Veins): accents,
 * apostrophes and dots removed, spaces to dashes. Icy Veins has exactly two exceptions,
 * `e-t-c` and `kel-thuzad`. Liquipedia gets a link only where its page exists, which the
 * liquipedia source checks through the MediaWiki API. Statistics sites are not linked.
 */
import type { Link, Links } from '../../schema.ts';
import { compareStrings, outboundSlug } from '../util.ts';

/** Icy Veins slugs that differ from the general rule, keyed by our hero slug. */
export const ICY_VEINS_EXCEPTIONS: Readonly<Record<string, string>> = { etc: 'e-t-c', kelthuzad: 'kel-thuzad' };

export interface LinkHero {
  id: string;
  slug: string;
  name: string;
  members?: readonly string[] | undefined;
}

export const GENERAL_LINKS: readonly Link[] = [
  { site: 'blizzard', kind: 'news', label: 'Official news and patch notes', url: 'https://news.blizzard.com/en-us/feed/heroes-of-the-storm' },
  { site: 'twitch', kind: 'live', label: 'Heroes of the Storm on Twitch', url: 'https://www.twitch.tv/directory/category/heroes-of-the-storm' },
  { site: 'icy-veins', kind: 'tierlist', label: 'Icy Veins tier lists', url: 'https://www.icy-veins.com/heroes/heroes-of-the-storm-tier-list-hub' },
  { site: 'psionic-storm', kind: 'tierlist', label: 'Psionic Storm tier list', url: 'https://psionic-storm.com/en/tierlist/' },
  { site: 'liquipedia', kind: 'esports', label: 'Heroes of the Storm on Liquipedia', url: 'https://liquipedia.net/heroes/Main_Page' },
];

export function heroLinks(h: LinkHero, liquipediaTitle: string | null): Link[] {
  const s = outboundSlug(h.name);
  const iv = ICY_VEINS_EXCEPTIONS[h.slug] ?? s;
  const wiki = encodeURIComponent(h.name.replace(/ /g, '_'));
  const list: Link[] = [
    { site: 'icy-veins', kind: 'guide', label: `${h.name} build guide (Icy Veins)`, url: `https://www.icy-veins.com/heroes/${iv}-build-guide` },
    { site: 'psionic-storm', kind: 'guide', label: `${h.name} on Psionic Storm`, url: `https://psionic-storm.com/en/heroes/${s}/` },
    { site: 'nexus-compendium', kind: 'wiki', label: `${h.name} on Nexus Compendium`, url: `https://nexuscompendium.com/heroes/${s}` },
    { site: 'fandom', kind: 'wiki', label: `${h.name} on the Heroes Wiki`, url: `https://heroesofthestorm.fandom.com/wiki/${wiki}` },
  ];
  if (liquipediaTitle) {
    list.push({ site: 'liquipedia', kind: 'esports', label: `${h.name} on Liquipedia`, url: `https://liquipedia.net/heroes/${encodeURI(liquipediaTitle.replace(/ /g, '_'))}` });
  }
  return list;
}

/**
 * Links for every member hero (composites are left out: their page merges the members' links).
 * `liquipedia` maps hero id → existing Liquipedia page title (absent = no page or unknown).
 */
export function buildLinks(heroes: readonly LinkHero[], liquipedia: ReadonlyMap<string, string>): Links {
  const out: Links = { heroes: {}, general: GENERAL_LINKS.map((l) => ({ ...l })) };
  for (const h of [...heroes].filter((x) => !x.members).sort((a, b) => compareStrings(a.id, b.id))) {
    out.heroes[h.id] = heroLinks(h, liquipedia.get(h.id) ?? null);
  }
  return out;
}

/** Liquipedia page title candidates for a hero (its name; Cho and Gall share "Cho'gall"). */
export function liquipediaTitles(h: LinkHero, compositeName?: string): string[] {
  const titles = [h.name.replace(/ /g, '_')];
  if (compositeName) titles.push(compositeName.replace(/ /g, '_'));
  return titles;
}
