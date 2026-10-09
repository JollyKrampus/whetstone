/** Nexus Compendium (network only): the free hero rotation and ranked season, one call a day. */
import type { Http } from '../../../../core/game.ts';

export const ROTATION_URL = 'https://nexuscompendium.com/api/currently/herorotation+ranked';

export function fetchRotation(http: Http): Promise<unknown> {
  return http.json<unknown>(ROTATION_URL, { fixture: 'nexus-compendium/currently', ttlHours: 3 });
}
