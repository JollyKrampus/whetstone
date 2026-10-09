/** Blizzard TACT version server (network only; parsing in transform/tact.ts). */
import type { Http } from '../../../../core/game.ts';
import { tactBuild } from '../transform/tact.ts';
import { compareBuilds } from '../util.ts';

export const TACT_LIVE_URL = 'https://us.version.battle.net/v2/products/hero/versions';
export const TACT_PTR_URL = 'https://us.version.battle.net/v2/products/herot/versions';

export interface TactBuilds {
  live: string;
  /** Active PTR build (only when newer than live). */
  ptr: string | null;
  ptrError?: string;
}

export async function fetchTact(http: Http): Promise<TactBuilds> {
  const live = tactBuild(await http.text(TACT_LIVE_URL, { fixture: 'tact/hero-versions', ttlHours: 1 }));
  try {
    const ptr = tactBuild(await http.text(TACT_PTR_URL, { fixture: 'tact/herot-versions', ttlHours: 1 }));
    return { live, ptr: compareBuilds(ptr, live) > 0 ? ptr : null };
  } catch (err) {
    return { live, ptr: null, ptrError: err instanceof Error ? err.message : String(err) };
  }
}
