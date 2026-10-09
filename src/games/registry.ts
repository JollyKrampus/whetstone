/**
 * Browser-safe registry of every game module, plus URL helpers. Safe to import from islands,
 * .astro pages, the pipeline (plain Node) and Playwright, so it must not touch Vite-only APIs
 * without a fallback.
 */
import type { GameId, GameModule, SourceRef } from '../core/game.ts';
import { hots } from './hots/module.ts';
import { mtga } from './mtga/module.ts';
import { pokemon } from './pokemon/module.ts';

/** Display order on the home page and in the header switcher. */
export const games: readonly GameModule[] = [hots, mtga, pokemon];

export const SITE = {
  name: 'Whetstone',
  tagline: 'Sharpen every pick.',
  description:
    'A free, static meta companion for Heroes of the Storm, MTG Arena and Pokémon Champions: counters, drafts, decks and teams, with the reasons and sample sizes behind every number. Data refreshed daily.',
  repo: 'https://github.com/JollyKrampus/whetstone',
  feedback: 'https://github.com/JollyKrampus/whetstone/issues/new/choose',
  origin: 'https://jollykrampus.github.io',
} as const;

/** Global (non-game) routes, relative to the site base. */
export const siteRoutes: readonly string[] = ['', 'about/', 'credits/', 'privacy/'];

const FALLBACK_BASE = '/whetstone/';

/**
 * Vite statically replaces import.meta.env.BASE_URL; under plain Node (pipeline, Playwright)
 * import.meta.env is undefined, so fall back to the deployed base.
 */
function resolveBase(): string {
  let raw: string | undefined;
  try {
    raw = import.meta.env.BASE_URL;
  } catch {
    raw = undefined;
  }
  const base = raw || FALLBACK_BASE;
  return base.endsWith('/') ? base : `${base}/`;
}

/** Site base path with a trailing slash, e.g. '/whetstone/'. */
export const BASE: string = resolveBase();

export function isGameId(value: string): value is GameId {
  return games.some((g) => g.id === value);
}

export function gameById(id: GameId): GameModule {
  const game = games.find((g) => g.id === id);
  if (!game) throw new Error(`Unknown game "${id}"`);
  return game;
}

/**
 * Absolute, base-prefixed URL path for a site-relative path. Directory-style paths keep their
 * trailing slash; fragments and query strings are preserved.
 *   withBase('hots/draft/') === '/whetstone/hots/draft/'
 */
export function withBase(path = ''): string {
  return `${BASE}${path.replace(/^\/+/, '')}`;
}

/** URL of a page inside a game, e.g. navHref('hots', 'draft/') === '/whetstone/hots/draft/'. */
export function navHref(game: GameId | GameModule, path = ''): string {
  const id = typeof game === 'string' ? game : game.id;
  return withBase(`${id}/${path.replace(/^\/+/, '')}`);
}

/**
 * URL of a data asset that pipeline/stage.ts copies unchanged (images under img/**), from the
 * game-relative path stored in the data:
 *   assetHref('hots', 'img/heroes/x.webp') === '/whetstone/data/hots/img/heroes/x.webp'
 * Content-hashed JSON shards are resolved through src/lib/stagemap.ts instead.
 */
export function assetHref(game: GameId, rel: string): string {
  return withBase(`data/${game}/${rel.replace(/^\/+/, '')}`);
}

/** Site-relative route of every global page and every game nav entry (used by the e2e smoke test). */
export function allNavRoutes(): string[] {
  const routes = new Set<string>(siteRoutes);
  for (const game of games) {
    for (const item of game.nav) routes.add(`${game.id}/${item.path}`);
  }
  return [...routes];
}

/** Every SourceRef of a game, optionally narrowed to the given ids (unknown ids are ignored). */
export function sourcesFor(game: GameId, ids?: readonly string[]): SourceRef[] {
  const all = gameById(game).sources;
  if (!ids) return [...all];
  return ids.flatMap((id) => all.filter((s) => s.id === id));
}

/**
 * Where the header's search button goes for each game: the hero/usage grid's filter input
 * (EntityFilter renders id="search") or a dedicated search page.
 */
const SEARCH_PATH: Readonly<Record<GameId, string>> = {
  hots: '#search',
  mtga: 'search/',
  pokemon: '#search',
};

export function searchHref(game: GameId): string {
  return navHref(game, SEARCH_PATH[game]);
}

const VERSION_PREFIX: Readonly<Record<GameId, string>> = {
  hots: 'Patch',
  mtga: 'Set',
  pokemon: '',
};

/** Human label for a data version: "Patch 2.57", "Set EOE", "Reg M-C". */
export function versionText(game: GameId, label: string): string {
  const prefix = VERSION_PREFIX[game];
  if (!prefix || label.toLowerCase().startsWith(prefix.toLowerCase())) return label;
  return `${prefix} ${label}`;
}

/** Game id owning the given pathname (with or without the base), or null for global pages. */
export function gameFromPath(pathname: string): GameId | null {
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.replace(/^\/+/, '');
  const first = rest.split('/')[0] ?? '';
  return isGameId(first) ? first : null;
}
