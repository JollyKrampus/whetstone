/**
 * Egress probe (critique U3): one GET per external host the pipeline depends on, run from a
 * GitHub-hosted runner by .github/workflows/egress-probe.yml. Prints status and content type and
 * fails when a host serves a Cloudflare (or similar) bot challenge or an unexpected status.
 *
 *   node pipeline/egress-probe.ts [--only host-substring]
 *
 * Deliberately raw: no retries and no cache, so the result shows what the runner really gets.
 */
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { userAgent } from './http.ts';

export interface Probe {
  name: string;
  url: string;
  /** Acceptable HTTP statuses. */
  expect: readonly number[];
  headers?: Record<string, string>;
  /** Do not follow redirects (the redirect itself is the answer). */
  manual?: boolean;
  /** HEAD for large downloads (the Showdown source zip); default GET. */
  method?: 'GET' | 'HEAD';
}

/**
 * Every host a pipeline fetches from (grep src/games/<game>/pipeline for URLs when adding a
 * source). github.com serves heroes-data2 releases, its Atom feed and the Showdown ref listing;
 * the release download itself is redirected to GitHub's asset CDN.
 */
export const PROBES: readonly Probe[] = [
  // Heroes of the Storm
  { name: 'Blizzard TACT (live build)', url: 'https://us.version.battle.net/v2/products/hero/versions', expect: [200] },
  { name: 'Blizzard news feed', url: 'https://news.blizzard.com/en-us/api/feed/heroes-of-the-storm?offset=0', expect: [200] },
  { name: 'GitHub heroes-data2 release', url: 'https://github.com/HeroesToolChest/heroes-data2/releases/latest', expect: [301, 302], manual: true },
  // The data job sends GITHUB_TOKEN here (1,000 requests/hour); the probe checks reachability only.
  { name: 'GitHub API', url: 'https://api.github.com/repos/HeroesToolChest/heroes-data2/releases/latest', expect: [200] },
  { name: 'raw.githubusercontent.com', url: 'https://raw.githubusercontent.com/HeroesToolChest/heroes-data2/main/heroesdata/.version.json', expect: [200] },
  { name: 'jsDelivr (heroes-images files)', url: 'https://cdn.jsdelivr.net/gh/HeroesToolChest/heroes-images/README.md', expect: [200] },
  { name: 'jsDelivr API (heroes-images tags)', url: 'https://data.jsdelivr.com/v1/packages/gh/HeroesToolChest/heroes-images', expect: [200] },
  { name: 'Nexus Compendium API', url: 'https://nexuscompendium.com/api/currently/herorotation', expect: [200] },
  { name: 'Liquipedia MediaWiki API', url: 'https://liquipedia.net/heroes/api.php?action=query&meta=siteinfo&format=json', expect: [200] },
  // Without a key the API answers 403 JSON (400 for some errors); only used when YT_API_KEY is set.
  { name: 'YouTube Data API', url: 'https://www.googleapis.com/youtube/v3/videos?part=id&id=probe', expect: [400, 403] },
  // MTG Arena
  { name: 'Scryfall bulk data', url: 'https://api.scryfall.com/bulk-data', expect: [200], headers: { accept: 'application/json' } },
  // The bulk files live below this host; its root answers 404 (a challenge would be 403/503 HTML).
  { name: 'Scryfall bulk downloads', url: 'https://data.scryfall.io/', expect: [404], method: 'HEAD' },
  { name: '17Lands public S3', url: 'https://17lands-public.s3.amazonaws.com/analysis_data/cards/cards.csv', expect: [200, 206], headers: { range: 'bytes=0-1023' } },
  // Pokémon Champions
  { name: 'Showdown source zip', url: 'https://codeload.github.com/smogon/pokemon-showdown/zip/refs/heads/master', expect: [200], method: 'HEAD' },
  { name: 'Limitless play API', url: 'https://play.limitlesstcg.com/api/tournaments?game=VGC&limit=1', expect: [200] },
  { name: 'Showdown replays', url: 'https://replay.pokemonshowdown.com/search.json?format=gen9championsvgc2026regmcbo3', expect: [200] },
  { name: 'Smogon stats', url: 'https://www.smogon.com/stats/', expect: [200] },
  { name: 'Showdown client data and sprites', url: 'https://play.pokemonshowdown.com/data/pokedex.json', expect: [200, 206], headers: { range: 'bytes=0-4095' } },
];

export interface ProbeResult {
  name: string;
  host: string;
  status: number;
  contentType: string;
  ms: number;
  ok: boolean;
  challenge: boolean;
  note: string;
}

/** Heuristics for interstitial bot checks (Cloudflare managed challenge, JS challenge, Akamai/Imperva blocks). */
export function looksLikeChallenge(status: number, headers: Headers, body: string): boolean {
  if (headers.get('cf-mitigated') === 'challenge') return true;
  if (status !== 403 && status !== 503 && status !== 429) return false;
  return /just a moment|challenge-platform|cf-chl|attention required|cf-browser-verification|_incapsula_|access denied/i.test(body);
}

export async function runProbe(p: Probe, ua: string, fetchImpl: typeof fetch = fetch): Promise<ProbeResult> {
  const host = new URL(p.url).host;
  const started = Date.now();
  try {
    const res = await fetchImpl(p.url, {
      method: p.method ?? 'GET',
      headers: { 'user-agent': ua, ...p.headers },
      redirect: p.manual ? 'manual' : 'follow',
      signal: AbortSignal.timeout(20_000),
    });
    const body = await res.text();
    const challenge = looksLikeChallenge(res.status, res.headers, body);
    const ok = !challenge && p.expect.includes(res.status);
    const note = challenge ? 'bot challenge' : ok ? '' : `expected ${p.expect.join('/')}`;
    return { name: p.name, host, status: res.status, contentType: res.headers.get('content-type') ?? '', ms: Date.now() - started, ok, challenge, note };
  } catch (err) {
    const msg = err instanceof Error ? (err.cause instanceof Error ? `${err.message}: ${err.cause.message}` : err.message) : String(err);
    return { name: p.name, host, status: 0, contentType: '', ms: Date.now() - started, ok: false, challenge: false, note: msg };
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({ options: { only: { type: 'string' } }, strict: true });
  const ua = userAgent(process.env.WHETSTONE_CONTACT ?? process.env.LIQUIPEDIA_UA_CONTACT);
  const probes = PROBES.filter((p) => !values.only || p.url.includes(values.only));
  const results: ProbeResult[] = [];
  // One host at a time; this is a courtesy check, not a load test.
  for (const p of probes) {
    const r = await runProbe(p, ua);
    results.push(r);
    console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${String(r.status).padEnd(3)} ${r.host.padEnd(36)} ${r.contentType.padEnd(32)} ${String(r.ms).padStart(5)} ms ${r.note}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((r) => `| ${r.ok ? 'ok' : '**FAIL**'} | ${r.name} | \`${r.host}\` | ${r.status} | ${r.contentType} | ${r.ms} | ${r.note} |`);
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, ['### Egress probe', '', '| | source | host | status | content-type | ms | note |', '|---|---|---|---|---|---|---|', ...rows, ''].join('\n') + '\n');
  }
  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) console.error(`\n${failed.length} host(s) failed: ${failed.map((r) => r.host).join(', ')}`);
  return failed.length > 0 ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
