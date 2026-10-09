# Whetstone

> *Grindstone tunes the deck. Whetstone sharpens every pick.*

Whetstone is a free, static, multi-game **meta companion**: counters, drafts, tier lists, deck and team tools, each with the reasons behind every recommendation and an honest sample size. It is a plain static site on GitHub Pages. A daily GitHub Actions job refreshes the data, validates it, keeps history and redeploys. There is no server, no account, no ads and no tracking.

**Site:** https://jollykrampus.github.io/whetstone/

| Game | Route | What you get |
|---|---|---|
| Heroes of the Storm | `/hots/` | Data-driven hero grid (search by name or nickname, role/franchise filters, free rotation, your owned heroes and favourites). Hero pages with strong against / weak against / good with lists, best maps, talents, abilities, patch history and guides: statistics when licensed Heroes Profile data is enabled, otherwise the theory layer, which reads every ability and talent and adds hand-checked matchups ([docs/THEORY.md](docs/THEORY.md)). Map pages, true-order Storm League draft helper with pick/ban suggestions, role guardrails and share links, free-mode draft, ARAM pick-1-of-3 helper, tier list (pro presence and patch momentum until statistics exist), patch notes, "catch up since you last played", pro presence from Liquipedia, live/creator links. heroescounters.com-style URLs (`/hots/hero/li-ming/`, `/hots/map/cursedhollow/`) redirect. |
| MTG Arena | `/mtga/` | Deck analyzer on [grindstone-mcp](https://github.com/JollyKrampus/grindstone-mcp)'s core, running in your browser: legality in every Arena format, curve, mana, roles, power tier with its breakdown, sample hands and mulligan simulation, wildcard cost, budget upgrades with undo, comparison with curated or your own meta lists, share links. 17Lands Limited ratings per set and format, Scryfall-style card search, meta lists. |
| Pokémon Champions | `/pokemon/` | Regulation M-C VGC Doubles: usage meta with regulation countdown, tier list, Pokémon pages (Stat Points, usage, sets, teammates, checks), team builder with Showdown paste import/export (EVs converted to Stat Points), legality, type matrix, coverage and threat list, damage calc (@smogon/calc in a worker), speed tiers with Tailwind/Trick Room/Scarf, Limitless tournament teams, team-preview assistant (bring 4, leads). |

<!-- Screenshots: add images under docs/img/ once the first deploy is live. -->
*Screenshots: coming with the first public deploy.*

## How it works

```
sources ──► data job per game (pipeline/run.ts) ──► data branch (open data + history)
                                     │                         │
                                     └─ private B/C artifact ──┴─► build (stage + astro) ──► GitHub Pages
```

- `src/games/<game>/pipeline/` fetches and transforms one game's sources; `pipeline/run.ts` validates, writes and hashes the result and keeps the last good data when anything fails.
- The public, orphan `data` branch holds `current/<game>/` (open data), `history/YYYY/MM/DD/<game>.json.gz` and `status.json`.
- `pipeline/stage.ts` copies browser shards into `public/data/<game>/` under content-hashed names and writes `public/data/manifest.json`.
- Astro builds every page statically; interactive tools are Preact islands. A Workbox service worker keeps the site usable offline.

### CI and the daily data run

- **CI** (`.github/workflows/ci.yml`, every push and pull request): lint, type-check (`astro check` plus `tsc` with Node's own resolution for the pipelines), unit tests, the HotS theory validator, a build from the committed `fixtures/`, the Playwright suite, then a second build in statistics mode (`WHETSTONE_FIXTURE_PRIVATE=1`, synthetic Heroes Profile samples) with the HotS page, draft and ARAM specs against it. No secrets, no network data.
- **Data + Deploy** (`.github/workflows/data-deploy.yml`, daily at 10:17 UTC, on push to `main` and by hand): one data job per game (`node pipeline/run.ts --game <game>` with the workflow's own `GITHUB_TOKEN` for GitHub API calls and any optional secrets), a publish job that commits open data to the `data` branch, a build job that restores it (plus the short-lived encrypted class-B artifact when Heroes Profile is on), stages and builds the site, then deploy to GitHub Pages and a report job that opens or closes a `pipeline-failure` issue. Pushes rebuild from the `data` branch without fetching.
- **Egress probe** (`.github/workflows/egress-probe.yml`, by hand): one request to every host the pipelines contact, to check that GitHub's runners are not blocked.

The full contract is in [docs/SPEC.md](docs/SPEC.md). Data layout, licences and retention rules are in [docs/DATA.md](docs/DATA.md).

### Data custody classes

| Class | What | Where it lives |
|---|---|---|
| **A**, open / own | Our own derivations and openly licensed inputs (heroes-data2, Blizzard patch summaries, 17Lands-derived ratings, Smogon/Limitless/Showdown aggregates, curated files) | Public `data` branch, documented JSON |
| **A-SA**, share-alike | Liquipedia-derived pro data (CC-BY-SA 3.0) | Public `data` branch, separate files |
| **B**, licensed | Heroes Profile statistics | Never committed. Fetched fresh each run, shipped only inside the site under hashed names, behind the `HP_MODE` kill switch (off by default) |
| **C**, ephemeral | Twitch and YouTube metadata | Never committed. Shipped only inside the site; the browser hides it after its retention window |

Player names from tournament or replay sources are stripped at ingest; only aggregates are published.

## Local development

Requirements: Node 24 or newer (see `.node-version`), npm, git.

```sh
npm ci
npm run dev            # http://localhost:4321/whetstone/
```

The site reads game data from, per game: `$WHETSTONE_DATA_DIR/current/<game>`, then `data/current/<game>`, then the committed `fixtures/<game>`. A fresh clone therefore works offline with fixtures. Browser shards are staged by `node pipeline/stage.ts`; `npm run build` and `npm run dev` run it first. With a `data/` directory present, `WHETSTONE_FIXTURES=1` builds from fixtures anyway (what CI does), and `WHETSTONE_FIXTURE_PRIVATE=1` adds the synthetic statistics samples.

| Command | What it does |
|---|---|
| `npm run data` | Run every game's pipeline against the live sources into `data/` (uses a disk cache in `.cache/http`) |
| `npm run data -- --game hots --only blizzard` | One game, only some sources (games keep last-good data for the rest) |
| `npm run data:offline` | Same, but every request is served from recorded fixtures in `src/games/<game>/fixtures/raw/` |
| `npm run data:pull` | Copy the published `data` branch into `data/` (no keys needed) |
| `WHETSTONE_DATA_DIR=data npm run build` | Build the site from `data/` (the default when it exists) |
| `node src/games/hots/theory/validate.ts` | Check the curated HotS theory files (with `data/` present, also against the live roster and kits) |
| `node src/games/hots/fixtures/make-fixtures.ts` | Rebuild `fixtures/hots` from a live run in `data/` (same small cast, real kits and theory) |
| `npm run sync:grindstone` | Refresh `vendor/grindstone/` from a local grindstone-mcp checkout (see below) |
| `npm run build` | Stage data, build the static site into `dist/`, generate the service worker |
| `npm run preview` | Serve `dist/` |

Optional credentials for `npm run data` go in a local `.env` file (git-ignored), for example `HP_MODE=on` with `HP_API_KEY=...`, `YT_API_KEY=...`, `TWITCH_CLIENT_ID=...`, `TWITCH_CLIENT_SECRET=...`, and `LIQUIPEDIA_UA_CONTACT=you@example.com` (added to the User-Agent). Every source degrades gracefully when its credential is missing.

To record new fixtures for offline runs and tests: `WHETSTONE_RECORD=1 npm run data -- --game <game>`. Recorded responses land in `src/games/<game>/fixtures/raw/`; trim large ones before committing.

## Testing

```sh
npm run lint
npm run check          # astro check + tsc (Node resolution) for pipeline/, scripts/ and the game pipelines
npm test               # vitest; always reads fixtures/ (WHETSTONE_FIXTURES=1), never the network
npx playwright install chromium
npm run build && npm run e2e   # Playwright serves dist/ with astro preview on SMOKE_PORT (default 4321)

# statistics mode, as in CI
WHETSTONE_FIXTURE_PRIVATE=1 WHETSTONE_OUT_DIR=.cache/dist-stats npm run build
WHETSTONE_FIXTURE_PRIVATE=1 WHETSTONE_OUT_DIR=.cache/dist-stats SMOKE_PORT=4322 npx playwright test e2e/hots-pages.spec.ts e2e/hots-draft.spec.ts
```

Playwright never reuses a server it did not start (unless `SMOKE_REUSE=1`), and `e2e/global-setup.ts` checks that the server on `SMOKE_PORT` really serves the build under test: if the port is taken, pick another `SMOKE_PORT`.

## grindstone-mcp

The MTGA deck analyzer runs grindstone-mcp's browser-safe core. Until grindstone-mcp is published to npm, a build of it is vendored in `vendor/grindstone/` (with a `VERSION` file recording the source commit) and imported as `#vendor/grindstone/core.js`.

```sh
# in the grindstone-mcp repo: npm run build
npm run sync:grindstone                      # default source: ~/grindstone-mcp
npm run sync:grindstone -- --from ../grindstone-mcp
```

Once grindstone-mcp 0.2.0 is on npm, switch to the package: add `"grindstone-mcp": "^0.2.0"` to `dependencies`, replace `#vendor/grindstone/core.js` imports with `grindstone-mcp/core`, delete `vendor/grindstone/` and the `sync:grindstone` script, and let Dependabot propose updates.

## Deploying your own copy

1. Push the repository to GitHub (public).
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. Run the **Egress probe** workflow once to check that every data source answers GitHub's runners.
4. Run **Data + Deploy** with *Run workflow*. The first run creates the `data` branch and deploys the site; after that it runs daily at 10:17 UTC and on every push to `main`.
5. Optional: add secrets and variables as described in [docs/OWNER-ACTIONS.md](docs/OWNER-ACTIONS.md), which lists every owner-only step (publishing, Heroes Profile permission and keys, optional sources, open decisions).

Failures open (and recoveries close) an issue labelled `pipeline-failure`. The site always keeps serving the last good data.

## Credits

Whetstone is built on the work of others. Each page credits the sources whose data it shows; the full list is on the site's credits page.

- Heroes of the Storm game data and images: [HeroesToolChest](https://github.com/HeroesToolChest) heroes-data2 and heroes-images (MIT); patch notes from Blizzard Entertainment; free rotation from [Nexus Compendium](https://nexuscompendium.com); pro drafts from [Liquipedia](https://liquipedia.net/heroes/) (CC-BY-SA 3.0); statistics, when enabled, provided by [Heroes Profile](https://www.heroesprofile.com).
- MTG Arena: card data and images from [Scryfall](https://scryfall.com); Limited data from [17Lands](https://www.17lands.com/public_datasets) (CC BY 4.0); analysis engine from [grindstone-mcp](https://github.com/JollyKrampus/grindstone-mcp) (MIT).
- Pokémon Champions: [Pokémon Showdown](https://github.com/smogon/pokemon-showdown) data (MIT), [Smogon](https://www.smogon.com/stats/) usage statistics, [Limitless](https://play.limitlesstcg.com) tournament results, and [@smogon/calc](https://github.com/smogon/damage-calc) (MIT).

Whetstone is a non-commercial fan project. It is not affiliated with or endorsed by Blizzard Entertainment, Wizards of the Coast, The Pokémon Company, Nintendo, Game Freak, heroescounters.com or Heroes Profile. Heroes of the Storm is a trademark of Blizzard Entertainment, Inc. Magic: The Gathering is a trademark of Wizards of the Coast LLC; Whetstone is unofficial Fan Content permitted under the Fan Content Policy. Pokémon is a trademark of Nintendo, Creatures Inc. and GAME FREAK inc.

## Licence

Code: [MIT](LICENSE). Data on the `data` branch keeps the licence of its sources (see [docs/DATA.md](docs/DATA.md)); Liquipedia-derived files are CC-BY-SA 3.0.
