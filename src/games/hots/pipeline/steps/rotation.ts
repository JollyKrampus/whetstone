/**
 * nexus-compendium step: the weekly free hero rotation and the ranked season (rotation.json),
 * attributed and dated ("as of"). The source switches hours to a day after the game does, so a
 * rotation whose window already ended is kept with a warning and a status detail.
 */
import { RotationSchema, type Rotation } from '../../schema.ts';
import { fetchRotation } from '../sources/nexusCompendium.ts';
import type { HeroInput } from '../transform/heroes.ts';
import { buildHeroIndex } from '../transform/patches.ts';
import { buildRotation, stableRotation } from '../transform/rotation.ts';
import { warn } from '../util.ts';
import { previousFile, selected, setFallback, setNotSelected, setOk, type RunEnv } from './common.ts';

export async function runRotation(env: RunEnv, heroes: readonly HeroInput[]): Promise<Rotation | null> {
  const previous = await previousFile(env, 'rotation.json', RotationSchema);
  if (!selected(env, 'nexus-compendium')) {
    setNotSelected(env, 'nexus-compendium');
    return previous;
  }
  try {
    const raw = await fetchRotation(env.ctx.http);
    const built = buildRotation(raw, buildHeroIndex(heroes), env.nowIso, env.today);
    env.issues.push(...built.issues);
    if (built.rotation.heroes.length === 0 && !built.rotation.allFree) throw new Error('rotation lists no known heroes');
    const rotation = stableRotation(built.rotation, previous);
    if (built.lagging) {
      env.issues.push(warn(`nexus-compendium: the rotation it reports ended on ${built.rotation.end}; it has not switched to the new week yet`, 'nexus-compendium'));
      setOk(env, 'nexus-compendium', `rotation not yet updated upstream (window ended ${built.rotation.end})`);
    } else {
      setOk(env, 'nexus-compendium');
    }
    return rotation;
  } catch (err) {
    setFallback(env, 'nexus-compendium', err, previous !== null, 'rotation.json');
    return previous;
  }
}
