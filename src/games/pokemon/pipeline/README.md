# Pokémon Champions data pipeline

`index.ts` exports `pipeline: DataPipeline`; `pipeline/run.ts --game pokemon` runs it daily. Every output is class A
and validated against `POKEMON_FILES` in `../schema.ts`. Player names never leave the ingest functions.

| Source id | What | Files | Cadence |
|---|---|---|---|
| (curated) | `curated/pokemon/regulations.yaml` | `regulations.json` | every run |
| `showdown` | Champions dex exported from Pokémon Showdown at an exact commit, plus sprites | `dex/*.json`, `public/dex.json`, `img/sprites/*.webp` | when the commit changes |
| `smogon-calc` | cross-check of that dex against `@smogon/calc` generation 0 | (status only) | every run |
| `smogon` | monthly chaos usage, VGC doubles + Bo3 + Battle Stadium Singles at cutoffs 1760/1500/0 | `usage/index.json`, `usage/<format>-<cutoff>.json` | when a new month appears |
| `limitless` | grassroots tournaments with open team lists, last 30 days | `tournaments.json` | every run |
| `showdown-replays` | public Bo3 replays (open team sheets), rolling 30-day ledger | `ledger/showdown-replays.json`, `h2h.json` | every run |
| (derived) | Speed tiers from the dex and the doubles usage | `speed.json` | every run |

## Dex route (`showdown/`)

Chosen: download the source zip of `smogon/pokemon-showdown` at the current `master` commit, extract `sim/`, `lib/`,
`data/` and `config/formats.ts`, transpile them to CommonJS with the TypeScript compiler already in the project, and run
`showdown/export.ts` in a child process with an empty environment. The exporter asks Showdown's own `Dex.forFormat` and
`TeamValidator` which species, Megas, items and moves are legal in each regulation's doubles format, so mod
inheritance, the Champions PP rules (`scripts.ts`) and format bans are applied exactly as the simulator applies them.

Why not the alternatives:

- **npm packages** (`pokemon-showdown`, `@pkmn/dex`, `@pkmn/mods`) lag the current regulation by weeks; at M-C launch
  Rillaboom and Garchomp-Mega-Z were still illegal there.
- **`play.pokemonshowdown.com/data/*.js`** is a second-hand, partial view (the client's teambuilder tables) that has to
  be evaluated as JavaScript, and its deltas must be re-applied by hand.
- **Raw `data/mods/champions/*.ts`** would mean re-implementing mod inheritance and the validator.
- **Shallow `git clone` + Showdown's own `node build`** needs git, esbuild and a full `npm ci` of Showdown's server
  dependencies on every runner. The zip of the same commit (~7 MB) goes through the pipeline's `Http` (User-Agent,
  retries, dev cache) and needs nothing new.

The commit is resolved with the GitHub API and, when that is rate limited (shared runner IPs), from the git smart-HTTP
ref advertisement. `meta.extra.dexKey` hashes the commit, the exporter and tree versions and the regulation formats;
while it is unchanged the last-good dex is re-emitted without downloading anything else. Transpiled trees are cached
in `.cache/showdown/<sha>/` locally. A full rebuild takes about 30 s.

Validation before a new dex replaces the last-good one: schema checks, at least 150 entries, at most a 15 % drop in
entries within the same regulation, and **base stats and types identical to `@smogon/calc` generation 0** (the
site's calculator). Any mismatch keeps the last-good dex and marks `showdown` failed until the calc or Showdown agree.
Species the calc does not have yet are a warning. Showdown's `aegislash` is the calc's `aegislashshield`.

`public/dex.json` (≈ 480 KB, ≈ 72 KB gzipped) carries every legal species and forme of the listed regulations, their
learnsets, the moves they can learn, items, abilities and the type chart, with Showdown's one-line descriptions
(descriptions are left out where the Champions mod changes an effect without updating its text).

## Sprites (`sprites.ts`)

Decision: **self-host a subset**, as critique D12 decided. One lossless WebP per exported species or Mega, converted
from Pokémon Showdown's gen5-style sprite set (`play.pokemonshowdown.com/sprites/gen5/`), under `img/sprites/<id>.webp`,
about 0.5 MB in total (≈ 1.5 KB each). Defensible because the use is non-commercial, credited and carries the non-affiliation notice;
self-hosting is what Showdown and `@pkmn/img` ask third parties to do instead of hotlinking; and nothing is taken from
the Champions client. The images remain © Nintendo, Creatures and GAME FREAK; the newer gen5-style ones were drawn by
the Smogon sprite project. Credit text and source travel in `meta.extra.sprites` (`getSpriteCredit()` in `load.ts`).

Images are only downloaded for species that have none in the last-good tree (new roster entries); otherwise no `img/**`
file is emitted and the runner keeps the existing tree. A species without an upstream sprite (some new Megas) has no
`sprite`, and the UI shows type-coloured initials.

## Usage (`smogon/`)

Smogon's chaos JSON is reduced to the top K of each field (3 abilities, 6 items, 10 moves, 12 teammates, 8 spreads,
15 checks with n ≥ 20). Champions spreads are already Stat Points (`Adamant:32/32/0/0/2/0`); anything EV-shaped is
converted with the HOME rule (4 EVs for the first point, 8 for each further one). Megas are separate rows, as in
Smogon's own files. Chaos files are up to 16 MB and smogon.com sometimes serves them at ~60 KB/s, so a new month is
fetched in priority order (doubles at 1760 first) within a 20-minute budget; leftovers keep their older month's file
(each file names its month) and the next run continues.

## Tournaments (`limitless/`)

`play.limitlesstcg.com/api` (no key needed for tournaments; 50 requests per 5 minutes, so requests are spaced 6.5 s).
The 40 largest finished events of the regulation in the last 30 days with at least 16 players. `anonymise()` is the
ingest boundary: standings rows become `{ placing, record, members }` and nothing else (no name, handle, country, deck
id); raw standings are never written. Aggregates: species usage and match-weighted win rate with its Wilson lower
bound, item/ability/move/nature shares per species (Champions has no Tera), frequent pairs as archetypes, and the
latest top-cut teams.

## Replays (`replays/`)

`replay.pokemonshowdown.com` search + `.log`, about one request per second, at most 500 logs a day (critique U14).
Bo3 formats force open team sheets, so held items (and with them Mega formes) are known. Each run reads replays
uploaded after the ledger's cursor. The ledger keeps, per game, only the date, the winning side and both sides' six
and brought Pokémon as indexes into a species list: no names, replay ids or ratings. `h2h.json` is recomputed from
the 30-day window with `src/core/stats.ts`: counters (species brought vs species brought, shrunk toward the
logit-additive expectation and antisymmetrised) and synergies (pairs brought together), n ≥ 15.

## Speed (`speed.ts`)

Level 50, IVs fixed at 31, `Speed = floor((base + SP + 20) × nature)` with integer nature arithmetic, the formula of
Showdown's `champions` mod (`scripts.ts` `statModify`), checked against `@smogon/calc` for every nature. Per species:
the Speed most sets run (spreads giving the same Speed pooled), max/neutral/min references, and the shares of Choice
Scarf (with the scarfed Speed), Tailwind and Trick Room from the same usage file.

## Regulations and warm-up (`regulations.ts`)

The regulation whose UTC window contains "now" is current (ends are inclusive to the minute). Right after a change,
a source that has no data for the new regulation yet keeps the previous regulation's data and is listed in
`meta.extra.warmingUp` (`getWarmingUp()` and `getRosterRegulation()` in `load.ts`). To add a regulation, append it to
`curated/pokemon/regulations.yaml` once it is announced; nothing else changes.

## Failure handling

Each source falls back to its own last-good files and reports `failed` with a warning. Errors (which make the runner
keep the whole game's last-good data) are reserved for invalid output and for having no dex at all on a first run.
Status details describe the data, not the run, so a run that only re-emits unchanged data leaves `dataHash` alone.

## Offline fixtures

`npm run data:offline -- --game pokemon --now 2026-10-09T01:15:00Z` replays `../fixtures/raw/`: a trimmed real export
(`showdown/export.json`), three trimmed chaos files, two Limitless events (top ten rows each) and six replay logs. Every recorded
response was scrubbed of player names, handles, countries, nicknames and chat before it was committed.
