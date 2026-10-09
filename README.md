# Whetstone

> *Grindstone tunes the deck. Whetstone sharpens every pick.*

Whetstone is a free, static, multi-game **meta companion**: counters, drafts, tier lists, deck and team tools, each with the reasons behind every recommendation and an honest sample size. It is a plain static site on GitHub Pages. A daily GitHub Actions job refreshes the data, validates it, keeps history and redeploys. There is no server, no account, no ads and no tracking.

**Site:** https://jollykrampus.github.io/whetstone/

| Game | Route | What you get |
|---|---|---|
| Heroes of the Storm | `/hots/` | Hero and map pages with counters and synergies (statistics when licensed data is enabled, mechanics-based theory otherwise), true-order Storm League draft with pick/ban suggestions and role guardrails, tier list, patch notes and "catch up since you last played", ARAM pick helper, pro presence. |
| MTG Arena | `/mtga/` | Paste an Arena deck for legality, curve, mana, power tier, sample hands, wildcard cost and budget upgrades (on [grindstone-mcp](https://github.com/JollyKrampus/grindstone-mcp)'s core), 17Lands Limited ratings, card search, curated meta. |
| Pokémon Champions | `/pokemon/` | VGC Doubles meta, Pokémon pages, team builder with Showdown paste import/export, damage calc, speed tiers, tournament teams, team-preview assistant. |

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
- Astro builds every page statically; interactive tools are Preact islands.

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

The site reads game data from, per game: `$WHETSTONE_DATA_DIR/current/<game>`, then `data/current/<game>`, then the committed `fixtures/<game>`. A fresh clone therefore works offline with fixtures. Browser shards are staged by `node pipeline/stage.ts`; `npm run build` and `npm run dev` run it first.

| Command | What it does |
|---|---|
| `npm run data` | Run every game's pipeline against the live sources into `data/` (uses a disk cache in `.cache/http`) |
| `npm run data -- --game hots --only blizzard` | One game, only some sources (games keep last-good data for the rest) |
| `npm run data:offline` | Same, but every request is served from recorded fixtures in `src/games/<game>/fixtures/raw/` |
| `npm run data:pull` | Copy the published `data` branch into `data/` (no keys needed) |
| `npm run sync:grindstone` | Refresh `vendor/grindstone/` from a local grindstone-mcp checkout (see below) |
| `npm run build` | Stage data, build the static site into `dist/`, generate the service worker |
| `npm run preview` | Serve `dist/` |

Optional credentials for `npm run data` go in a local `.env` file (git-ignored), for example `HP_MODE=on` with `HP_API_KEY=...`, `YT_API_KEY=...`, `TWITCH_CLIENT_ID=...`, `TWITCH_CLIENT_SECRET=...`, and `LIQUIPEDIA_UA_CONTACT=you@example.com` (added to the User-Agent). Every source degrades gracefully when its credential is missing.

To record new fixtures for offline runs and tests: `WHETSTONE_RECORD=1 npm run data -- --game <game>`. Recorded responses land in `src/games/<game>/fixtures/raw/`; trim large ones before committing.

## Testing

```sh
npm run lint
npm run check          # astro check + tsc for pipeline/ and scripts/
npm test               # vitest (unit tests never touch the network)
npx playwright install chromium
npm run build && npm run e2e   # Playwright smoke serves dist/ with astro preview
```

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
5. Optional: add secrets and variables as described in [docs/OWNER-ACTIONS.md](docs/OWNER-ACTIONS.md).

Failures open (and recoveries close) an issue labelled `pipeline-failure`. The site always keeps serving the last good data.

## Credits

Whetstone is built on the work of others. Each page credits the sources whose data it shows; the full list is on the site's credits page.

- Heroes of the Storm game data and images: [HeroesToolChest](https://github.com/HeroesToolChest) heroes-data2 and heroes-images (MIT); patch notes from Blizzard Entertainment; free rotation from [Nexus Compendium](https://nexuscompendium.com); pro drafts from [Liquipedia](https://liquipedia.net/heroes/) (CC-BY-SA 3.0); statistics, when enabled, provided by [Heroes Profile](https://www.heroesprofile.com).
- MTG Arena: card data and images from [Scryfall](https://scryfall.com); Limited data from [17Lands](https://www.17lands.com/public_datasets) (CC BY 4.0); analysis engine from [grindstone-mcp](https://github.com/JollyKrampus/grindstone-mcp) (MIT).
- Pokémon Champions: [Pokémon Showdown](https://github.com/smogon/pokemon-showdown) data (MIT), [Smogon](https://www.smogon.com/stats/) usage statistics, [Limitless](https://play.limitlesstcg.com) tournament results, and [@smogon/calc](https://github.com/smogon/damage-calc) (MIT).

Whetstone is a non-commercial fan project. It is not affiliated with or endorsed by Blizzard Entertainment, Wizards of the Coast, The Pokémon Company, Nintendo, Game Freak, heroescounters.com or Heroes Profile. Heroes of the Storm is a trademark of Blizzard Entertainment, Inc. Magic: The Gathering is a trademark of Wizards of the Coast LLC; Whetstone is unofficial Fan Content permitted under the Fan Content Policy. Pokémon is a trademark of Nintendo, Creatures Inc. and GAME FREAK inc.

## Licence

Code: [MIT](LICENSE). Data on the `data` branch keeps the licence of its sources (see [docs/DATA.md](docs/DATA.md)); Liquipedia-derived files are CC-BY-SA 3.0.
