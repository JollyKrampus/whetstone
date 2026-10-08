import type { CardIndex } from './core/cards.js';
import { ensureIndex } from './data/bulk.js';
import { cacheDir, configDir } from './data/paths.js';
import { type FetchLike, ScryfallClient } from './data/scryfall.js';

/** Everything tools need from the outside world, injectable for tests. */
export interface Context {
  getIndex(): Promise<CardIndex>;
  scryfall: ScryfallClient;
  /** Plain fetch for non-Scryfall downloads (the Comprehensive Rules). */
  fetch: FetchLike;
  /** False disables network calls (bulk refresh, fuzzy lookups, rules download). */
  online: boolean;
  cacheDir: string;
  configDir: string;
  log(msg: string): void;
}

export function defaultContext(): Context {
  const scryfall = new ScryfallClient();
  const online = process.env.GRINDSTONE_OFFLINE !== '1';
  const dir = cacheDir();
  const log = (msg: string) => process.stderr.write(`${msg}\n`);
  let pending: Promise<CardIndex> | undefined;
  return {
    scryfall,
    fetch: (url, init) => fetch(url, init),
    online,
    cacheDir: dir,
    configDir: configDir(),
    log,
    getIndex() {
      pending ??= ensureIndex({ client: scryfall, dir, offline: !online, log }).catch((err) => {
        pending = undefined;
        throw err;
      });
      return pending;
    },
  };
}
