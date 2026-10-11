/**
 * Browser-safe registry of every game module, plus URL helpers. Safe to import from islands,
 * .astro pages, the pipeline (plain Node), astro.config.mjs and Playwright, so it must not touch
 * Vite-only APIs without a fallback.
 *
 * One source of truth: GAME_IDS (src/core/game.ts) lists the games, MODULES maps each id to its
 * module, and PRESENTATION supplies what shared code needs about a game (footer notice, accent
 * colours, privacy rows, header search, version label, data-job timeout and environment) unless
 * the module declares it itself. Both records are keyed by GameId, so adding an id to GAME_IDS
 * without a module and a presentation entry is a type error. The header, footer, home page,
 * privacy page, theme, sitemap, smoke test, runner, stage, publish, private-data restore and the
 * data-deploy matrix (scripts/plan.ts) all read `games` from here.
 */
import { GAME_IDS, type Game, type GameId, type GameModule, type GamePresentation, type SourceRef } from '../core/game.ts';
import { hots } from './hots/module.ts';
import { mtga } from './mtga/module.ts';
import { pokemon } from './pokemon/module.ts';

const MODULES: Readonly<Record<GameId, GameModule>> = { hots, mtga, pokemon };

/**
 * Presentation for modules that do not declare it themselves (a module's own fields win).
 * Notices follow each rights holder's published fan guidance (Blizzard's copyright notices page,
 * the Wizards Fan Content Policy); keep the wording when editing.
 */
const PRESENTATION: Readonly<Record<GameId, GamePresentation>> = {
  hots: {
    legalNotice: {
      heading: 'Heroes of the Storm',
      body: [
        '©2014 Blizzard Entertainment, Inc. All rights reserved. Heroes of the Storm is a trademark of Blizzard Entertainment, Inc. ' +
          "Game content and materials are used under Blizzard's fan-site terms for non-commercial use.",
      ],
      owners: ['Blizzard Entertainment'],
    },
    accentColors: { dark: '#b69cff', light: '#6b3fd4' },
    searchPath: '#search',
    versionPrefix: 'Patch',
    storage: [
      {
        key: 'whetstone:hots:*',
        text:
          'Heroes of the Storm: your hero pool and favourites ("pool"), the hero grid\'s dimming choice, the draft tool\'s sort mode ' +
          'and "suggest from" choice, and the game mode you last picked on stats pages.',
      },
    ],
    pipeline: { timeoutMinutes: 90, env: ['YT_API_KEY', 'LIQUIPEDIA_UA_CONTACT'] },
  },
  mtga: {
    legalNotice: {
      heading: 'Magic: The Gathering Arena',
      body: [
        'Whetstone is unofficial Fan Content permitted under the ',
        { text: 'Fan Content Policy', href: 'https://company.wizards.com/en/legal/fancontentpolicy' },
        '. Not approved/endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.',
      ],
      owners: ['Wizards of the Coast'],
    },
    accentColors: { dark: '#f2b84b', light: '#8f5600' },
    searchPath: 'search/',
    versionPrefix: 'Set',
    storage: [
      { key: 'whetstone:mtga:*', text: 'MTG Arena: meta decklists you saved, your meta comparison choice and the wildcards you own.' },
      {
        key: 'whetstone-mtga',
        text:
          'MTG Arena card data cache (an IndexedDB database): a copy of the public card index the tools analyse with, one record per ' +
          'card pool, replaced when the card data is updated, so the multi-megabyte download happens once. It holds no information about you.',
      },
    ],
    pipeline: { timeoutMinutes: 30 },
  },
  pokemon: {
    legalNotice: {
      heading: 'Pokémon Champions',
      body: [
        'Pokémon and all related names are trademarks of Nintendo, Creatures Inc., GAME FREAK inc. and The Pokémon Company. ' +
          '©Nintendo, Creatures Inc., GAME FREAK inc., The Pokémon Company. Used here for identification only.',
      ],
      owners: ['The Pokémon Company', 'Nintendo', 'Creatures Inc.', 'GAME FREAK inc.'],
    },
    accentColors: { dark: '#ff7d73', light: '#c0282b' },
    searchPath: '#search',
    versionPrefix: '',
    storage: [
      {
        key: 'whetstone:pokemon:*',
        text: 'Pokémon Champions: teams you saved and the team currently open in the builder (the team preview reads it too).',
      },
    ],
    // No credentials. The dex export of the isolated showdown-export job (data-deploy.yml) arrives as
    // the WHETSTONE_SHOWDOWN_EXPORT file path, which the Pokémon pipeline reads itself.
    pipeline: { timeoutMinutes: 45 },
  },
};

function resolveGame(module: GameModule, fallback: GamePresentation): Game {
  return { ...fallback, ...stripUndefined(module) } as Game;
}

function stripUndefined(module: GameModule): GameModule {
  return Object.fromEntries(Object.entries(module).filter(([, v]) => v !== undefined)) as unknown as GameModule;
}

/** Every game, in GAME_IDS order (home page, header switcher, footer, workflow matrix). */
export const games: readonly Game[] = GAME_IDS.map((id) => resolveGame(MODULES[id], PRESENTATION[id]));

export const SITE = {
  name: 'Whetstone',
  tagline: 'Sharpen every pick.',
  description: `A free, static meta companion for ${listNames(games.map((g) => g.name))}: counters, drafts, decks and teams, with the reasons and sample sizes behind every number. Data refreshed daily.`,
  repo: 'https://github.com/JollyKrampus/whetstone',
  feedback: 'https://github.com/JollyKrampus/whetstone/issues/new/choose',
  origin: 'https://jollykrampus.github.io',
} as const;

/** "A, B and C" (or "A, B or C"). */
export function listNames(names: readonly string[], conjunction: 'and' | 'or' = 'and'): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} ${conjunction} ${names.at(-1)}`;
}

/** Every rights holder named in the games' notices, once each, in game order. */
export function rightsHolders(list: readonly Game[] = games): string[] {
  return [...new Set(list.flatMap((g) => g.legalNotice.owners))];
}

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
  return (GAME_IDS as readonly string[]).includes(value);
}

export function gameById(id: GameId): Game {
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

/**
 * Copyright notices of MIT-licensed sources whose code or data Whetstone redistributes (the
 * licence asks that the notice travels with every copy), keyed by SourceRef.id. Checked against
 * each project's LICENSE file. A SourceRef's own `copyright` field wins.
 */
const SOURCE_COPYRIGHTS: Readonly<Record<string, string>> = {
  'heroes-data2': 'Copyright (c) 2026 Kevin Oliva',
  'heroes-images': 'Copyright (c) 2019 - 2026 Kevin Oliva',
  showdown: 'Copyright (c) 2011-2026 Guangcong Luo and other contributors',
  'smogon-calc': 'Copyright (c) 2013-2025 Honko and other contributors',
  'grindstone-mcp': 'Copyright (c) 2026 Troy',
};

/** The copyright line to show and ship with a source's data, if its licence needs one. */
export function sourceCopyright(source: SourceRef): string | undefined {
  return source.copyright ?? SOURCE_COPYRIGHTS[source.id];
}

/** Every SourceRef of a game, optionally narrowed to the given ids (unknown ids are ignored). */
export function sourcesFor(game: GameId, ids?: readonly string[]): SourceRef[] {
  const all = gameById(game).sources;
  if (!ids) return [...all];
  return ids.flatMap((id) => all.filter((s) => s.id === id));
}

/**
 * Where the header's search button goes for each game: the entity grid's filter input
 * (EntityFilter renders id="search") or a dedicated search page.
 */
export function searchHref(game: GameId): string {
  return navHref(game, gameById(game).searchPath);
}

/** Human label for a data version: "Patch 2.57", "Set EOE", "Reg M-C". */
export function versionText(game: GameId, label: string): string {
  const prefix = gameById(game).versionPrefix;
  if (!prefix || label.toLowerCase().startsWith(prefix.toLowerCase())) return label;
  return `${prefix} ${label}`;
}

/** Game id owning the given pathname (with or without the base), or null for global pages. */
export function gameFromPath(pathname: string): GameId | null {
  const rest = pathname.startsWith(BASE) ? pathname.slice(BASE.length) : pathname.replace(/^\/+/, '');
  const first = rest.split('/')[0] ?? '';
  return isGameId(first) ? first : null;
}

const HEX = /^#[0-9a-f]{3,8}$/i;

/**
 * The per-game accent variables as a stylesheet (dark is the default theme; light applies to an
 * explicit choice and, before the theme script runs, to the OS preference), plus the
 * `[data-game]` scoping that points `--accent` at the current game's colour. astro.config.mjs
 * serves it as the virtual module `virtual:whetstone/accents.css`, imported by Base.astro, so
 * tokens.css never lists games.
 */
export function accentStylesheet(list: readonly Game[] = games): string {
  for (const g of list) {
    for (const c of [g.accentColors.dark, g.accentColors.light]) {
      if (!HEX.test(c)) throw new Error(`[registry] ${g.id}: accent colour ${JSON.stringify(c)} must be a hex colour`);
    }
  }
  const vars = (theme: 'dark' | 'light', indent: string): string => list.map((g) => `${indent}${g.accent}: ${g.accentColors[theme]};`).join('\n');
  return [
    ':root {',
    vars('dark', '  '),
    '}',
    ":root[data-theme='light'] {",
    vars('light', '  '),
    '}',
    '@media (prefers-color-scheme: light) {',
    '  :root:not([data-theme]) {',
    vars('light', '    '),
    '  }',
    '}',
    ...list.map((g) => `[data-game='${g.id}'] {\n  --accent: var(${g.accent});\n}`),
    '',
  ].join('\n');
}
