/**
 * Props the draft and ARAM pages hand to their islands (computed at build time from load.ts),
 * plus small browser-safe helpers shared by the island components.
 */
import { useEffect, useState } from 'preact/hooks';
import { assetHref } from '../../../registry.ts';
import { decodeShard, type DraftData } from '../../draft/data.ts';
import { sourcesUsed, type Suggestion } from '../../draft/suggest.ts';
import type { HeroRole } from '../../schema.ts';

/** Display data for one draftable entity, in universe order (release date, id). */
export interface RosterHero {
  id: string;
  slug: string;
  name: string;
  role: HeroRole;
  roleAlt: HeroRole | null;
  type: 'Melee' | 'Ranged';
  /** 'img/heroes/….webp' */
  portrait: string;
  slots: 1 | 2;
  members: string[] | null;
  aliases: string[];
  isNew: boolean;
}

export interface MapOption {
  id: string;
  name: string;
  ranked: boolean;
  /** Map art ('img/maps/….webp', for assetHref) when the build has it. */
  image?: string;
}

/** A source's inline credit, built from its SourceRef; islands render it next to the numbers it backs. */
export interface CreditProp {
  /** SourceRef id (what Reason.source and the statistics block name). */
  id: string;
  name: string;
  url: string;
  attribution: string;
  /** Licence name and link, for share-alike sources. */
  license?: string;
  licenseUrl?: string;
}

/** Credits by SourceRef id. */
export type CreditMap = Readonly<Record<string, CreditProp>>;

/** Credits for the sources a list of suggestions uses, first seen first; ids the site has no SourceRef for are skipped. */
export function creditsFor(list: readonly Suggestion[], credits: CreditMap): CreditProp[] {
  return sourcesUsed(list)
    .map((id) => credits[id])
    .filter((c): c is CreditProp => c !== undefined);
}

/** Source names by SourceRef id, for reason meta ("n = 120 · Liquipedia"). */
export function sourceNamesOf(credits: CreditMap): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.values(credits).map((c) => [c.id, c.name]));
}

/**
 * Display name of a reason's source, or null when the site has no SourceRef for the id: the raw
 * id is never shown, so only sources the site lists (and credits) are named.
 */
export function sourceName(names: Readonly<Record<string, string>> | undefined, id: string | undefined): string | null {
  return id ? (names?.[id] ?? null) : null;
}

/**
 * Split a credit around the source name so the name itself is the link, as SourceAttribution
 * does: "Pro draft data from " + [Liquipedia] + ", licensed …". Adds the final full stop when missing.
 */
export function creditParts(credit: CreditProp): { before: string; after: string } {
  const at = credit.attribution.indexOf(credit.name);
  const stop = /[.!?)]$/.test(credit.attribution) ? '' : '.';
  if (at < 0) return { before: `${credit.attribution} `, after: stop };
  return { before: credit.attribution.slice(0, at), after: `${credit.attribution.slice(at + credit.name.length)}${stop}` };
}

export function portraitUrl(hero: { portrait: string }): string {
  return assetHref('hots', hero.portrait);
}

export const ROLE_SHORT: Readonly<Record<HeroRole, string>> = {
  Tank: 'Tank',
  Bruiser: 'Bruiser',
  Healer: 'Healer',
  Support: 'Support',
  'Ranged Assassin': 'Ranged',
  'Melee Assassin': 'Melee',
};

export function roleText(hero: { role: HeroRole; roleAlt: HeroRole | null }): string {
  return hero.roleAlt ? `${ROLE_SHORT[hero.role]} / ${ROLE_SHORT[hero.roleAlt]}` : ROLE_SHORT[hero.role];
}

export type ShardState = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: DraftData };

/** Fetch and decode the draft shard once per URL; `retry` refetches after an error. */
export function useShard(url: string): { shard: ShardState; retry: () => void } {
  const [shard, setShard] = useState<ShardState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let alive = true;
    const ctl = new AbortController();
    setShard({ status: 'loading' });
    fetch(url, { signal: ctl.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`the server answered ${res.status}`);
        return res.json() as Promise<unknown>;
      })
      .then((json) => {
        if (alive) setShard({ status: 'ready', data: decodeShard(json) });
      })
      .catch((err: unknown) => {
        if (!alive || (err instanceof DOMException && err.name === 'AbortError')) return;
        setShard({ status: 'error', message: err instanceof Error ? err.message : String(err) });
      });
    return () => {
      alive = false;
      ctl.abort();
    };
  }, [url, attempt]);
  return { shard, retry: () => setAttempt((n) => n + 1) };
}

/** Live result of a CSS media query; false on the server and before hydration. */
export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const update = () => setMatch(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, [query]);
  return match;
}

/** Phones: the step and suggestions come first, so keep the list short above the board. */
export const NARROW_QUERY = '(max-width: 47.99rem)';

/** Names joined for prose: "A", "A and B", "A, B and C". */
export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
