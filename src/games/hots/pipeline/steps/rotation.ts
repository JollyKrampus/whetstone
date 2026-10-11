/**
 * nexus-compendium step: the weekly free hero rotation and the ranked season (rotation.json),
 * attributed and dated ("as of"). The source switches hours to a day after the game does, so a
 * rotation whose window already ended is kept with a warning, a status detail and `lagging: true`
 * (also when the source is down and last-good data is re-emitted), which tells the site to show
 * no hero as free until the new week arrives.
 */
import { RotationSchema, type Rotation } from '../../schema.ts';
import { fetchRotation } from '../sources/nexusCompendium.ts';
import type { HeroInput } from '../transform/heroes.ts';
import { buildHeroIndex } from '../transform/patches.ts';
import { buildRotation, markLagging, stableRotation } from '../transform/rotation.ts';
import { warn } from '../util.ts';
import { previousFile, selected, setFallback, setNotSelected, setOk, type RunEnv } from './common.ts';

export async function runRotation(env: RunEnv, heroes: readonly HeroInput[]): Promise<Rotation | null> {
  const previous = await previousFile(env, 'rotation.json', RotationSchema);
  const lastGood = previous ? markLagging(previous, env.today) : null;
  if (!selected(env, 'nexus-compendium')) {
    setNotSelected(env, 'nexus-compendium');
    return lastGood;
  }
  try {
    const raw = await fetchRotation(env.ctx.http);
    const built = buildRotation(raw, buildHeroIndex(heroes), env.nowIso, env.today);
    env.issues.push(...built.issues);
    if (built.rotation.heroes.length === 0 && !built.rotation.allFree) throw new Error('rotation lists no known heroes');
    const rotation = markLagging(stableRotation(built.rotation, previous), env.today);
    if (built.lagging) {
      env.issues.push(warn(`nexus-compendium: the rotation it reports ended on ${built.rotation.end}; it has not switched to the new week yet`, 'nexus-compendium'));
      setOk(env, 'nexus-compendium', `rotation not yet updated upstream (window ended ${built.rotation.end})`);
    } else {
      setOk(env, 'nexus-compendium');
    }
    return rotation;
  } catch (err) {
    setFallback(env, 'nexus-compendium', err, previous !== null, 'rotation.json');
    return lastGood;
  }
}
