/**
 * Build-time (Node) check of which game nav entries already have a real page. Every nav entry
 * must resolve (the e2e smoke test visits them all), so src/pages/[game]/[...section].astro
 * renders a placeholder for the ones that don't. A game claims its section simply by adding
 * src/pages/<game>/<section>.astro or src/pages/<game>/<section>/index.astro; the placeholder
 * then stops being generated, so the two never collide.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { GameId, GameModule } from '../core/game.ts';
import { games as allGames } from '../games/registry.ts';
import { repoRoot } from './datadir.ts';

/** Page file extensions Astro routes from src/pages/. */
const PAGE_EXTENSIONS = ['.astro', '.md', '.mdx', '.html', '.ts', '.js'];

export interface PendingSection {
  game: GameId;
  /** Nav path without the trailing slash, e.g. 'maps' (the [...section] param). */
  section: string;
  label: string;
}

/** True when src/pages/ has a static page file for /<game>/<section>/. */
export function hasPage(root: string, game: GameId, section: string): boolean {
  const base = path.join(root, 'src', 'pages', game, ...section.split('/'));
  return PAGE_EXTENSIONS.some((ext) => existsSync(`${base}${ext}`) || existsSync(path.join(base, `index${ext}`)));
}

/** Nav entries (other than each game's home) that no page file serves yet, in nav order. */
export function pendingSections(root: string = repoRoot(), games: readonly GameModule[] = allGames): PendingSection[] {
  return games.flatMap((game) =>
    game.nav
      .map((item) => ({ game: game.id, section: item.path.replace(/^\/+|\/+$/g, ''), label: item.label }))
      .filter((s) => s.section !== '' && !hasPage(root, s.game, s.section)),
  );
}
