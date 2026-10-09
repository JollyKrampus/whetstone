/**
 * youtube step (class C, gated on YT_API_KEY): recent uploads of the curated creators
 * (curated/hots/creators.yaml) as videos.json. Artifact only, fetched fresh every run, never
 * carried over: without the key the source is 'disabled'; on failure there is no file.
 */
import type { GameMap, Videos } from '../../schema.ts';
import type { PipelineCurated } from '../curated.ts';
import { fetchUploads } from '../sources/youtube.ts';
import type { HeroInput } from '../transform/heroes.ts';
import { buildVideos, type MatchTarget } from '../transform/videos.ts';
import { errorMessage, status, warn } from '../util.ts';
import { setStatus, type RunEnv } from './common.ts';

/** Draftable entities as match targets (members' names point at their composite). */
export function heroTargets(heroes: readonly HeroInput[]): MatchTarget[] {
  const names = new Map<string, string[]>();
  for (const h of heroes) {
    const id = h.memberOf ?? h.id;
    names.set(id, [...(names.get(id) ?? []), h.name, h.slug, ...h.aliases]);
  }
  return [...names].map(([id, list]) => ({ id, names: list }));
}

export function mapTargets(maps: readonly GameMap[], aliases: Readonly<Record<string, readonly string[]>>): MatchTarget[] {
  return maps.map((m) => ({ id: m.id, names: [m.name, ...(aliases[m.id] ?? [])] }));
}

export async function runYoutube(env: RunEnv, input: { heroes: readonly HeroInput[]; maps: readonly GameMap[]; curated: PipelineCurated }): Promise<Videos | null> {
  const key = env.ctx.secrets.YT_API_KEY;
  if (!key) {
    setStatus(env, 'youtube', 'disabled', 'YT_API_KEY not set');
    return null;
  }
  if (env.ctx.offline) {
    setStatus(env, 'youtube', 'disabled', 'offline run (YouTube data is never recorded)');
    return null;
  }
  const channels = input.curated.creators.creators.map((c) => c.youtube?.channelId).filter((x): x is string => Boolean(x));
  try {
    const raw = await fetchUploads(env.ctx.http, key, channels);
    const videos = buildVideos({
      raw,
      creators: input.curated.creators,
      heroes: heroTargets(input.heroes),
      maps: mapTargets(input.maps, input.curated.aliases.maps),
      fetchedAt: env.nowIso,
    });
    setStatus(env, 'youtube', 'ok', `${videos.videos.length} videos from ${channels.length} channels`);
    return videos;
  } catch (err) {
    env.issues.push(warn(`youtube: ${errorMessage(err)}; no videos this run`, 'youtube'));
    env.statuses.set('youtube', status('youtube', 'failed', null, errorMessage(err).slice(0, 300)));
    return null;
  }
}
