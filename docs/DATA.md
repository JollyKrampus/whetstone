# Whetstone data

How Whetstone's data is produced, where each file lives, who may see it, how it is credited, and how long it is kept. The contract behind this is [SPEC.md](SPEC.md) §1, §4 and §10; schemas live in `src/games/<game>/schema.ts`.

## 1. Custody classes

Every file a pipeline writes declares one class (`OutputFile.custody`). The runner (`pipeline/run.ts`) routes it accordingly.

| Class | Meaning | Written to | Committed? | Public? |
|---|---|---|---|---|
| **A** | Our own derivations and openly licensed inputs | `current/<game>/` | Yes, `data` branch | Yes, documented JSON |
| **A-SA** | Liquipedia-derived, CC-BY-SA 3.0 | `current/<game>/`, **separate files** | Yes, `data` branch | Yes, labelled CC-BY-SA 3.0 |
| **B** | Heroes Profile (licensed) | `private/<game>/` | **Never** | Only inside the deployed site, under content-hashed names; never listed in any manifest |
| **C** | Twitch / YouTube metadata (ephemeral) | `private/<game>/` | **Never** | Only inside the deployed site; the browser hides it after its retention window |

Rules that follow from this:

- B and C never enter git, the `data` branch, history files or the public manifest.
- A-SA content is never mixed into a file of another class (history summaries list A-SA files by hash only).
- Player names and handles from Limitless or Showdown are removed at ingest; only aggregates and anonymised teams are written.
- Class B files are only written when `HP_MODE=on`. The runner drops them otherwise, and the build job purges any that arrive from an artifact (section 7).

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
```

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

`state` is `ok`, `failed` (last good data kept; sources marked `failed` or `stale`) or `skipped` (no pipeline module yet). Issues are capped at 50 per game.

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
| `meta.json` | A | `HotsMetaSchema` | `extra`: `build` (live), `dataBuild` (the heroes-data2 build the hero data comes from), `ptrBuild`, `major` and `majorSince`, `builds` of the major, `assetsTag` (heroes-images tag), `hpMode`, `buildSeenAt` (when the pipeline first saw the live build) and `dataPending` (set only while heroes-data2 lags the live build by more than 48 hours, so the hero data is from `dataBuild`) |
| `heroes.json` | A | `HeroesFileSchema` | Roster with roles, abilities, talents, mechanics tags with evidence, `isNew`, `portrait` (hero-select button) and `draftPortrait` (180×212 draft-screen portrait under `img/heroes/`) |
| `maps.json` | A | `MapsFileSchema` | Maps, kind, ranked flag and its source, profile tags |
| `patches.json` | A | `PatchesFileSchema` | Patch notes as short factual summaries, per-hero changes, link to the original |
| `diffs.json` | A | `DiffsFileSchema` | Build-to-build game-data diffs per hero |
| `theory.json` | A | `TheorySchema` | Theory counters, synergies and map fit with reasons ([THEORY.md](THEORY.md)); generic edges within ±4 of 50 are left out |
| `links.json` | A | `LinksSchema` | Outbound guide links per hero |
| `rotation.json` | A | `RotationSchema` | Free hero rotation and ranked season (Nexus Compendium, "as of") |
| `pro.json` | **A-SA** | `ProSchema` | Liquipedia pro picks, bans and presence, CC-BY-SA 3.0 |
| `public/draft.json` | A | `DraftShardSchema` | Columnar draft shard. Schema 2: reason lines are templates in which `{a}` and `{b}` (map fit: `{a}` and `{m}`) stand for the edge's names, which the reader fills in, and a reference `[i, j]` or `[i, j, k]` joins a rule line with its "Only when … takes …" conditions. A class-B overlay adds `stats` at stage time (section 5) |
| `img/**` | A | n/a | WebP portraits, draft portraits, ability and talent icons (64 px) and map images converted from heroes-images at a pinned tag. Files come from jsDelivr, with raw.githubusercontent.com as the fallback for files jsDelivr does not serve (the repository is over its 50 MB package limit) |
| `img/_index.json` | A | n/a | Image conversion index written with the images: `{ schema: 1, repo, tag, converter, files: { "<img/… path>": { src, blob } } }` (`src` = path in heroes-images, `blob` = sha256 of the source file). Only files whose source or converter changed are converted again |
| `stats.json` (private) | **B** | `StatsSchema` | Heroes Profile aggregates; only with `HP_MODE=on` |
| `public/draft.json` (private overlay) | **B** | `DraftStatsBlockSchema` under `stats` | Statistics block merged into the draft shard |
| `videos.json` (private) | **C** | `VideosSchema` | YouTube video metadata (30-day retention) |
| `streams.json` (private) | **C** | `StreamsSchema` | Twitch stream metadata (24-hour retention) |

### MTG Arena (`src/games/mtga/schema.ts`)

| File | Class | Schema | Content |
|---|---|---|---|
| `meta.json` | A | `MtgaMetaSchema` | `extra`: Scryfall snapshot, grindstone version, latest set, Standard sets, curated meta formats |
| `sets.json` | A | `SetsFileSchema` | Arena sets and formats |
| `public/_cards.standard.json`, `public/_cards.arena.json` | A | `CardShardSchema` | Trimmed card index for the in-browser analyzer. The `_` prefix keeps it out of the public manifest: it is an internal asset, not a dataset (section 5) |
| `limited/index.json` | A | `LimitedIndexSchema` | Available 17Lands datasets: `[{ set, format, file, games, lastModified }]`, newest set first |
| `limited/<SET>.<Format>.json` | A | `LimitedRatingsSchema` | Card ratings derived from 17Lands public datasets (CC BY 4.0), one file per set and format (`PremierDraft`, `TradDraft`, `Sealed`), e.g. `limited/HOB.PremierDraft.json`. Pages: `/mtga/limited/<set>/` for Premier Draft and `/mtga/limited/<set>/<format-slug>/` (`trad-draft`, `sealed`) for the others, with lower-case set codes |
| `meta/<format>.json` | A | `MetaSnapshotSchema` | Hand-curated meta lists from `curated/mtga/meta/`, each with its source URL |

### Pokémon Champions (`src/games/pokemon/schema.ts`)

| File | Class | Schema | Content |
|---|---|---|---|
| `meta.json` | A | `PokemonMetaSchema` | `extra`: regulation and its window, season, formats, `smogonMonth` (the primary doubles month), `showdownSha` (Showdown commit of the dex), `dexKey` (cache key of the dex export), `warmingUp` (right after a regulation change: `{ regulation, since, sources[], showing? }`, the sources without data for the new regulation yet and the regulation shown meanwhile) and `sprites` (`{ count, source, credit }` for the self-hosted sprites) |
| `regulations.json` | A | `RegulationsFileSchema` | Regulation windows and format ids (from `curated/pokemon/regulations.yaml`) |
| `dex/species.json`, `dex/moves.json`, `dex/items.json`, `dex/abilities.json`, `dex/typechart.json`, `dex/learnsets.json` | A | `SpeciesFileSchema` and siblings | Champions dex from Pokémon Showdown (MIT). Species carry `sprite` (`img/sprites/<id>.webp`) when one exists and `cosmeticFormes` (Showdown ids of purely cosmetic formes, folded into the species) |
| `usage/index.json`, `usage/<format>-<cutoff>.json` | A | `UsageIndexSchema`, `UsageSchema` | Smogon monthly usage, reduced to top-K per field |
| `tournaments.json` | A | `TournamentsSchema` | Limitless aggregates and top-cut teams, player names removed |
| `h2h.json` | A | `H2HSchema` | Head-to-head aggregates from Showdown Bo3 replays |
| `speed.json` | A | `SpeedTiersSchema` | Speed tiers |
| `public/dex.json` | A | `DexShardSchema` | Browser shard for the builder |
| `ledger/<source>.json` | A | `ReplayLedgerSchema` | Pipeline state, never read by pages: `ledger/showdown-replays.json` keeps the parsed Bo3 replays of the current regulation (species, the ones brought in order, winner and date; no names, replay ids or ratings) and the crawl cursor, so a capped daily crawl adds up to the 30-day window behind `h2h.json` |
| `img/sprites/**` | A | n/a | Pokémon sprites converted to WebP from Showdown's gen5 sprites, credited as `meta.extra.sprites.credit` |

## 5. Browser shards and the public manifest

`node pipeline/stage.ts` (run by `npm run build`) cleans `public/data/` and, per game:

- copies `public/**` from the game's data directory and from its private directory to `public/data/<game>/<name>.<hash8>.<ext>` (the hash is the first 8 hex characters of the content's sha256, so each deploy's files never collide with cached ones);
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
- **Overlay:** when `private/<game>/public/<name>.json` exists next to `current/<game>/public/<name>.json`, the site's copy is their shallow merge (the private keys must not overlap the public ones), and the manifest keeps pointing at the pure class-A file, which is staged too. This is how the HotS draft shard gains its Heroes Profile `stats` block without ever exposing it under a documented name. Fixture builds with `WHETSTONE_FIXTURE_PRIVATE=1` merge `fixtures/<game>/_private/public/**` the same way (the synthetic stats block in `fixtures/hots/_private/public/draft.json`), so the statistics-mode e2e runs the draft and ARAM tools exactly as the live site does.

GitHub Pages serves everything with `Access-Control-Allow-Origin: *` and a 10-minute cache, so external tools can read the documented class-A shards. Please credit the sources listed in the manifest.

## 6. Attribution

`SourceRef.rule` in each `module.ts` decides where the credit appears (`SourceAttribution` component):

| Rule | Where | Sources |
|---|---|---|
| `inline` | Same screen as the data, body-size text with a working link | Heroes Profile ("Data provided by Heroes Profile"), Liquipedia (CC-BY-SA 3.0) |
| `top` | Top of the page | 17Lands (CC BY 4.0) on Limited pages |
| `footer` | Page footer and the credits page | Blizzard, heroes-data2, heroes-images, Nexus Compendium, Scryfall, grindstone-mcp, Pokémon Showdown, Smogon, Limitless, @smogon/calc |

Every page footer also carries the non-affiliation disclaimers (Blizzard, Wizards of the Coast Fan Content Policy, The Pokémon Company, heroescounters.com, Heroes Profile), and HotS pages carry the Blizzard copyright and trademark line. Heroes Profile attribution must travel with share links and image exports of HP-derived numbers. Never use the Heroes Profile name in Whetstone's name, logo, domain or icon.

## 7. Private data in CI, retention and kill switches

### How B and C data moves

1. The game's data job writes `data/private/<game>/` and packs it with `node pipeline/private.ts pack`. Class-B files are packed only when the `DATA_ARTIFACT_KEY` secret is set; the bundle is then encrypted with AES-256-GCM. Without the key, class-B files are left out (a warning annotation says so) and the site builds without them. Workflow artifacts of a public repository can be downloaded by any signed-in GitHub user, which is why B never travels unencrypted.
2. The bundle is uploaded as the `private-<game>` artifact with **1 day** retention.
3. The build job restores the newest unexpired `private-<game>` artifact of a scheduled or dispatched `data-deploy` run of this repository (`pipeline/private.ts restore`; fork and pull-request runs are ignored, artifacts older than 24 hours are ignored). This covers games that failed today and push-triggered rebuilds.
4. If `HP_MODE` is not `on`, the build job deletes every class-B file before building (`pipeline/private.ts purge --custody B`).
5. The built site, including hashed shards, is the `github-pages` artifact (1 day retention) and the live deployment.

### Retention of class C

| Source | Rule | How Whetstone complies |
|---|---|---|
| Twitch | Cache at most 24 hours | Artifacts kept 1 day; the client stops showing streams after 90 minutes and treats anything older than 24 hours as absent; the next deploy replaces the file |
| YouTube Data API | Refresh or delete within 30 days | Refreshed on each run; the client hides items older than 30 days |

If the cron stops, C data in the last deployment is hidden by the client after its window. To remove it from the deployment as well, unset the credential and run **Data + Deploy** with `force_deploy`.

### Heroes Profile kill switch runbook

Use this when Heroes Profile withdraws permission, the subscription lapses, the terms change, or you decide to stop. HP's terms require that HP data and anything derived from it stop being displayed and are deleted within **30 days**, with backups gone within a further 30 days.

1. **Switch off.** Settings → Secrets and variables → Actions → Variables: set `HP_MODE` to `off` (or delete the variable; off is the default).
2. **Redeploy without HP data.** Actions → Data + Deploy → Run workflow with `games` = `hots` and `force_deploy` checked. The runner drops class-B outputs, the build purges any restored B files, and the deploy replaces the live site. Check that stats routes no longer show Heroes Profile numbers or the "Data provided by Heroes Profile" credit.
3. **Remove the credential.** Delete the `HP_API_KEY` secret. Cancel the subscription or Patreon pledge if appropriate.
4. **Delete artifacts now** instead of waiting for the 1-day expiry:

   ```sh
   gh api --paginate repos/JollyKrampus/whetstone/actions/artifacts \
     --jq '.artifacts[] | select(.name == "private-hots" or .name == "github-pages") | .id' |
   while read -r id; do gh api -X DELETE "repos/JollyKrampus/whetstone/actions/artifacts/$id"; done
   ```

5. **Delete local copies** on every machine that ran the pipeline with a key: `data/private/hots/`, the HTTP cache `.cache/http/`, and any recorded fixtures containing real HP responses (fixtures must only ever hold HP's placeholder fixture-mode data).
6. **Nothing to rewrite in git.** Class B is never committed. Confirm with `git log --all --oneline -- '*stats.json'` on the `data` branch (expect no output).
7. **Rotate** `DATA_ARTIFACT_KEY` (optional; old artifacts are already deleted).
8. **Record the date** of steps 1 to 5 in the pipeline-failure or tracking issue. The non-compete and no-competing-dataset clauses last 12 months after termination: do not start collecting replays for HotS statistics in that period.

To turn HP back on later: written OK from Heroes Profile, then `HP_API_KEY` secret, `DATA_ARTIFACT_KEY` secret and `HP_MODE=on`.

## 8. Failures and recovery

- A failing source or validation keeps that game's last good data live. The data job fails, the run's `report` job opens (or comments on) an issue labelled `pipeline-failure`, and the next successful run closes it.
- The site shows a freshness badge from `meta.generatedAt` and per-source status. When nothing changed, the site is not redeployed, but the publish job redeploys anyway once the live data is more than 48 hours old or its `dataHash` differs from the branch, so the badge never lags far.
- To retry: Actions → Data + Deploy → Run workflow (optionally only the failing game). To rebuild without fetching: `games` = `none`.
- To reproduce locally: `npm run data:pull`, then `npm run data -- --game <game>` (live) or `npm run data:offline -- --game <game>` (fixtures).
- To see what CI's runners can reach: run the **Egress probe** workflow.
