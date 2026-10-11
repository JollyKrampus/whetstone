# Whetstone data

How Whetstone's data is produced, where each file lives, who may see it, how it is credited, and how long it is kept. The contract behind this is [SPEC.md](SPEC.md) §1, §4 and §10; schemas live in `src/games/<game>/schema.ts`.

## 1. Custody classes

Every file a pipeline writes declares one class (`OutputFile.custody`). The runner (`pipeline/run.ts`) routes it accordingly.

| Class | Meaning | Written to | Committed? | Public? |
|---|---|---|---|---|
| **A** | Our own derivations and openly licensed inputs | `current/<game>/` | Yes, `data` branch | Yes, documented JSON |
| **A-SA** | Share-alike (Liquipedia CC-BY-SA 3.0, other CC BY-SA wikis) | `current/<game>/`, **separate files** | Yes, `data` branch | Yes, labelled with the licence |
| **A-NC-SA** | Non-commercial share-alike (CC BY-NC-SA wikis) | `current/<game>/`, **separate files** | Yes, `data` branch | Yes, labelled; never for commercial use |
| **B** | Licensed for display only (no such source today) | `private/<game>/` | **Never** | Only inside the deployed site, under content-hashed names; never listed in any manifest |
| **C** | Ephemeral metadata (YouTube video details) | `private/<game>/` | **Never** | Only inside the deployed site; the browser hides it after its retention window |
| **D** | Aggregates derived from public posts (our own wording, links only) | `private/<game>/` | **Never** | Only inside the deployed site; rebuilt every run |
| **P** | Personal match records | Never produced here | **Never** | Never; they live only in the private hub. The runner rejects any P output |

Whetstone owns its tooling: everything it shows comes from first-party game data, openly licensed data, our own curation and our own analysis. It uses no third-party statistics aggregator.

Rules that follow from this:

- B, C and D never enter git, the `data` branch, history files or the public manifest.
- A-SA and A-NC-SA content is never mixed into a file of another class (history summaries list such files by hash only).
- Player names and handles from Limitless or Showdown are removed at ingest; only aggregates and anonymised teams are written. Recorded test fixtures get the same treatment: record mode scrubs standings, replay searches and battle logs to placeholders ("Player 1", "Player A") before saving, never records class-C hosts or requests marked `noRecord`, and `pipeline/fixture-privacy.test.ts` checks every committed fixture.
- Class B files only leave a data job encrypted (section 7).

## 2. Layout

### The `data` branch (public, orphan)

```
current/<game>/            last good data per game (A and A-SA only)
  meta.json                GameMeta (src/core/game.ts) + dataHash
  _files.json              custody index: every file's class, size and sha256 (img/** summarised)
  ...                      game files (section 4)
  public/*.json            browser shards, staged by pipeline/stage.ts
  img/**                   WebP portraits and icons
history/YYYY/MM/DD/<game>.json.gz   daily summary (below)
status.json                last run per game
README.md                  pointer to this document
LICENSE                    MIT, for Whetstone's own data (third-party data keeps its licence)
NOTICE.md                  every source with its licence, required credit and copyright notice
```

`pipeline/publish.ts` rewrites `README.md`, `LICENSE` and `NOTICE.md` on every run; `NOTICE.md` is generated from the sources in `src/games/registry.ts`, so a new game or source appears in it on its own.

`npm run data:pull` copies `current/` and `status.json` into your local `data/`.

### A local or CI data directory (`--out data`)

The same as the branch plus `private/<game>/` (B and C files and their own `_files.json`). `data/` is git-ignored.

### Build-time resolution

Per game, the site reads the first directory that has a `meta.json`: `$WHETSTONE_DATA_DIR/current/<game>`, `data/current/<game>`, `fixtures/<game>` (`src/lib/datadir.ts`; `pipeline/stage.ts` uses the same order).

- `WHETSTONE_FIXTURES=1` skips `data/current/<game>` (an explicit `WHETSTONE_DATA_DIR` still wins). Vitest sets it, so a local pipeline run never changes test results, and `WHETSTONE_FIXTURES=1 npm run build` gives a CI-parity build next to a live `data/` directory.
- Private (B/C) files pair with the chosen directory: `<root>/private/<game>` next to `<root>/current/<game>`. A fixture build never reads `data/private`; with `WHETSTONE_FIXTURE_PRIVATE=1` it uses the synthetic samples in `fixtures/<game>/_private/` instead, including the overlays under `_private/public/` (section 5).

## 3. Files the runner maintains

### `meta.json`

`GameMeta` from the game's `PipelineResult.meta`, plus:

- `generatedAt`: time of the successful run that produced the data.
- `dataHash`: sha256 over every file in `current/<game>/` and `private/<game>/` (path and content hash, in path order, namespaced `current/` / `private/`) plus `meta.json` itself without `generatedAt`, `dataHash` and each source's `fetchedAt`. The same inputs always give the same hash, so a run that only moves the clock reports `changed=false`.

### `_files.json`

```json
{ "schema": 1,
  "files": { "heroes.json": { "custody": "A", "bytes": 812345, "sha256": "…" }, "pro.json": { "custody": "A-SA", … } },
  "img": { "files": 2311, "bytes": 9876543, "sha256": "…" } }
```

The authoritative per-file custody list. `pipeline/private.ts` uses the private copy to decide what may leave a runner.

### `status.json`

```json
{ "schema": 1, "updatedAt": "2026-10-08T10:31:02.000Z",
  "games": { "hots": { "state": "ok", "checkedAt": "…", "generatedAt": "…", "dataHash": "…", "changed": true,
                       "durationMs": 81234, "files": { "current": 61, "private": 1 },
                       "sources": [ { "id": "heroes-data2", "fetchedAt": "…", "status": "ok" } ],
                       "issues": [] } } }
```

`state` is `ok`, `failed` (last good data kept; sources marked `failed` or `stale`) or `skipped` (no pipeline module yet). Issues are capped at 50 per game. An `ok` game whose sources partly served last-good data lists them in `degraded`, and the publish job adds `degradedRuns` (source id → consecutive runs it has been degraded); section 8 says what happens next.

### History summaries

`history/YYYY/MM/DD/<game>.json.gz` (UTC date, deterministic gzip): `{ schema, game, date, meta, files, omitted, img? }`. `files` holds the content of small class-A JSON files (not `public/`, at most 64 KiB each; `--history-max-kb` changes the limit, `--no-history` turns it off); `omitted` lists every other A or A-SA file by size and sha256. B and C never appear.

### Write rules

- JSON is written with sorted keys and a trailing newline: indented for data files, compact for `public/` shards.
- Files a game stops emitting are deleted from `current/<game>/`.
- **`img/` rule:** images are expensive to regenerate, so games emit `img/**` only when their asset source changes. A run without any `img/**` output keeps the existing `img/` tree; a run with any `img/**` output is treated as the complete set and stale images are removed.
- `private/<game>/` is replaced wholesale on each successful run (B and C are fetched fresh).
- Any `error` issue (from the game or from the runner's own checks: unsafe or duplicate paths, reserved names, files over 95 MB) leaves both directories untouched, records the failure in `status.json` and makes the run exit non-zero after the other games ran.

## 4. Files per game

The tables mirror the file registries `HOTS_FILES`, `MTGA_FILES` and `POKEMON_FILES` in each `schema.ts`, which are authoritative.

### Heroes of the Storm (`src/games/hots/schema.ts`)

| File | Class | Schema | Content |
|---|---|---|---|
| `meta.json` | A | `HotsMetaSchema` | `extra`: `build` (live), `dataBuild` (the heroes-data2 build the hero data comes from), `ptrBuild`, `major` and `majorSince`, `builds` of the major (when the version server's `.version.json` is unknown, the last-good list of the same major is kept, so an outage does not change `dataHash`), `assetsTag` (heroes-images tag), `buildSeenAt` (when the pipeline first saw the live build) and `dataPending` (set only while heroes-data2 lags the live build by more than 48 hours, so the hero data is from `dataBuild`) |
| `heroes.json` | A | `HeroesFileSchema` | Roster with roles, abilities, talents, mechanics tags with evidence, `isNew`, `portrait` (hero-select button) and `draftPortrait` (180×212 draft-screen portrait under `img/heroes/`) |
| `maps.json` | A | `MapsFileSchema` | Maps, kind, ranked flag, profile tags. The Storm League pool always comes from `curated/hots/ranked-pool.yaml` (`rankedSource: 'curated'`), also when heroes-data2 is down and last-good maps are re-emitted (the pool is re-applied to them). The enum keeps `'stats'` only for type compatibility |
| `patches.json` | A | `PatchesFileSchema` | Patch notes as **our own structured summaries**, never Blizzard's sentences (below), per-hero changes and a link to the original (`url`) |
| `diffs.json` | A | `DiffsFileSchema` | Build-to-build game-data diffs per hero |
| `theory.json` | A | `TheorySchema` | Theory counters, synergies and map fit with reasons ([THEORY.md](THEORY.md)); generic edges within ±4 of 50 are left out; a curated reason's `conditions` stay a separate field |
| `links.json` | A | `LinksSchema` | Outbound guide links per hero. Reading a last-good file drops links to a site the pipeline no longer links |
| `rotation.json` | A | `RotationSchema` | Free hero rotation and ranked season (Nexus Compendium, "as of"). `fetchedAt` is when this content was first fetched (it stays while the content is unchanged); `lagging: true` is written when the window had already ended at the run (the source has not published the new week, or could not be fetched), so pages mark no hero free. The flag changes `dataHash` on the switch day, which redeploys the site |
| `pro.json` | **A-SA** | `ProSchema` | Liquipedia pro picks, bans and presence, CC-BY-SA 3.0. An implausible refresh (no drafted maps at all, or fewer than half of last-good's maps within the same window label) counts as a source failure: last-good is kept and the source is `stale`. A new window label or a first run is not judged |
| `public/draft.json` | A | `DraftShardSchema` | Columnar draft shard. Schema 2: reason lines are templates in which `{a}` and `{b}` (map fit: `{a}` and `{m}`) stand for the edge's names, which the reader fills in, and a reference `[i, j]` or `[i, j, k]` joins a rule line with its "Only when … takes …" conditions. Each edge list may carry an optional `cond` table `{ e: number[], k: number[], c: number[][] }`: entry i says reason `r[e[i]][k[i]]` holds only when every condition template `c[i]` (indices into `reasons`, at most 8) holds. Readers that ignore `cond` decode `r` unchanged; the table is omitted when no reason has conditions. `Reason.cites` is not carried |
| `img/**` | A | n/a | WebP portraits, draft portraits, ability and talent icons (64 px) and map images converted from heroes-images at a pinned tag. Files come from jsDelivr, with raw.githubusercontent.com as the fallback for files jsDelivr does not serve (the repository is over its 50 MB package limit) |
| `img/_index.json` | A | n/a | Image conversion index written with the images: `{ schema: 1, repo, tag, converter, files: { "<img/… path>": { src, blob } } }` (`src` = path in heroes-images, `blob` = sha256 of the source file). Only files whose source or converter changed are converted again |
| `videos.json` (private) | **C** | `VideosSchema` | YouTube video metadata (30-day retention) |

Twitch is not used: no stream metadata is fetched, so there is no `streams.json`; `/hots/live/` links to the Twitch category and featured channels.

No match-statistics file is produced: Heroes of the Storm publishes no match data Whetstone can use under its own-tooling rule. The generic statistics shapes (`StatsSchema`, the draft shard's `stats` overlay, each with a `source` id) stay for the private hub and for the synthetic sample in `fixtures/hots/_private/` (`source: 'synthetic'`), which exercises the statistics mode in CI. Old last-good files that still carry keys of the removed statistics source (`meta.extra.hpMode`, map `hp` refs) parse, with those keys dropped.

**Patch change records.** Each hero change in `patches.json` is `{ section, target?, level?, kind, stat?, old?, new?, by?, unit?, count?, text, dir? }`: `kind` is `numeric`, `added`, `removed`, `reworked`, `changed` or `bugfix`; `stat` is a label of at most four words from the line, or from our own vocabulary; `old`/`new` or a signed `by` carry the numbers, `unit` is `%` or `s`; `dir` (buff, nerf, change, rework) is computed. `text` is a template built from those fields ("Damage 345 → 360", "Effect changed (see Blizzard's notes)"). Ability and talent names are kept as targets (at most six words). General sections become category counts ("Interface and audio: 2 changes"), map lines numeric templates or counts. Records carry `notes: 'summary'`. As a last guard, any stored string that repeats eight consecutive words of its article is replaced; tests check the parser output, an offline run and the committed fixtures. Last-good files in the older format are summarised again by the pipeline (numbers kept) and cut down to counts by the schema on read.

### MTG Arena (`src/games/mtga/schema.ts`)

| File | Class | Schema | Content |
|---|---|---|---|
| `meta.json` | A | `MtgaMetaSchema` | `extra`: Scryfall snapshot, grindstone version, latest set, Standard sets, curated meta formats. `counts.metaDecks` and the `curated-meta` status count only real lists ("N format(s), M list(s)[, K example list(s) not used as meta]"); the `grindstone-mcp` status reads "grindstone-mcp <version>, workspace package" |
| `sets.json` | A | `SetsFileSchema` | Arena sets and formats |
| `public/_cards.standard.json`, `public/_cards.arena.json` | A | `CardShardSchema` | Trimmed card index for the in-browser analyzer. The `_` prefix keeps it out of the public manifest: it is an internal asset, not a dataset (section 5). Records may carry `priceUsd`: the cheapest USD paper price over the card's printings (nonfoil, else foil), omitted when unknown and read back as `null`; the site shows it as "about $X" (a paper guide; Arena has no cash prices) |
| `limited/index.json` | A | `LimitedIndexSchema` | Available 17Lands datasets: `[{ set, format, file, games, lastModified }]`, newest set first |
| `limited/<SET>.<Format>.json` | A | `LimitedRatingsSchema` | Card ratings derived from 17Lands public datasets (CC BY 4.0), one file per set and format (`PremierDraft`, `TradDraft`, `Sealed`), e.g. `limited/HOB.PremierDraft.json`. Pages: `/mtga/limited/<set>/` for Premier Draft and `/mtga/limited/<set>/<format-slug>/` (`trad-draft`, `sealed`) for the others, with lower-case set codes |
| `meta/<format>.json` | A | `MetaSnapshotSchema` | Hand-curated meta lists from `curated/mtga/meta/` (card names and counts only), each with its `sourceUrl`, optional `date` (the source's publication date) and `metaShare` where the source gives one. Standard holds real lists from Wizards' magic.gg articles, refreshed about monthly (OWNER-ACTIONS) |

### Pokémon Champions (`src/games/pokemon/schema.ts`)

| File | Class | Schema | Content |
|---|---|---|---|
| `meta.json` | A | `PokemonMetaSchema` | `extra`: regulation and its window, season, formats, `smogonMonth` (the primary doubles month), `showdownSha` (Showdown commit of the dex), `dexKey` (cache key of the dex export), `warmingUp` (right after a regulation change: `{ regulation, since, sources[], showing? }`, the sources without data for the new regulation yet and the regulation shown meanwhile) and `sprites` (`{ count, source, credit }` for the self-hosted sprites) |
| `regulations.json` | A | `RegulationsFileSchema` | Regulation windows and format ids (from `curated/pokemon/regulations.yaml`) |
| `dex/species.json`, `dex/moves.json`, `dex/items.json`, `dex/abilities.json`, `dex/typechart.json`, `dex/learnsets.json` | A | `SpeciesFileSchema` and siblings | Champions dex from Pokémon Showdown (MIT) at the commit pinned in `curated/pokemon/showdown.json` (`{ sha, reviewedOn, note? }`; nothing follows master, a bump is a pull request: `node src/games/pokemon/pipeline/showdown/pin.ts --check` / `--set <sha|latest>`). The export runs in its own job (`export-job.ts --out <file>`, no secrets) and reaches the data job through `WHETSTONE_SHOWDOWN_EXPORT`, validated again (schema, pinned SHA, regulations); without it the last-good dex is kept with a warning. An unchanged pin re-emits the last-good dex with no network access. Developers may build locally with `WHETSTONE_SHOWDOWN_BUILD=local` (ignored on CI). Species carry `sprite` (`img/sprites/<id>.webp`) when one exists and `cosmeticFormes` (Showdown ids of purely cosmetic formes, folded into the species) |
| `usage/index.json`, `usage/<format>-<cutoff>.json` | A | `UsageIndexSchema`, `UsageSchema` | Smogon monthly usage, reduced to top-K per field |
| `tournaments.json` | A | `TournamentsSchema` | Limitless aggregates and top-cut teams, player names removed |
| `h2h.json` | A | `H2HSchema` | Head-to-head aggregates from Showdown Bo3 replays |
| `speed.json` | A | `SpeedTiersSchema` | Speed tiers |
| `public/dex.json` | A | `DexShardSchema` | Browser shard for the builder |
| `ledger/<source>.json` | A | `ReplayLedgerSchema` | Pipeline state, never read by pages: `ledger/showdown-replays.json` keeps the parsed Bo3 replays of the current regulation (species, the ones brought in order, winner and date; no names, replay ids or ratings) and the crawl cursor, so a capped daily crawl adds up to the 30-day window behind `h2h.json` |
| `img/sprites/**` | A | n/a | Pokémon sprites converted to WebP from Showdown's gen5 sprites, credited as `meta.extra.sprites.credit` |

## 5. Browser shards and the public manifest

`node pipeline/stage.ts` (run by `npm run build`) cleans `public/data/` and, per game:

- copies `public/**` from the game's data directory to `public/data/<game>/<name>.<hash8>.<ext>` (the hash is the first 8 hex characters of the content's sha256, so each deploy's files never collide with cached ones), and every shard that carries private (B/C/D) data to `public/data/<game>/_private/<name>.<hash8>.<ext>`. The service worker never caches anything under a `_`-prefixed name, so private data on a visitor's device never outlives the deploy that served it;
- copies `img/**` to `public/data/<game>/img/**` unchanged;
- writes `src/generated/stage-map.json`, `{ "hots/draft": "data/hots/draft.1a2b3c4d.json", … }`, with paths relative to the site base (`/whetstone/`). Pages resolve a shard at build time with `stagedUrl(game, name)` from `src/lib/stagemap.ts` (or `stagedUrlOrNull` for optional shards) and pass the URL to their island as a prop; islands never import the map. `npm run build` and `npm run dev` stage first; run `node pipeline/stage.ts` before anything else that renders pages;
- writes `public/data/manifest.json`, served at `https://jollykrampus.github.io/whetstone/data/manifest.json`:

```json
{ "schema": 1,
  "games": { "hots": { "version": { "label": "2.57", "build": "2.57.0.98348" }, "generatedAt": "…", "dataHash": "…",
                       "fixtures": false, "sources": [ … ], "counts": { "heroes": 91 },
                       "files": { "draft": { "url": "data/hots/draft.1a2b3c4d.json", "custody": "A" } } } } }
```

Manifest rules:

- Only class A and A-SA shards from the public data directory are listed.
- B and C shards are staged and mapped for the site but never listed.
- Shards whose file name starts with `_` are internal assets: staged and mapped, not listed. Use this for anything that must not be presented as a dataset, such as the MTGA card index (Scryfall terms).
- **Overlay:** when `private/<game>/public/<name>.json` exists next to `current/<game>/public/<name>.json`, the site's copy is their shallow merge (the private keys must not overlap the public ones), staged under `_private/`, and the manifest keeps pointing at the pure class-A file, which is staged too. This is how a shard gains a private block without ever exposing it under a documented name. Fixture builds with `WHETSTONE_FIXTURE_PRIVATE=1` merge `fixtures/<game>/_private/public/**` the same way, so the private-sample e2e runs the tools exactly as the live site does.

GitHub Pages serves everything with `Access-Control-Allow-Origin: *` and a 10-minute cache, so external tools can read the documented class-A shards. Please credit the sources listed in the manifest.

## 6. Attribution

`SourceRef.rule` in each `module.ts` decides where the credit appears (`SourceAttribution` component):

| Rule | Where | Sources |
|---|---|---|
| `inline` | Same screen as the data, body-size text with a working link | Liquipedia (CC-BY-SA 3.0), YouTube |
| `top` | Top of the page | 17Lands (CC BY 4.0) on Limited pages |
| `footer` | Page footer and the credits page | Blizzard, heroes-data2, heroes-images, Nexus Compendium, Scryfall, grindstone-mcp, Pokémon Showdown, Smogon, Limitless, @smogon/calc |

Every page footer also carries the non-affiliation disclaimer and each game's rights notice (`legalNotice` in `src/games/registry.ts`: Blizzard, Wizards of the Coast Fan Content Policy, The Pokémon Company), current game first. The credits page shows each MIT source's copyright line, and `/licenses.txt` (generated by every build from the packages actually bundled into the site's scripts, Web Workers and service worker) carries the licence text of all third-party code the site ships. YouTube API Services: the privacy page says what is fetched and kept, and links the YouTube Terms of Service and the Google Privacy Policy.

## 7. Private data in CI and retention

### How B, C and D data moves

1. The game's data job writes `data/private/<game>/` and packs it with `node pipeline/private.ts pack`. Class-B files are packed only when the `DATA_ARTIFACT_KEY` secret is set; the bundle is then encrypted with AES-256-GCM. Without the key, class-B files are left out (a warning annotation says so) and the site builds without them. Workflow artifacts of a public repository can be downloaded by any signed-in GitHub user, which is why B never travels unencrypted.
2. After every successful run the bundle is uploaded as the `private-<game>` artifact with **1 day** retention, even when it is empty: an empty bundle (a tombstone) records that the run had nothing private to ship.
3. The build job restores the newest unexpired `private-<game>` artifact of a scheduled or dispatched `data-deploy` run of this repository (`pipeline/private.ts restore`; fork and pull-request runs are ignored, artifacts older than 24 hours are ignored). A tombstone leaves that game without private data; a game that failed today keeps yesterday's bundle while it is younger than 24 hours. An artifact that cannot be read (for example after `DATA_ARTIFACT_KEY` was rotated) only costs that game its private data, with a warning; the build carries on.
4. The built site, including hashed shards, is the `github-pages` artifact (1 day retention) and the live deployment.
5. In visitors' browsers, private shards are never cached by the service worker (they are staged under `_private/`), and saved pages expire after 7 days.

### Retention of class C

| Source | Rule | How Whetstone complies |
|---|---|---|
| YouTube Data API | Refresh or delete within 30 days | Refreshed on each run; the client hides items older than 30 days; artifacts are kept 1 day |

Twitch is not used (no stream metadata is fetched).

### Removing private data from the live site

To stop showing a B, C or D source (credential withdrawn, terms changed, or you decide to stop):

1. Delete or unset its credential (Settings → Secrets and variables → Actions), or switch its source off in the game's pipeline.
2. Run **Data + Deploy** with `games` set to that game and `force_deploy` checked. The run writes a tombstone bundle, the build restores it and the deploy replaces the live site without the data. Visitors' browsers drop it on their next visit: private shards are never cached, saved pages expire within 7 days, and bumping `SW_CACHE_VERSION` in `src/components/offline.ts` clears every saved page and data file on the next visit.
3. Optionally delete the remaining artifacts at once instead of waiting for the 1-day expiry (in a shell, one artifact id per line):

   ```sh
   gh api --paginate repos/JollyKrampus/whetstone/actions/artifacts --jq '.artifacts[] | select((.name | startswith("private-")) or .name == "github-pages") | .id' | while read -r id; do gh api -X DELETE "repos/JollyKrampus/whetstone/actions/artifacts/$id"; done
   ```

4. Delete local copies on every machine that ran the pipeline with the credential: `data/private/<game>/` and the HTTP cache `.cache/http/`. Class-C responses are never recorded as fixtures (`pipeline/http.ts` refuses the class-C API hosts, and their fixture folders are git-ignored).
5. Nothing to rewrite in git: B, C and D are never committed.

## 8. Failures and recovery

- A failing validation keeps that game's last good data live. The data job fails, the run's `report` job opens (or comments on) an issue labelled `pipeline-failure`, and the next successful run closes it.
- A failing source is softer: the game keeps that source's last good data and the run succeeds, but the source is listed as degraded (`status.json`, the publish summary and the run's step summary). Once a source has been degraded for 2 runs in a row, the report job opens or comments on the `pipeline-failure` issue too, and the issue is never closed while any source is still degraded.
- The site shows a freshness badge from `meta.generatedAt` and per-source status: a game with degraded sources is never shown as fresh, the badge says how many sources are behind, and it goes stale once the oldest last-good data does; the staleness banner names them with their dates. When nothing changed, the site is not redeployed, but the publish job redeploys anyway once the live data is more than 48 hours old or its `dataHash` differs from the branch, so the badge never lags far.
- A data job that dies before the pipeline writes its status cannot pass off yesterday's `status.json` as today's: the job deletes the branch copy before running, and `publish.ts` rejects any status that is not newer than the branch's.
- The Pokémon dex is exported from Pokémon Showdown's source in its own job (`showdown-export`: no token permissions, no secrets); when it fails, the Pokémon data job keeps the last-good dex.
- To retry: Actions → Data + Deploy → Run workflow (optionally only the failing game). To rebuild without fetching: `games` = `none`.
- To reproduce locally: `npm run data:pull`, then `npm run data -- --game <game>` (live) or `npm run data:offline -- --game <game>` (fixtures).
- To see what CI's runners can reach: run the **Egress probe** workflow.
