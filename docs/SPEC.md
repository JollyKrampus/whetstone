# Whetstone — specification (v0.1, extended for v2 in §13)

> *Grindstone tunes the deck. Whetstone sharpens every pick.*

Whetstone is a free, static, multi-game **meta companion** hosted on GitHub Pages
(`https://jollykrampus.github.io/whetstone/`). A daily GitHub Actions job refreshes every game's data,
validates it, keeps history, rebuilds and redeploys. There is no server.

Games (each a plugin under `src/games/<id>/`):

| id | Name | Route | Status at v0.1 |
|---|---|---|---|
| `hots` | Heroes of the Storm | `/hots/` | **Primary.** Feature parity with heroescounters.com plus the community roadmap. |
| `mtga` | MTG Arena | `/mtga/` | Deck analyzer on grindstone-mcp's core, Limited ratings (17Lands), curated meta. |
| `pokemon` | Pokémon Champions | `/pokemon/` | VGC Doubles (Reg M-C): meta, Pokémon pages, builder, calc, speed tiers, teams, team-preview assistant. |

Research behind every decision lives in the session scratchpad reports (hc-features, hots-stats-api,
hots-static, hots-roadmap, hots-meta-extra, mtga-grindstone, pokemon-champions, platform, critique).
Agents implementing this spec are given their paths. **Where this spec and a report disagree, this spec wins.**

---

## 1. Non-negotiables

1. **Static only.** Astro static output. Interactive tools are Preact islands. No runtime server.
   Optional third-party backends (vote Worker, stream proxy) are opt-in by config and the site must work fully without them.
2. **Data custody classes** (critique D2). Every file the pipeline writes declares its class:
   - **A — open/own**: our own derivations and openly licensed inputs. Committed to the public `data` branch (`current/`, `history/`). Documented JSON.
   - **A-SA — share-alike**: Liquipedia-derived (CC-BY-SA 3.0). Same branch, **separate files**, labelled.
   - **B — licensed**: data whose licence allows display only. **Never committed anywhere.** Fetched fresh each run into `data/private/`, shipped only inside the Pages artifact under content-hashed names, encrypted between workflow jobs. No public source is class B today (§12 entry 23).
   - **C — ephemeral**: YouTube video metadata (Twitch is not used). Never committed; artifact only; the client hides it when older than its retention (YouTube 30 days).
   - **A-NC-SA**, **D** (derived from public posts) and **P** (personal): §13.2.
   - Player names/handles from Limitless or Showdown are stripped at ingest, and recorded test fixtures are scrubbed the same way. Only aggregates are published.
3. **Own the tooling** (§13): the foundation is first-party public data, openly licensed data, our own curation and our own analysis of public discussion. No third-party statistics aggregator is used, and no source is used against its terms.
4. **No scraping** of sites whose terms forbid it (heroescounters.com, Icy Veins, statistics aggregators, Pikalytics, MTGGoldfish, untapped, mtgdecks, MTGTop8, Wizards decklist pages, Smogon analyses). Link out instead. Never import heroescounters' votes, tags or videos — copy UX patterns and verified formulas only.
5. **Attribution is a component, not an afterthought.** `SourceAttribution` renders each source's required credit per its rule (`inline` = same screen as the data, body-size text with a link — Liquipedia's CC BY-SA credit, YouTube; `top` = top of page — 17Lands CC BY; `footer`). Every page footer carries the non-affiliation disclaimers (Blizzard, Wizards of the Coast Fan Content Policy, The Pokémon Company, heroescounters.com) and the Blizzard ©/™ line on HotS pages. Non-commercial: no ads, no trackers, no paywall.
6. **Explainable output.** Every recommendation or counter shows *why* (reasons) and *how sure* (n / source / confidence). Low-sample data is greyed or hidden per §6 gates. Theory (curated/rule-based) data is always labelled as theory.
7. **Data-driven roster.** No hard-coded hero/card/Pokémon lists in UI code. New entities appear automatically with an "early data" badge.
8. **Graceful degradation.** Any source can fail. The pipeline keeps last-good data per game and per source; the UI shows a freshness badge and a staleness banner (driven by `meta.generatedAt` and per-source status).
9. **Mobile-first, accessible, fast.** Viewport meta; works at 360 px; keyboard-operable; no hover-only information; no colour-only cues; WCAG AA contrast in light and dark themes; entity pages ship zero JS unless they host an island.
10. **Deterministic pipeline.** Same inputs → same outputs (sorted keys/arrays; timestamps excluded from `dataHash`).

---

## 2. Stack (verified 2026-10-08)

- Node **24** in CI (`.node-version` = `24`); pipeline scripts run as plain `node pipeline/run.ts` (native type stripping). Local dev may use Node 26.
- **Astro 7.3.x** (`output: 'static'`, `site: 'https://jollykrampus.github.io'`, `base: '/whetstone'`, `trailingSlash: 'always'`, `build.format: 'directory'`), `@astrojs/preact` 6.0.x, **preact ^10.29** (not 11), `@preact/signals`, `@astrojs/sitemap`.
- **TypeScript ~6.0.3** (not 7 — tooling peers cap below 6.1). `erasableSyntaxOnly`, `verbatimModuleSyntax`, `.ts` extensions in imports.
- **zod 4** for schemas shared by pipeline validation and build-time loaders. `yaml` for curated files.
- **Vitest 5**, **Playwright 1.64** (Chromium smoke), **ESLint 10** flat config (typescript-eslint, eslint-plugin-astro).
- `@smogon/calc` **0.12.x** (Champions = `Generations.get(0)`).
- `sharp` (pipeline only) for WebP conversion; `fflate` (or `yauzl`) for zip; `workbox-build` 7.4 post-build service worker (not `@vite-pwa/astro`, which caps at Astro 5).
- npm workspaces: the site at the root and `packages/grindstone-mcp` (the MTGA engine and MCP server, imported as `grindstone-mcp/core`, built by the root `prepare` script). Root `package.json` `"imports"`: `#core/*` → `./src/core/*`, `#games/*` → `./src/games/*`, `#pipeline/*` → `./pipeline/*`.
- GitHub Actions, each pinned to a full commit SHA with its release in a comment (verified 2026-10-10): `actions/checkout` v7.0.1, `actions/setup-node` v7.1.0, `actions/cache` v6.1.0, `actions/upload-artifact` v7.0.2, `actions/download-artifact` v8.0.2, `actions/upload-pages-artifact` v5.0.0, `actions/deploy-pages` v5.0.1; `persist-credentials: false`; `runs-on: ubuntu-24.04`.

---

## 3. Repository layout

```
whetstone/
├─ .github/
│  ├─ workflows/ci.yml              # PR + push: lint, typecheck, unit, build (fixtures), e2e smoke
│  ├─ workflows/data-deploy.yml     # daily cron + push + dispatch: per-game data jobs → publish → build → deploy → report
│  ├─ workflows/egress-probe.yml    # dispatch: one GET per external host from a GitHub runner
│  ├─ workflows/grindstone-{ci,release}.yml  # packages/grindstone-mcp checks; npm publish on grindstone-v* tags
│  ├─ ISSUE_TEMPLATE/{feedback.yml, counter-theory.yml, data-problem.yml}
│  └─ dependabot.yml
├─ curated/                         # human-edited, PR-friendly inputs (class A, our own content)
│  ├─ hots/{heroes/<slug>.yaml, traits.yaml, rules.yaml, counters.yaml, synergies.yaml, maps.yaml, aliases.yaml, ranked-pool.yaml, creators.yaml}  # layout: docs/THEORY.md
│  ├─ mtga/meta/<format>.json       # hand-curated meta lists (grindstone snapshot format), each with sourceUrl
│  └─ pokemon/{regulations.yaml, showdown.json}  # regulation windows (UTC), formats, Showdown format ids; pinned Showdown commit
├─ pipeline/                        # Node-only orchestration
│  ├─ run.ts                        # CLI: node pipeline/run.ts [--game hots|mtga|pokemon|all] [--offline] [--out data]
│  ├─ context.ts  http.ts  store.ts  hash.ts  manifest.ts  validate.ts
│  └─ stage.ts                      # copies data/{current,private}/<game>/public/* → public/data/<game>/ with content hashes; writes the stage map
├─ src/
│  ├─ core/                         # game-agnostic, browser-safe TS (unit-tested)
│  │  ├─ game.ts                    # GameModule / DataPipeline / SourceRef / Reason / Edge types
│  │  ├─ stats.ts  tiers.ts  draft.ts  matrix.ts  urlstate.ts  search.ts  storage.ts  freshness.ts  attribution.ts  format.ts
│  ├─ components/                   # shared UI (Astro + Preact islands)
│  ├─ layouts/{Base.astro, GameLayout.astro}
│  ├─ lib/{datadir.ts, stagemap.ts, routes.ts, csp.ts}
│  ├─ styles/{tokens.css, global.css}
│  ├─ games/
│  │  ├─ registry.ts                # browser-safe metadata of all games
│  │  ├─ hots/{module.ts, schema.ts, load.ts, pipeline/, components/, theory/, fixtures/raw/}
│  │  ├─ mtga/{module.ts, schema.ts, load.ts, pipeline/, components/, worker/}
│  │  └─ pokemon/{module.ts, schema.ts, load.ts, pipeline/, components/, worker/}
│  └─ pages/                        # file-based routes (see §8)
├─ fixtures/<game>/...              # small committed snapshot shaped exactly like data/current/<game>/ (dev + PR CI offline)
├─ packages/grindstone-mcp/         # npm workspace: grindstone-mcp (MTGA engine + MCP server) with its own README, SPEC, CHANGELOG
├─ scripts/{sw.ts, data-pull.ts, plan.ts, licenses.ts, csp-check.ts}
├─ e2e/                             # Playwright smoke
├─ docs/{SPEC.md, DATA.md, OWNER-ACTIONS.md, METHODOLOGY.md, THEORY.md}
└─ (branch `data`)  current/<game>/**  history/YYYY/MM/DD/<game>.json.gz  status.json
```

Build-time data directory: `WHETSTONE_DATA_DIR` (CI: `data/`; local default: `data/` if `data/current/<game>/meta.json` exists, else `fixtures/` — per game). `src/games/<game>/load.ts` is the **only** place pages read game data (fs at build time, zod-validated, memoized).

Browser-fetched shards (draft tables, card index, dex for the builder) are staged by `pipeline/stage.ts` into `public/data/<game>/<name>.<hash8>.json` and referenced through a generated `src/generated/stage-map.json` (`{ "hots/draft": "data/hots/draft.1a2b3c4d.json" }`). Small payloads may be passed as island props instead.

---

## 4. Core contracts (`src/core/game.ts`)

```ts
export const GAME_IDS = ['hots', 'mtga', 'pokemon'] as const;   // the one list of game ids (§12 entry 24)
export type GameId = (typeof GAME_IDS)[number];
export type CustodyClass = 'A' | 'A-SA' | 'A-NC-SA' | 'B' | 'C' | 'D' | 'P';   // §1.2, §13.2
export type AttributionRule = 'inline' | 'top' | 'footer';

export interface SourceRef {
  id: string; name: string; url: string;
  attribution: string;            // exact credit text
  rule: AttributionRule;
  license?: string; tosNote?: string; custody: CustodyClass;
}
export interface SourceStatus { id: string; fetchedAt: string; status: 'ok' | 'stale' | 'failed' | 'disabled'; detail?: string }

export interface GameMeta {        // data/current/<game>/meta.json
  game: GameId; schema: number;
  version: { label: string; build?: string; since?: string };   // HotS '2.57' / build '2.57.0.98348'; Pokémon 'Reg M-C'; MTGA set code
  generatedAt: string; dataHash: string;
  sources: SourceStatus[];
  counts: Record<string, number>;  // heroes, maps, games, ...
}

export interface Reason {
  kind: 'stat' | 'theory' | 'curated' | 'role' | 'map' | 'votes' | 'pro' | 'usage' | 'community' | 'personal';
  text: string;                    // one line, plain text, already human-readable
  n?: number; delta?: number;      // delta in percentage points when kind = 'stat'
  source?: string;                 // SourceRef.id
  evidence?: string[];             // e.g. ability/talent names that justified a theory tag
  conditions?: string[];           // talents/situations it depends on, rendered "Only when …"
  cites?: { url: string; site: string; date?: string }[];   // community reasons: ≤ 5 public links
}
export interface Edge {             // directed for counters (a counters b), undirected (a<b) for synergy
  a: string; b: string;
  score: number;                   // 1..100, 50 = neutral
  delta?: number; n?: number; z?: number;
  source: 'stats' | 'theory' | 'curated' | 'votes' | 'usage' | 'replays' | 'community' | 'personal';
  reasons: Reason[];
}

export interface PipelineContext {
  http: Http;                      // pipeline/http.ts: UA, retries/backoff, per-host spacing, dev disk cache, offline fixtures
  secrets: Readonly<Record<string, string | undefined>>;  // only the names the game's registry entry lists (pipeline.env), e.g. YT_API_KEY
  previous: (file: string) => Promise<unknown | null>;    // last-good file from data/current/<game>/
  now: Date; offline: boolean; log: (msg: string, extra?: unknown) => void;
}
export interface OutputFile { path: string; data: unknown; custody: CustodyClass; public?: boolean /* staged for browser */ }
export interface PipelineResult { meta: Omit<GameMeta, 'generatedAt' | 'dataHash'>; files: OutputFile[]; issues: ValidationIssue[] }
export interface ValidationIssue { level: 'error' | 'warn'; source?: string; message: string }
export interface DataPipeline { run(ctx: PipelineContext): Promise<PipelineResult> }   // each game splits into sources/transform/validate internally

export interface GameModule {      // browser-safe metadata only; pipeline is imported lazily by pipeline/run.ts
  id: GameId; name: string; short: string; tagline: string;
  status: 'live' | 'planned';      // no beta or alpha (§13)
  accent: string;                  // CSS colour token name
  sources: SourceRef[];
  nav: { label: string; path: string }[];
}
```

Presentation (legal notice, accent colours, search path, version prefix, browser-storage rows for the privacy page, pipeline timeout and env names) is `GamePresentation`; `src/games/registry.ts` resolves `Game = GameModule & GamePresentation`, keyed by `GameId` so a game missing from either is a type error (§12 entry 24).

`pipeline/run.ts` per game: run → any `error` issue ⇒ keep last-good files for that game (or for the failing source when the game supports partial fallback), mark statuses, exit non-zero at the end; otherwise write files to `data/current/<game>/` (A, A-SA) or `data/private/<game>/` (B, C), compute `dataHash` over sorted file contents excluding `generatedAt`, write `meta.json`, and append `history/YYYY/MM/DD/<game>.json.gz` for class A summaries.

---

## 5. HotS data (schemas in `src/games/hots/schema.ts`)

Canonical ids (critique D4): hero `id` = game `attributeId` (`Abat`, `HXAL`, `CCho`, `Gall`); `slug` = lowercase alphanumerics of English name (`liming`, `thebutcher`, `xalatath`); composite `chogall` entity (members `CCho`,`Gall`, costs 2 draft slots, one page). Map slugs are our own kebab-case (`cursed-hollow`).

Files in `data/current/hots/` (class A unless noted):

| File | Content |
|---|---|
| `meta.json` | `GameMeta` + `{ build, ptrBuild?, major: '2.57', majorSince: '2026-09-28', builds: string[] }` |
| `heroes.json` | Hero[]: `{ id, slug, name, title, role (Tank/Bruiser/Healer/Support/Ranged Assassin/Melee Assassin), roleAlt?, type (Melee/Ranged), franchise, difficulty, ratings{damage,utility,survivability,complexity}, releaseDate?, aliases[], portrait, abilities[{id,name,hotkey,kind:'basic'|'heroic'|'trait'|'mount'|'active',cooldown?,cost?,text,icon}], talents{'1'|'4'|'7'|'10'|'13'|'16'|'20': [{id,name,text,icon,ability?,sort}]}, members?, mechanics[{tag, evidence:[{kind:'ability'|'talent',name,snippet}]}], lastChangedBuild?, isNew }` |
| `maps.json` | Map[]: `{ id, name, kind: 'standard'|'aram'|'brawl', ranked: boolean, rankedSource: 'curated' (the enum keeps 'stats' for type compatibility only), image, profile{size, lanes, objective, tags[]} }` |
| `patches.json` | Patch[]: `{ id, version, build?, date, title, url, kind: 'patch'|'balance'|'hotfix'|'ptr', contentHash, notes: 'summary', general: string[] (category counts), maps?, heroes: { [heroId]: { changes: [{ section, target?, level?, kind: 'numeric'|'added'|'removed'|'reworked'|'changed'|'bugfix', stat?, old?, new?, by?, unit?, count?, text, dir? }] } } }` — parsed from Blizzard's news feed/articles, merged with data diffs. Every change is our own structured summary (numbers, direction, kind); `text` is a template from those fields, never Blizzard's sentence (DATA.md). |
| `diffs.json` | Build-to-build game-data diffs per hero (abilities/talents/stats old→new). |
| `theory.json` | `{ rulesVersion, counters: Edge[], synergies: Edge[], mapFit: [{hero, map, score, reasons}] }` produced by the theory engine from mechanics + curated YAML. |
| `links.json` | Outbound links per hero (Icy Veins, Psionic Storm, Nexus Compendium, Liquipedia when the page exists, Fandom wiki). |
| `rotation.json` | Free hero rotation + ranked season (Nexus Compendium API, attributed, "as of"); `lagging: true` once its window has ended without a new week. |
| `pro.json` | **A-SA.** Liquipedia 2026 pro drafts: per-hero picks/bans/presence, sample size, tournaments; licence + attribution fields. An implausible refresh keeps last-good. |
| `public/draft.json` | Columnar browser shard for the draft tool (heroes, roles, theory edges with optional `cond` tables for reason conditions, map fit; stats merged at stage time if present). |
| `img/**` | WebP portraits, ability/talent icons, map thumbnails converted from HeroesToolChest/heroes-images at a pinned tag. |
| *(private)* `stats.json` | **B.** Generic match-statistics shapes with a `source` id: per mode and timeframe, hero games/wins/shrunk WR/pick/ban, counter & synergy matrices with n, per-map WR, talent builds. No public pipeline produces it (HotS publishes no match data Whetstone uses); the synthetic sample in `fixtures/hots/_private/` (`source: 'synthetic'`) exercises the statistics mode, and the private hub (§13.7) may supply one. |
| *(private)* `videos.json` | **C.** Optional (YouTube Data API key). Twitch is not used, so there is no `streams.json`. |

Sources (in order of trust): Blizzard TACT version server (build detection), HeroesToolChest **heroes-data2** release zip gated on `.version.json` (roster, kits, talents, text, maps, localized names), **heroes-images** (pinned tag), Blizzard news feed JSON + article HTML (patch notes, hotfix detection by content hash), Nexus Compendium `/api/currently` (rotation only), Liquipedia MediaWiki API (2 s spacing, custom UA, wikitext of {{Map}} picks/bans), YouTube Data API (optional, class C). The SL map pool is `curated/hots/ranked-pool.yaml`.

### 5.1 Theory layer (works without match statistics)

1. **Mechanics extractor** (`src/games/hots/theory/extract.ts`): deterministic keyword/regex rules over ability and talent text → tags with evidence. Vocabulary (extendable): `stun root slow silence blind polymorph sleep taunt fear displace pull time-stop | unstoppable invulnerable stasis untargetable cleanse spell-armor physical-armor block shield heal-self heal-ally stealth reveal dash teleport unkillable | percent-hp-damage anti-heal armor-shred burst sustained-dps poke aoe dot summons global waveclear siege channel aa-reliant mana-hungry`.
2. **Curated traits** (`curated/hots/traits.yaml`): per-hero tags the text can't reveal (e.g. `aa-reliant`, `immobile`, `dive`, `split-push`, `vulnerable-body`), each with a one-line justification.
3. **Rules** (`curated/hots/rules.yaml`): `{ id, a: [tags], b: [tags], weight, why: "template with {a} {b} {aTag} {bTag} {evidence}" }` e.g. blind/block vs aa-reliant; anti-heal vs heal-self/heal-ally; percent-hp-damage vs Tank/Bruiser; reveal vs stealth; silence/stun vs channel and dash-reliant divers; unstoppable/cleanse vs heavy CC; spell-armor vs burst mages; dive vs immobile backline; aoe/waveclear vs summons. Synergy rules: hard CC + burst; heal-ally + dive bruiser; shield/save + dive; global + split-push; etc.
4. **Curated pairs** (`curated/hots/counters.yaml`, `synergies.yaml`): explicit matchups with a handwritten mechanical reason, optional `conditions` (talent/situation), `confidence`, `reviewedFor: '2.57'`. Must be consistent with the current kit text.
5. **Map fit** (`curated/hots/maps.yaml`): map profile tags (`large`, `three-lane`, `two-lane`, `channel-objective`, `pve-objective`, `teamfight`, `structure-objective`, `long-rotations`) × hero tags rules (`global` on large maps, `waveclear`/`siege` on structure maps, …).
6. **Engine** (`theory/engine.ts`): score(a,b) = Σ matched rule weights (each rule counted once per pair, capped) + curated pair weight → `score = round(50 + 50·tanh(x))`; reasons = matched rules rendered with evidence (ability/talent names from current game data) + curated why. Deterministic; unit-tested; outputs `theory.json`.

---

## 6. Statistics (`src/core/stats.ts`, critique D5/D6)

- Display intervals: **Wilson** (z = 1.96). Vote-style scores (if votes ever exist): `round(100 × Wilson lower bound)` (heroescounters' verified formula).
- Hero WR: empirical-Bayes Beta shrinkage (`k` by method of moments; prior = last patch's shrunk WR for heroes unchanged in the data diff, else population mean).
- Pairs: shrink toward the **logit-additive expectation**, not 50 %. Counter expectation `e = σ(logit p̃A − logit p̃B)`; synergy expectation `e = σ(logit p̃A + logit p̃B)`; `Δ = r̃ − e` (pp); report `n`, `z`; antisymmetrize counters.
- Score 1–100 = `round(50 + 50·tanh(Δ / 0.04))`.
- Gates: hide n < 15; grey 15 ≤ n < 30; list as strong/weak only if n ≥ 50 and |Δ| ≥ 1.5 pp.
- Tiers (fixed bands on shrunk-WR − 50 %): T1 ≥ +2.5 pp, T2 +1…+2.5, T3 ±1, T4 −1…−2.5, T5 ≤ −2.5; n ≥ 200 else "early data". Show Δ vs previous patch. Per-game config (Pokémon tiers use usage + Wilson tournament WR).
- A **simulation harness** (`src/core/stats.sim.test.ts`) generates synthetic heroes with known effects at low (≈330 SL games/day) and high (≈3k/day) volumes and asserts the gates keep false-positive counters per hero page low.

---

## 7. Draft engine (`src/core/draft.ts` + `src/games/hots/draft/`)

- Generic: `scoreCandidates(state, providers, weights) → Ranked[] { id, score, signals[], reasons (≤3), warning? (≤1) }`. Providers return logit-scale signals with reasons; weights are presets.
- HotS rules (verified): Storm League order (0-based) `A-ban B-ban A-ban B-ban A-pick B-pick B-pick A-pick A-pick B-ban A-ban B-pick B-pick A-pick A-pick B-pick`; 3 bans per team (2+1); first-pick toggle; Cho'gall only at steps 5, 7, 11, 13 (two consecutive own picks) and occupies both; no mirror picks; no banned picks. "Free mode" (heroescounters-style: click to add to either team, any order, 2–3 bans) is also offered.
- Sort modes (heroescounters parity, as weight presets): **Composite** (default), **Win rate**, **Counters**, **Synergies**, **Map**, **Tier**, **Community** (only when votes exist). Counters/Synergies use stats edges when present, else theory edges (labelled).
- Role guardrails: warn/penalise picks that make a valid comp impossible (no Healer slot left, no frontline, double-healer early); Varian is flex (Tank/Bruiser/Assassin by heroic).
- Ban suggestions at ban steps (enemy-comfort/meta threat + counters to our picks).
- Personal: hero pool / owned heroes / free rotation filter (localStorage), "blind-pick safety" (fewest strong counters).
- State in URL **hash**, versioned (`#v=1&m=<map>&fp=a&s=<steps>`), ≤ ~200 chars, shareable. Tap-friendly breakdown (no hover-only).
- **ARAM helper** (`/hots/aram/`): pick 1 of your 3 offered heroes given allies/enemies so far (role logic + theory/stat signals).

---

## 8. Routes (all under `/whetstone/`)

Global: `/` (game picker, what's new across games, freshness), `/about/`, `/credits/`, `/privacy/`, `/terms/`, `/offline/` (service-worker fallback, noindex), `/404`, `/licenses.txt` (generated).

HotS: `/hots/` (hero grid: search incl. aliases/nicknames, role/franchise filters, tier & new badges, free-rotation & owned toggles, patch banner) · `/hots/hero/[slug]/` (header, Counters: strong vs / weak vs / good with — score ring, n, Δ, reasons, source badge, period toggle; Best maps; Talents by tier with builds when stats; Abilities; Patch history; Guides & links; mechanics tags) · `/hots/maps/` · `/hots/map/[slug]/` (best heroes, profile, ranked badge) · `/hots/tierlist/` (stats tiers by mode/period when statistics exist; otherwise pro presence + patch momentum, clearly labelled) · `/hots/draft/` · `/hots/aram/` · `/hots/patches/` + `/hots/patches/[id]/` · `/hots/catch-up/` (pick the date you last played → every hero change since, grouped) · `/hots/pro/` (A-SA) · `/hots/live/` (Twitch directory link + featured channels; live list only if the C-class source is enabled) · `/hots/about/` (methodology: formulas, gates, sources).

MTGA: `/mtga/` · `/mtga/deck/` (paste Arena export → legality in all formats, curve, mana sources, roles, power tier with breakdown, sample hands/mulligan sim, wildcard cost with a paper-price guide, upgrade suggestions in three versions (faithful/competitive/casual), compare to meta; share via URL hash; analysis in a Web Worker) · `/mtga/limited/` + `/mtga/limited/[set]/` (17Lands ratings, CC BY credit at top) · `/mtga/search/` · `/mtga/meta/` (curated + bring-your-own lists) · `/mtga/about/`.

Pokémon: `/pokemon/` (regulation banner + countdown, usage grid, freshness) · `/pokemon/mon/[id]/` (base stats + SP sliders, usage by source, moves/items/abilities/teammates, checks & counters, speed position, links) · `/pokemon/tiers/` · `/pokemon/builder/` (Showdown paste import/export with Stat Points, legality, type matrix, coverage, speed vs top 50, threat list via calc) · `/pokemon/calc/` (`@smogon/calc` gen 0 in a worker) · `/pokemon/speed/` · `/pokemon/teams/` (Limitless top cuts, names stripped) · `/pokemon/preview/` (team preview: their 6 vs your 6 → bring 4 + leads) · `/pokemon/about/`.

---

## 9. UI system

- Tokens in `src/styles/tokens.css` (`:root` + `[data-theme=dark]`; dark default with toggle stored in localStorage; respect `prefers-color-scheme` on first visit). Game accents: HotS violet, MTGA amber, Pokémon red. System font stack. 4/8 px spacing scale.
- Shared components: `SiteHeader` (game switcher, search, theme toggle), `SiteFooter` (disclaimers, credits), `FreshnessBadge`, `StaleBanner`, `SourceAttribution`, `EntityGrid` (+ `EntityFilter` island), `ScoreRing` (1–100), `MatchupList` (strong/weak/good-with rows: avatar, name, ring, Δ, n, reasons expandable, source badge; "View more" collapse below threshold), `TierList`, `Tabs`, `PeriodToggle`, `ReasonList`, `EmptyState`, `CopyButton`, `ShareButton`.
- Every island renders meaningful server HTML first where possible (progressive enhancement).

---

## 10. Pipeline & CI

`data-deploy.yml` (critique D3): triggers `schedule: '17 10 * * *'`, `push: main`, `workflow_dispatch(inputs: games, force_deploy)`.
0. `plan` job — `scripts/plan.ts` reads the game list and per-game timeouts from the registry (no game list in the YAML). `showdown-export` job — builds the pinned Pokémon Showdown commit and exports the dex with `permissions: {}`, no secrets and no git credentials; the Pokémon data job reads its artifact through `WHETSTONE_SHOWDOWN_EXPORT` only when it succeeded.
1. `data` job — matrix from the plan, `fail-fast: false`, per-game timeout (hots 90, mtga 30, pokemon 45). Checks out main + `data` branch (`data/current` as last-good), runs `node pipeline/run.ts --game ${{ matrix.game }}`, uploads artifact `data-<game>` (public A/A-SA and private B/C/D dirs separately). Each secret reaches only its own game's job, and the runner exposes to a game only the env names its registry entry lists; absent secrets ⇒ that source is `disabled`.
2. `publish` job (`if: always()`) — downloads artifacts, keeps last-good for failed games, commits class A/A-SA changes + history to the `data` branch (creating it orphan if absent), outputs `changed`.
3. `build` job — checkout main, restore `data/`, `node pipeline/stage.ts`, `npm run build`, post-build service worker, `upload-pages-artifact`.
4. `deploy` job — `if: changed || push || force_deploy`, environment `github-pages`, concurrency `pages`.
5. `report` job — on failure, or when a source has been degraded (serving last-good) for 2 runs in a row, open/comment a `pipeline-failure` issue; close it only when nothing is failed or degraded; run `gh workflow enable data-deploy.yml` as the 60-day keepalive. No dummy commits.

`ci.yml`: npm ci → lint → typecheck (`astro check` + `tsc` with Node resolution for the pipelines) → vitest → HotS theory validator → build against `fixtures/` → Playwright smoke (every route renders, no console errors, attribution visible on stats routes, draft flow works) → statistics-mode build (`WHETSTONE_FIXTURE_PRIVATE=1`) with the HotS page, draft and ARAM specs.

Optional secrets and variables: `YT_API_KEY` (HotS only) · repository variable `LIQUIPEDIA_UA_CONTACT` · `DATA_ARTIFACT_KEY` (only needed if a class-B source is ever added) · `NPM_TOKEN` (grindstone-mcp releases). No Twitch credentials (not used).

---

## 11. Roadmap (from community research, hots-roadmap.md)

**v0.1 (this build)** — HotS: data-driven roster with new-hero badges + freshness; hero/map pages with counters (theory; statistics when a source that meets §1.3 supplies them) and honest sample sizes; true-order SL draft + free mode with step-aware pick/ban suggestions, role guardrails, why/watch-out lines; hero pool/owned/free rotation; share links; tier list; patch notes + catch-up since you last played; ARAM pick-1-of-3 helper; pro presence; outbound guides; mobile-first, dark mode, alias search; feedback via issue forms; PWA offline shell. MTGA: deck analyzer on grindstone core, Limited ratings, curated meta, card search. Pokémon: MVP pages + builder + calc + speed + teams + team-preview assistant.

**Next** — §13 (v2: two more games, community consensus, personal statistics through the private hub); matchup-aware talent builds with "trap talent" flags + copyable build string (verify format); ARAM/QM stat views; YouTube guides; i18n (heroes-data2 has 12 locales); `whetstone-mcp` (class-A data only) alongside grindstone; draft quiz/onboarding; win-probability ranges after calibration.

**Later** — opt-in community votes/tags via one Cloudflare Worker (D1 + Turnstile), shared by all games (owner gate); browser-only replay import; async tournament drafts/OBS view; matchup heatmap.

**Never** — opponent scouting by player name; ads/trackers; scraping forbidden sources.

---

## 12. Decisions log

Where the sections above were ambiguous or the parallel builds disagreed, the integrator picked the simplest consistent option. Each entry is binding until a later entry replaces it.

1. **Every nav entry resolves.** A `GameModule.nav` path without a page file is served by `src/pages/[game]/[...section].astro`, a placeholder that is `noindex` and left out of the sitemap. `src/lib/routes.ts` (`pendingSections`) drops a section as soon as `src/pages/<game>/<section>.astro` or `<section>/index.astro` exists, so a real page never collides with its placeholder. The e2e smoke test runs strictly: no `SMOKE_ALLOW_MISSING` in CI.
2. **Repo root.** `src/lib/datadir.ts` finds the repo by walking up to the `package.json` named `whetstone`, falling back to `cwd`. It no longer trusts `import.meta.url` alone, because Astro bundles it into chunks elsewhere. The Vite plugin that rewrote `import.meta.url` was removed.
3. **Browser shards.** Pages resolve staged shards at build time with `stagedUrl(game, name)` or `stagedUrlOrNull` from `src/lib/stagemap.ts`, and pass the URL to islands as a prop. Islands never import `src/generated/stage-map.json`. `npm run build` and `npm run dev` (via `predev`) run `pipeline/stage.ts` first.
4. **Output validation.** Game pipelines validate their outputs with `validateFiles(files, <GAME>_FILES, { overlays })` from `pipeline/validate.ts`. The rules:
   - A `<name>` segment in a registry key matches one path segment.
   - The emitted custody class must equal the registry's, or the run gets an error.
   - Class-B/C files on an overlay path (`HOTS_PRIVATE_OVERLAYS`) are checked against the overlay schema.
   - Unregistered JSON is a warning.
   - `meta.json` and `_files.json` are written by the runner, never by games.
5. **Internal shards.** A public shard whose file name starts with `_` is staged and mapped but never listed in `public/data/manifest.json`. The MTGA card index is `public/_cards.standard.json` and `public/_cards.arena.json`, so it is not advertised as a dataset.
6. **Units.** Every `delta` (Edge, Reason, gates, tiers) is in percentage points. §6's `tanh(Δ / 0.04)` with Δ as a fraction is implemented as `scoreFromDelta(Δpp) = round(50 + 50·tanh(Δpp / 4))`; the two are the same.
7. **Gates.** `GATES` keep the §6 values. `stats.ts` also offers an optional `|z|` gate (`listMinAbsZ`, with `HIGH_VOLUME_MIN_ABS_Z = 2.5` suggested). The simulation shows it is needed at about 3k games/day with strong effects. It stays **off** (0) until the owner decides from real statistics volume, and `docs/METHODOLOGY.md` and `/about/` must change with it.
8. **Draftable entities.** Every score-bearing file (theory, stats, pro, the draft shard) is keyed by draftable entity id, with Cho'gall as the composite `chogall`. Patches, links and rotation stay keyed by member hero ids (`CCho`, `Gall`). The HotS pipeline emits the composite record.
9. **Private stats in the draft shard.** Statistics from a private (class B) source reach the draft tool only as the overlay `private/hots/public/draft.json = { stats }`, merged by `stage.ts`. The public manifest keeps pointing at the pure class-A shard.
10. **Meta details.** `SourceStatus.fetchedAt` is `string | null` (null = never fetched). Each game's `meta.json` schema requires its own `extra` block, although `GameMeta.extra` is optional in `game.ts`. Optional keys are omitted, never written as `undefined`.
11. **Loader rows and component props.** The HotS loader's matchup row type is `HeroMatchupRow`, renamed so it no longer collides with the shared component's `MatchupRow` props. `src/games/hots/view.ts` converts one to the other with `toMatchupRow`, and also provides `heroHref` (`/hots/hero/<slug>/`) and `heroPortrait`. Images that `stage.ts` copies unchanged (`img/**`) are addressed with `assetHref(game, rel)` from `src/games/registry.ts`. Hashed JSON shards go through `stagedUrl` (entry 3).
12. **E2E isolation.** Playwright never reuses a server it did not start (`SMOKE_REUSE=1` opts in locally), and `e2e/global-setup.ts` compares the served home page with the `index.html` of the build under test (`dist/` or `WHETSTONE_OUT_DIR`). A busy `SMOKE_PORT`, `astro preview` hopping to another port, or a stale preview from another checkout fails the run instead of testing the wrong build.
13. **Data directories.** `WHETSTONE_FIXTURES=1` skips `data/` (an explicit `WHETSTONE_DATA_DIR` still wins); Vitest sets it, so unit tests always read `fixtures/`. The private (B/C) directory pairs with the chosen data directory and is never mixed: `<root>/private/<game>` for a pipeline output, `fixtures/<game>/_private` (only with `WHETSTONE_FIXTURE_PRIVATE=1`) for fixtures, whose `_private/public/**` overlays `stage.ts` merges like `data/private`. `src/lib/datadir.ts` and `pipeline/stage.ts` implement the same rule.
14. **Service worker.** The precache holds only what every visitor needs: Web Worker chunks (`_astro/*.worker-*.js`: the damage calc, the deck analyzer) are cached on first use, and the stale-while-revalidate data route skips internal `_`-prefixed shards, which their own worker keeps in IndexedDB (the MTGA card index).
15. **GitHub API and status-driven APIs.** `GITHUB_TOKEN` is a pipeline secret; `pipeline/http.ts` sends it as a bearer token to `api.github.com` only (`bearer` option, wired in `run.ts`), and the data job passes the workflow's own token. `Http.request()` returns `{ status, headers, body }` for APIs that answer in statuses and keep their own 202/429/budget logic (no status retries, no dev cache, never recorded as a fixture).
16. **Theory output and lists.** Engine `RULES_VERSION` 1.5: generic edges within ±4 of 50 are not stored (curated pairs always are); a counter rule matching both ways round only counts by its net advantage; reasons that need a talent or one Heroic say "Only when … takes …". Hero pages list theory edges that are curated or score ≥ 65 (`THEORY_GATES`), curated first; the rest sits below the bar. Rules: anti-heal-vs-sustain targets healers only, percent-Health damage is one rule for tanks and bruisers, dive against fragile heroes is milder than against immobile ones.
17. **Draft shard schema 2.** Reason lines are templates with `{a}`/`{b}`/`{m}` name tokens, and talent conditions are separate parts referenced as `[i, j(, k)]`; `draft/data.ts` fills them in. Consumers of the public manifest must read `schema` before decoding reasons.
18. **Redirect slugs.** Composite members, hyphenated hero aliases (heroescounters.com's `li-ming`) and compact map slugs (`cursedhollow`, plus aliases that start one, like `hanamura`) are noindex meta-refresh pages generated from data (`src/games/hots/redirects.ts`) and filtered out of the sitemap. A real slug always wins; an ambiguous alias is dropped.
19. **One hero-pool module.** `src/games/hots/pool.ts` owns the pool contract for the grid, the draft and the ARAM helper, including the tolerant reading (envelope or bare value, entity ids, member ids or slugs). The core `Store` gained `raw()` for that.
20. **Stale free rotation.** A rotation whose window ended before it was fetched (Nexus Compendium lagging the weekly switch), or that the pipeline flagged `lagging` (entry 25), is shown as "not listed yet" and marks no hero free (`rotationIsStale`, `currentRotation`).
21. **Fixtures from real data.** `fixtures/hots` is generated from a live run by `src/games/hots/fixtures/make-fixtures.ts` (same 15-record cast and 6 maps, real kits, mechanics, theory edges, patches and images); `pro.json` and `_private/**` stay synthetic (Liquipedia data is CC BY-SA; licensed and ephemeral sources are never committed). `fixtures/pokemon` carries real sprites for its species. Tests and e2e assert real facts of those fixtures, and the e2e suite also passes on a live-data build.
22. **Sprite credit.** The self-hosted Pokémon sprites are credited through a footer-rule `SourceRef` (`showdown-sprites`), so the credit appears on every Pokémon page and the credits page.
23. **Statistics source removed; own the tooling (2026-10-10).** Heroes Profile is gone from code, docs, secrets, workflows and owner actions, and no other HotS statistics source replaces it (§13). The generic statistics shapes stay, each with a `source` slug: the synthetic fixture sample says `synthetic`, and a private source (the hub) may supply its own. Credits are driven by that id: a source id with a `SourceRef` is credited inline; one without (the synthetic sample) is never shown as a raw id, and `StatsCredit` shows the "sample, not real matches" label instead. Old last-good files still parse: keys only the removed source used (`meta.extra.hpMode`, map `hp` refs) are dropped, and so are links to a site the pipeline no longer links. `MapSchema.rankedSource` keeps `'stats'` for type compatibility; the pipeline always writes `'curated'`. The talent build code is marked "Unchecked" (the format awaits one in-game check) instead of "beta".
24. **Platform.**
    - *No beta:* `GameModule.status` is `'live' | 'planned'`; no beta or alpha label anywhere (e2e asserts it).
    - *Registry:* `GAME_IDS` (`src/core/game.ts`) is the only list of games; `GameIdSchema` and the manifest derive from it. `Game = GameModule & GamePresentation`; presentation defaults live in the registry's `PRESENTATION` record and a module's own fields win. Adding a game = a `GAME_IDS` entry, a module and its `MODULES`/`PRESENTATION` entries (both `Record<GameId, …>`).
    - *Workflow:* the data matrix comes from `scripts/plan.ts` (it imports only the registry, so the plan job needs no `npm ci`). Secrets are scoped twice: the workflow passes each one only to its game (`matrix.game == 'x' && secrets.X || ''`) and the runner exposes only the registry's `pipeline.env` names. `GITHUB_TOKEN` is only a bearer for `api.github.com`. The `showdown-export` job runs with `permissions: {}` (give it `contents: read` if the repository ever becomes private).
    - *Custody hardening:* a degraded source raises the `pipeline-failure` alert after 2 consecutive runs, and the freshness badge is at best "aging" while a source lags ("stale" once its oldest last-good data is). `pack` always writes a bundle (an empty tombstone when there is nothing private); `restore` isolates failures per game; `data-pull` reads blobs from the cache repo; the data job deletes the branch's `status.json` before running and `publish.ts` rejects a status not newer than the branch's.
    - *Service worker:* saved pages and data shards expire after 7 days (images 30); caches are versioned (`SW_CACHE_VERSION` = 2) and unknown `whetstone-*` caches are deleted; private (B/C/D) shards are staged under `_private/` and never cached.
    - *CSP:* `script-src 'self'` plus hashes, no `unsafe-inline` for scripts. Constant inline scripts register their hash from the frontmatter with `allowInlineScript()` (`src/lib/csp.ts`); a post-build guard (`scripts/csp-check.ts`) fails the build on any unhashed inline script or inline handler. `style-src` keeps `'unsafe-inline'` for element and attribute styles.
    - *Licences:* every build writes `dist/licenses.txt` from the packages actually bundled (client and worker chunks, Workbox, Astro's island runtime). The data branch gets `LICENSE` (MIT, Whetstone's own data) and a generated `NOTICE.md` on every publish.
    - *Accessibility:* below 48rem `--header-h` is the real two-row header height (109 px, from tokens); `--control-border` (3:1 or more on every surface) outlines form controls; forced-colours rules cover pressed, selected and current states and background-drawn markers.
    - *Twitch:* not used (no data, no credentials); its hosts stay in `NO_RECORD_HOSTS` and `player.twitch.tv` in `frame-src`, because `/hots/live/` loads featured channels on click.
25. **HotS pipeline.**
    - *Rotation:* `rotation.json` carries `lagging: true` when its window ended before the run (fresh, unchanged or last-good). The flag is content, so the switch day changes `dataHash` and redeploys; `fetchedAt` stays the time the content was first fetched.
    - *Liquipedia:* a refresh with no drafted maps, or fewer than half of last-good's maps within the same window label, is a source failure (last-good kept, `stale`). A new window label or a first run is not judged.
    - *Patch notes:* stored only as our own structured fields (kind, stat label of at most four words or our own vocabulary, numbers, unit, computed direction) with a template `text`; ability and talent names are kept as targets of at most six words; general sections become category counts. An 8-word verbatim guard runs last inside the parser. Old last-good files are summarised again by the pipeline and cut down to counts by the schema on read. Game-data numbers are not repeated next to a numeric change about the same target. The patch pages show titles in one date format ("Hotfix, 5 Oct 2026"), applied by the loader.
    - *Builds:* when `.version.json` is unknown, `meta.extra.builds` keeps last-good builds of the same major instead of collapsing to the live build.
    - *Draft shard conditions:* an optional sparse `cond` table per edge list (`{ e, k, c }`, at most 8 conditions per reason); still schema 2, byte-identical without conditions, `Reason.cites` not encoded. The island decodes it into each line's conditions after the engine's inline ones, each said once.
    - *Fixtures* are regenerated with `make-fixtures.ts` from an offline run that uses the latest live data as last-good with only `tact` refreshed: exact and reproducible, same 15-record cast.
    - The heroes-images "build switch removes all artwork" claim was dropped rather than implemented.
26. **HotS theory and pages (rules 1.6).**
    - *Netting:* hero pages net counter pairs like the draft: value = atanh((score − 50)/50), net = value(you → them) − value(them → you), shown as 50 + 50·tanh(|net|); each opponent appears in one list, reasons winning side first; an exact wash is dropped; a row counts as curated only when the winning direction is.
    - *List bar:* curated, or generic ≥ 65 and among the hero's 8 strongest generic rows in that list (`THEORY_GATES.listMaxGeneric`); every other row above 50 sits below the bar.
    - *Conditions:* curated conditions are clauses that read after "Only when", kept per why line in `Reason.conditions`, never baked into `theory.json` text; pages fold them in as " Only when A, and B." with the same wording as generated talent conditions; when several picks give a tag, every one is named ("Lightbomb or Censure").
    - *Curator policy* (THEORY.md): an effect resting entirely on one talent or one of two Heroics gets conditions and low confidence; an optional extra on a base-kit claim says "if X takes it" and keeps its confidence; never both Heroics together; kill claims must hold numerically; copies of one pair in two files use identical text. Files that rate one pair differently produce a loader warning, and the repository must merge warning-free (tested).
    - *Page weight:* 6 full rows per counter list (6/3 on the hero maps tab, 8/4 on map pages), the rest light rows; heavy components and `MatchupRowItem` use global, prefixed styles (no scoped `data-astro-cid` attributes).
    - *Maps:* "Best maps" lists maps above 50, "Harder maps" those below, hardest first; map pages split hero lists the same way. A "Before <major>" catch-up shortcut appears only when that major's start is known.
    - *Redirects:* heroescounters section paths (`hero/` → hero grid, `map/` → maps, `teampicker/` → draft, `watch/live/` → live) are noindex meta-refresh pages out of the sitemap; multi-word map aliases also get their compact form.
    - *Ranked pool:* curated only, confidence low, justified by public notes. The theory notice and tier list say HotS publishes no match statistics Whetstone can use.
    - *Extractor:* Stealth given to one ally, or "while Stealthed grants Invisible", is not the hero's own Stealth (Medivh); team-wide Stealth still counts.
27. **HotS draft.**
    - *Healer:* only a curated list stands in for a Healer (Medivh, Zarya; or a curated `healer-sub` tag if one is ever added); the extractor's `shield` tag includes self-shields, so it is not used.
    - *Evidence cap:* each provider's signals of one key are soft-capped together, KEY_CAP·tanh(sum/KEY_CAP) with KEY_CAP = 1.0 (≈ 4 pp), shared out in proportion. Soft role penalties grow × 1.75 on a team's last two picks (× 1.25 in ARAM). Last-pick no-waveclear and low-hard-CC penalties are 0.2 (0.15 in ARAM), only when someone available could fix the gap.
    - *Bans:* breadth = 0.45·(1 − e^(−S/12))·min(1, enemy picks left / 5), S = summed counter strengths. Theory mode adds a pro ban prior (pro ban rate shrunk with 20 pseudo-maps, (shrunk − mean)·3 on the tier key), passed to the island as a build-time prop from `pro.json`.
    - *Order:* ties go to the summed `DraftSignal.tiebreak`, then the display name (Intl.Collator), never the id; core `scoreCandidates` takes an optional `nameOf` for the same rule (Pokémon team preview passes it). With three or more shown scores within 2 points the list says it is a shortlist.
    - *Wording:* one headline line per theory edge; statistics worded as a verdict only when listable (n ≥ 50 and |Δ| ≥ 1.5 pp), neutral and breakdown-only otherwise.
    - *Credits* are data-driven: `sourceCredits()` maps every HotS `SourceRef` to an inline credit; islands credit only the source ids their shown signals carry.
    - *Review card:* the same evidence bar as hero pages; counter edges net of the reverse edge, below 0.1 left out; copyable plain-text summary. In free mode the other team's list is an opt-in toggle whose entries are actionable without moving your target.
28. **MTGA.**
    - grindstone-mcp is the workspace package `packages/grindstone-mcp` (0.3.1), imported as `grindstone-mcp/core`; the vendored copy, its sync script and its import alias are gone. Links point to the package's path in this repository. 0.3.1: no downgrade upgrades, reliable ramp detection, fetch lands take the colours of the deck's own lands.
    - *Upgrades:* the default change cap is "Version's own" (faithful 25 %, competitive none, casual 15 %); Light/Normal/Heavy/Any override it. The page reads the caps from `PROFILE_CHANGE_PERCENT` (pinned to grindstone's `PROFILES` by a test) so the main bundle never loads grindstone. Required swaps (banned, off-Arena, companion breakers, casual feel-bad) are always ticked; optional swaps only when meta lists steered them. "Prefer mythics and rares" is a remembered default sent with each request (grindstone's preferences.json semantics) and never exceeds the wildcard budget.
    - *Prices:* "about $X" at each card's cheapest paper printing, always labelled as a paper guide; hidden when the shards carry none.
    - *Curated meta:* 10 Standard lists from Wizards' magic.gg articles, card names and counts only, with `sourceUrl`, `date` and `metaShare` where the article reports one; refreshed about monthly (OWNER-ACTIONS).
    - *UX:* text pasted before hydration is kept (read in the `useState` initializer) and submit stays disabled until ready; low-sample rows sort last on win-rate columns (both directions); banned formats on their own "Banned in" line; sideways-scrolling tables are focusable named regions.
29. **Pokémon.**
    - *Speed:* stages first, then Tailwind, Choice Scarf and Iron Ball chained as 4096-based modifiers rounded once, paralysis last (matches Showdown and @smogon/calc). Comparisons use the 50 most used Pokémon at their most common spread and item, with Scarf applied (and labelled) when it is the most used item.
    - *Pastes:* EVs versus Stat Points is decided per set (a stat above 32, or more than 130 in the set, means EVs); a 67–130 point set with nothing above 32 stays Stat Points and gets an over-budget error.
    - *Team preview:* replay reasons claim a direction only past the list gates (n ≥ 50, |Δ| ≥ 1.5 pp); a Mega Stone holder's registered Intimidate counts on the way in. Calc percentages are floored like the calc's description. Share links decompress to at most 16 KB and six sets.
    - *Showdown:* the dex is built from the commit pinned in `curated/pokemon/showdown.json` (a bump is a pull request), exported by the isolated job and validated again by the data job; an unchanged pin re-emits last-good with no network; `WHETSTONE_SHOWDOWN_BUILD=local` lets a developer build locally (ignored on CI).
    - *UX:* a failed dex load explains itself with Try again; calc and team preview render sized placeholders while the dex loads (CLS < 0.1); regulation dates use one format; the weakness matrix uses visually hidden text; forme panels carry a visually hidden h2 so the outline never skips a level.
30. **Privacy and legal.** Record mode scrubs Limitless standings, Showdown replay searches and battle logs to placeholders before saving; YouTube calls are `noRecord`; `pipeline/fixture-privacy.test.ts` checks every committed fixture. The privacy page has a YouTube section (what is fetched, 30-day retention, YouTube Terms of Service, Google Privacy Policy, Google security settings); `/terms/` carries the YouTube Terms of Service clause; video credits link the YouTube Terms of Service.
31. **Integration of the six fix branches (2026-10-11).** Merged with `--no-ff` in the order platform, hots-pipeline, hots-content, hots-draft, mtga, pokemon. The statistics-mode e2e accepts the synthetic sample label as the statistics credit; the Pokémon Scarf e2e pins exact facts on fixtures and checks mon page and team preview against each other on live data.

---

## 13. v2 — owned data, five games, personal stats (Troy's rulings, 2026-10-10)

Rulings (binding): **no beta/alpha** — every shipped game is `live`; **own the tooling** — the foundation is first-party public data, openly licensed data, our own curation and our own analysis of public discussion, never a third-party aggregator; **track Troy's own games** where technically possible; hosting beyond Pages is fine (**public site stays on GitHub Pages; a private hub runs on the home box, tailnet-only**). The former third-party statistics source is **removed** (code, docs, secrets, owner actions; §12 entry 23). Research: session scratchpad `research2/*.md` (critique.md errata win).

**Status (2026-10-11).** Built in the first wave: the rulings above (no beta, statistics source removed, own tooling), the parts of the §13.3 contract the shipped games use (`GAME_IDS`, the custody classes, the community and personal reason and edge kinds, `Reason.cites`, `Reason.conditions`), and the per-game work in §12 entries 23–31. **Planned in the next wave:** the Dead by Daylight and The Duskbloods modules (§13.4–13.5), the curated consensus layer and the community signal rules (§13.3), the community miner (§13.6), the personal statistics helpers, whetstone-hub (§13.7) and the desk agent (§13.8). Until a section's code exists, its text is the plan, not a description of the site.

### 13.1 Games

| id | Name | Route | Data edition | Status |
|---|---|---|---|---|
| `hots` | Heroes of the Storm | `/hots/` | live patch | live |
| `mtga` | MTG Arena | `/mtga/` | live Scryfall snapshot + 17Lands sets | live |
| `pokemon` | Pokémon Champions | `/pokemon/` | live regulation | live |
| `dbd` | Dead by Daylight | `/dbd/` | live patch (10.2.0 on 2026-10-06) | planned in the next wave |
| `duskbloods` | The Duskbloods | `/duskbloods/` | **network test (Aug 2026)** until launch — every page carries an edition banner "Based on the August 2026 network test; details will change at launch"; the pipeline detects release and flips to `launch` after a curation sprint (runbook in docs/DUSKBLOODS-LAUNCH.md, to be written with the module) | planned in the next wave |

Every shipped game is `status: 'live'`; a planned game joins `GAME_IDS` when its module ships. No "beta" badge, label or copy anywhere on the site (done; e2e asserts it).

### 13.2 Custody classes (extends §1.2)

- **A-NC-SA** — CC BY-NC-SA data (Dead by Daylight wiki.gg). Separate files, licence + attribution fields, credited inline where shown. Non-commercial forever.
- **A-SA** additionally covers CC BY-SA 4.0 (theduskbloods.wiki.gg).
- **D — derived from public posts** (community miner): aggregated signals only (counts, contested flag, ≤5 permalinks, our own template wording; never quotes, never usernames). Built every run into the Pages artifact; **never committed**; the build drops a D bundle older than 72 h. The miner's working ledger (post permalinks, HMAC'd poster ids, extracted claim fields, no raw text) is stored **encrypted** (DATA_ARTIFACT_KEY) and deleted claims are purged on the daily recheck.
- **P — personal** (Troy's games): lives only in the hub's SQLite and its backups. Never in git, Pages, CI artifacts or logs. Other players are HMAC'd with a hub-issued pepper; names, battletags, ids, chat never leave the desk agent.

The types and the runner's routing exist (`CustodyClass`; the runner rejects any P output and never commits D); no source emits A-NC-SA or D yet.

### 13.3 Contract additions (src/core/game.ts and schemas)

Done:
- `GAME_IDS` is the single list of game ids; `GameId` and `GameIdSchema` derive from it.
- `CustodyClass` += `'A-NC-SA' | 'D' | 'P'`.
- `EdgeSource` += `'community' | 'personal'`; `ReasonKind` += `'community' | 'personal'`; `Reason.cites?: { url: string; site: string; date?: string }[]` (≤5); `Reason.conditions?: string[]`.

Planned in the next wave:
- `GAME_IDS` += `'dbd' | 'duskbloods'` (with their modules).
- Community signal value is capped (|value| ≤ 0.5 in draft logits; rings 27–73) so it can never outscore real statistics; gates: store ≥3 distinct posters, list ≥5 posters and |c| ≥ 0.2; `contested` flag.
- stats.ts additions (personal): `betaInterval`, `posteriorAbove`, `deltaPpFromScore`, `discountedCounts`, `fitBayesLogit`, `PERSONAL_GATES` (early below n=20; claim at n≥20 & P≥0.9; pair claims n≥30 & P≥0.95).
- Curated **consensus** layer for every game: `curated/<game>/consensus.yaml` — claims in our own words, each with ≥1 thread URL + date, confidence, `contested`, `reviewedFor`; class A; loaded by each game's theory/pages as `source: 'community'` reasons with cites.

### 13.4 Dead by Daylight module (`src/games/dbd/`) — planned in the next wave

Sources: deadbydaylight.wiki.gg (MediaWiki API; `Module:API` JSON dumps + Lua data tables parsed with `luaparse` — never execute Lua; ~12 sequential requests/day, contact UA, `maxlag`; A-NC-SA), Steam News API `ISteamNews/GetNewsForApp` appid 381210 (patch notes → short factual change lines with buff/nerf direction), deadbydaylight.com roster/news. Self-hosted WebP icons (perks, add-ons, items, offerings, powers) and portraits of BHVR-original characters credited to Behaviour Interactive; licensed (franchise) characters shown as text badges. **Never**: anything that reads game files/memory/network, pre/in-match info, nightlight.gg, tricky.lol, the official stats tracker scraping, BHVR forums (closing 2026-10-31).
Theory engine on the HotS pattern: effect-atom extractor over structured wiki values/text; curated killer traits + map tags; rules for perk-vs-killer-power counters, killer-vs-map fit, survivor counters, conflicts; curated matchup pairs with `reviewedFor`; **build scorer** applying the game's diminishing-returns rules exactly (archetype coverage, conflicts, team mode for SWF).
Pages: home (Shrine of Secrets countdown, patch banner), killers + killer pages (power, add-ons, perks, counters/anti-strats, best maps), survivors + pages, perks explorer (filters, patch history), add-ons, items, offerings, maps (tiles/size notes from curated facts), 2v8 reference, **build planner** (killer & survivor; synergy/conflict scoring, share via hash), **matchup guide** (survivor vs killer; killer vs survivor-build archetypes), Shrine odds, patches + catch-up, smart randomizer, Bloodpoint planner, tiers (theory + official BHVR-published stats only, labelled), methodology/about.

### 13.5 The Duskbloods module (`src/games/duskbloods/`) — planned in the next wave

Sources: FromSoftware's official network-test Gameplay Guide + Online Manual (facts and our own ≤140-char paraphrases; content hashes detect revisions), official news list (JP titles keyword-classified), Nintendo JP RSS filter, Nintendo US store date watch, theduskbloods.wiki.gg (A-SA, CC BY-SA 4.0, 2 s spacing). Our own SVG glyphs only (no official images). Every entity carries `edition`.
Model: Bloodsworn (6 in test; kits, skills, aspects), kin (8; Ring/Blade/Eye circles), affinities (iron/fire/lightning/poison), Powers of Blood, items, lands, systems (4 phases, culling 8→6→3, Moon Blood Bestowal, Virtue types + official tie-break, rules Standard/No Alliances/Bloodbound, queues Casual/Ranked).
Theory with a Duskbloods tag vocabulary (ranged-precision, transform-charge, stealth, committal-moveset, low-hp, max-hp-steal, anti-leader, …) and universal counters (shield, howl, guard counter, verticality), kin fit, affinity fit; curated consensus seeded from public network-test discussion (own words + links).
Pages: home (edition banner, release tracker, news timeline), Bloodsworn + pages (kit, matchups, kin/affinity fit), kin, systems explainer (Virtue, culling, tie-break, rules), **matchup explorer**, **phase planner** (route/virtue planning per rule), loadout notes, patches (App/Regulation split, empty until launch), methodology. Personal log via the hub quick-log + results-screen OCR (in-browser Tesseract.js on label-anchored regions; both result tabs).

### 13.6 Community miner (GitHub Actions, `pipeline/community/` + per-game adapters) — planned in the next wave

Runs inside data-deploy as its own matrix job after the game jobs. Sources (approved): Blizzard HotS forums (Discourse JSON, robots-checked), Steam reviews API (DbD 381210, MTGA 2141910), Smogon forum RSS (Pokémon). **No Reddit** until Troy's application is approved in writing (adapter unbuilt, `REDDIT_MODE=off`); no YouTube/Discord/X/Steam discussions/Fextralife/GameFAQs/BHVR forums. Pipeline: robots guard → incremental fetch (cursor) → cleanup + keyword prefilter → **Claude Haiku 5.5** extraction with structured output (sync Messages API, small concurrency; batch optional) into claim fields (subject/object entity ids resolved against the game roster, claim type, polarity, conditions, version, confidence, joke flag) → weighting (likes log-capped, recency half-lives by claim type, patch decay) → aggregation (one poster once, thread cap) → D bundle + encrypted ledger. Budget: `COMMUNITY_MODE=off|dry|on`, hard cap **$5/month** (Troy) tracked in the encrypted ledger, $0.50/run, per-game item caps, pre-flight estimate; every request < 1¢. Secrets: `ANTHROPIC_API_KEY`. Raw post text exists only in runner memory. Deleted posts purged daily. Evaluation harness (golden set format + metrics) ships with it; ship gates documented. A Reddit Data API application for Troy to submit goes in docs/REDDIT-API-APPLICATION.md (a draft exists in the session scratchpad).

### 13.7 whetstone-hub (private, `hub/`) — planned in the next wave

Per research2/hub-architecture.md: Node 24 LTS (release bundles the pinned official binary, SHASUMS-verified), Hono 4 + @hono/node-server, `node:sqlite` (WAL, defensive), zod 4, esbuild single-file bundle; UI = a second Astro static build served same-origin (self-hosted assets). Binds **127.0.0.1:5280**; Troy publishes with `tailscale serve --bg --https=5281 http://127.0.0.1:5280` (never Funnel). Auth: browser routes require `Tailscale-User-Login` ∈ `HUB_ALLOWED_LOGINS` + CSRF + secure headers; agent routes require per-device bearer tokens (`wsh_…`, SHA-256 hashed at rest, minted on the box). `/health` without personal data. systemd unit `whetstone-hub` (account `whetstonehub`, StateDirectory 0700, UMask 0077, standard systemd hardening, MemoryHigh 160M / MemoryMax 200M, CPUQuota 50%). Snapshots via `node:sqlite` backup → integrity_check → tiered retention → root handoff into the home box's existing offsite backup (≤2 deletes/pass). Updates: pull-on-press (`whetstone-hub-update.path` + root oneshot: validate tag, download from the fixed repo, sha256 verify, self-check, flip symlink, health-check, auto-rollback). Releases via `.github/workflows/hub-release.yml` (`hub-v*` tags, provenance attestation). Jobs: Steam poller for DbD (`GetUserStatsForGame` every 6 h + while playing via `GetPlayerSummaries`; own Steam key in the hub's 0600 env), daily pull of the public Pages manifest for joins.
Features: ingest API (idempotent on client ULID + content hash, watermarks), quick-log PWA (`/log/<game>/`: Champions team/opponent six/brought four/result; Duskbloods results via OCR draft + confirm; DbD console match card; generic), capture inbox (screenshots → in-browser OCR drafts → confirm), corrections table (Troy's edits win), personal dashboards `/me/<game>/` (WR with Beta intervals, by hero/map/teammate/opponent; MTGA decks/matchups/limited; DbD per-day deltas; Champions team records; Duskbloods placements/virtue mix), **HotS bracket model** (hero strength at his bracket, theory calibration, party effect) and a personal draft/ARAM view re-weighted by his data. The public site's generic statistics shapes (§5 `stats.json`, the draft shard's `stats` overlay with a `source` id) are the contract the hub can feed. Docs: docs/HUB.md runbook (10 steps), notes for the home box's operations docs.

### 13.8 Desk agent (`agent/`, .NET 10) — planned in the next wave

Framework-dependent WinExe started by a per-user logon scheduled task. HotS replay watcher (known-folder Documents, skip OneDrive placeholders, 10-min rescan, Heroes.StormReplayParser; quarantine suspect parses of unseen builds), MTGA `Player.log` tail (handles Player-prev.log rotation; Troy enables Detailed Logs), SQLite outbox with idempotent PUTs + backoff, hourly heartbeat, DPAPI-stored device token, self-update from the hub with SHA-256 check. Wire contract = JSON Schema generated from the hub's zod schemas + shared golden fixtures. Leak-guard tests: no names/battletags/ids/chat ever leave the agent. CI on windows-latest (GitHub-hosted).

### 13.9 What stays on GitHub vs the box

GitHub Actions + Pages: all public data pipelines, the community miner, the public site, hub/agent release builds. The home box: only the hub (personal data, Steam polling, private pages). The public site never depends on the hub; the hub only reads public data. Today only the GitHub side exists.
