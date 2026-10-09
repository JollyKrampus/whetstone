# Whetstone — specification (v0.1)

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
   - **B — licensed**: Heroes Profile (HP). **Never committed anywhere.** Fetched fresh each run into `data/private/`, shipped only inside the Pages artifact under content-hashed names. Kill switch `HP_MODE=off` (default **off** until the owner has HP's written OK).
   - **C — ephemeral**: Twitch/YouTube metadata. Never committed; artifact only; the client hides it when older than its retention (Twitch 90 min display / 24 h max, YouTube 30 days).
   - Player names/handles from Limitless or Showdown are stripped at ingest. Only aggregates are published.
3. **No keyless Heroes Profile `openApi` calls in any production code** (HP ToS: keyless endpoints are not for data collection; sunset 2027-01-01). HP is used only through the v1 API with `HP_API_KEY`.
4. **No scraping** of sites whose terms forbid it (heroescounters.com, Icy Veins, HP website, Pikalytics, MTGGoldfish, untapped, mtgdecks, MTGTop8, Wizards decklist pages, Smogon analyses). Link out instead. Never import heroescounters' votes, tags or videos — copy UX patterns and verified formulas only.
5. **Attribution is a component, not an afterthought.** `SourceAttribution` renders each source's required credit per its rule (`inline` = same screen as the data, body-size text with a link — HP; `top` = top of page — 17Lands CC BY; `footer`). Every page footer carries the non-affiliation disclaimers (Blizzard, Wizards of the Coast Fan Content Policy, The Pokémon Company, heroescounters.com, Heroes Profile) and the Blizzard ©/™ line on HotS pages. Non-commercial: no ads, no trackers, no paywall.
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
- npm, single package, `package.json` `"imports"`: `#core/*` → `./src/core/*`, `#games/*` → `./src/games/*`, `#pipeline/*` → `./pipeline/*`, `#vendor/*` → `./vendor/*`.
- GitHub Actions: `actions/checkout@v7`, `actions/setup-node@v7`, `actions/cache@v6`, `actions/upload-artifact@v5`/`download-artifact@v6` (verify latest majors), `actions/upload-pages-artifact@v5`, `actions/deploy-pages@v5`, `runs-on: ubuntu-24.04`.

---

## 3. Repository layout

```
whetstone/
├─ .github/
│  ├─ workflows/ci.yml              # PR + push: lint, typecheck, unit, build (fixtures), e2e smoke
│  ├─ workflows/data-deploy.yml     # daily cron + push + dispatch: per-game data jobs → publish → build → deploy → report
│  ├─ workflows/egress-probe.yml    # dispatch: one GET per external host from a GitHub runner
│  ├─ ISSUE_TEMPLATE/{feedback.yml, counter-theory.yml, data-problem.yml}
│  └─ dependabot.yml
├─ curated/                         # human-edited, PR-friendly inputs (class A, our own content)
│  ├─ hots/{traits.yaml, rules.yaml, counters.yaml, synergies.yaml, maps.yaml, aliases.yaml, ranked-pool.yaml, creators.yaml}
│  ├─ mtga/meta/<format>.json       # hand-curated meta lists (grindstone snapshot format), each with sourceUrl
│  └─ pokemon/regulations.yaml      # regulation windows (UTC), formats, Showdown format ids
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
│  ├─ styles/{tokens.css, global.css}
│  ├─ games/
│  │  ├─ registry.ts                # browser-safe metadata of all games
│  │  ├─ hots/{module.ts, schema.ts, load.ts, pipeline/, components/, theory/, fixtures/raw/}
│  │  ├─ mtga/{module.ts, schema.ts, load.ts, pipeline/, components/, worker/}
│  │  └─ pokemon/{module.ts, schema.ts, load.ts, pipeline/, components/, worker/}
│  └─ pages/                        # file-based routes (see §8)
├─ fixtures/<game>/...              # small committed snapshot shaped exactly like data/current/<game>/ (dev + PR CI offline)
├─ vendor/grindstone/               # synced copy of grindstone-mcp src/core (interim until npm publish); VERSION file with source SHA
├─ scripts/{sync-grindstone.ts, sw.ts, data-pull.ts}
├─ e2e/                             # Playwright smoke
├─ docs/{SPEC.md, DATA.md, OWNER-ACTIONS.md, METHODOLOGY.md, grindstone/}
└─ (branch `data`)  current/<game>/**  history/YYYY/MM/DD/<game>.json.gz  status.json
```

Build-time data directory: `WHETSTONE_DATA_DIR` (CI: `data/`; local default: `data/` if `data/current/<game>/meta.json` exists, else `fixtures/` — per game). `src/games/<game>/load.ts` is the **only** place pages read game data (fs at build time, zod-validated, memoized).

Browser-fetched shards (draft tables, card index, dex for the builder) are staged by `pipeline/stage.ts` into `public/data/<game>/<name>.<hash8>.json` and referenced through a generated `src/generated/stage-map.json` (`{ "hots/draft": "data/hots/draft.1a2b3c4d.json" }`). Small payloads may be passed as island props instead.

---

## 4. Core contracts (`src/core/game.ts`)

```ts
export type GameId = 'hots' | 'mtga' | 'pokemon';
export type CustodyClass = 'A' | 'A-SA' | 'B' | 'C';
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
  kind: 'stat' | 'theory' | 'curated' | 'role' | 'map' | 'votes' | 'pro' | 'usage';
  text: string;                    // one line, plain text, already human-readable
  n?: number; delta?: number;      // delta in percentage points when kind = 'stat'
  source?: string;                 // SourceRef.id
  evidence?: string[];             // e.g. ability/talent names that justified a theory tag
}
export interface Edge {             // directed for counters (a counters b), undirected (a<b) for synergy
  a: string; b: string;
  score: number;                   // 1..100, 50 = neutral
  delta?: number; n?: number; z?: number;
  source: 'stats' | 'theory' | 'curated' | 'votes' | 'usage' | 'replays';
  reasons: Reason[];
}

export interface PipelineContext {
  http: Http;                      // pipeline/http.ts: UA, retries/backoff, per-host spacing, dev disk cache, offline fixtures
  secrets: Readonly<Record<string, string | undefined>>;  // HP_API_KEY, HP_MODE, YT_API_KEY, TWITCH_CLIENT_ID, ...
  previous: (file: string) => Promise<unknown | null>;    // last-good file from data/current/<game>/
  now: Date; offline: boolean; log: (msg: string, extra?: unknown) => void;
}
export interface OutputFile { path: string; data: unknown; custody: CustodyClass; public?: boolean /* staged for browser */ }
export interface PipelineResult { meta: Omit<GameMeta, 'generatedAt' | 'dataHash'>; files: OutputFile[]; issues: ValidationIssue[] }
export interface ValidationIssue { level: 'error' | 'warn'; source?: string; message: string }
export interface DataPipeline { run(ctx: PipelineContext): Promise<PipelineResult> }   // each game splits into sources/transform/validate internally

export interface GameModule {      // browser-safe metadata only; pipeline is imported lazily by pipeline/run.ts
  id: GameId; name: string; short: string; tagline: string;
  status: 'live' | 'beta' | 'planned';
  accent: string;                  // CSS colour token name
  sources: SourceRef[];
  nav: { label: string; path: string }[];
}
```

`pipeline/run.ts` per game: run → any `error` issue ⇒ keep last-good files for that game (or for the failing source when the game supports partial fallback), mark statuses, exit non-zero at the end; otherwise write files to `data/current/<game>/` (A, A-SA) or `data/private/<game>/` (B, C), compute `dataHash` over sorted file contents excluding `generatedAt`, write `meta.json`, and append `history/YYYY/MM/DD/<game>.json.gz` for class A summaries.

---

## 5. HotS data (schemas in `src/games/hots/schema.ts`)

Canonical ids (critique D4): hero `id` = game `attributeId` (`Abat`, `HXAL`, `CCho`, `Gall`); `slug` = lowercase alphanumerics of English name (`liming`, `thebutcher`, `xalatath`); composite `chogall` entity (members `CCho`,`Gall`, costs 2 draft slots, one page). Map slugs are our own kebab-case (`cursed-hollow`).

Files in `data/current/hots/` (class A unless noted):

| File | Content |
|---|---|
| `meta.json` | `GameMeta` + `{ build, ptrBuild?, major: '2.57', majorSince: '2026-09-28', builds: string[] }` |
| `heroes.json` | Hero[]: `{ id, slug, name, title, role (Tank/Bruiser/Healer/Support/Ranged Assassin/Melee Assassin), roleAlt?, type (Melee/Ranged), franchise, difficulty, ratings{damage,utility,survivability,complexity}, releaseDate?, aliases[], portrait, abilities[{id,name,hotkey,kind:'basic'|'heroic'|'trait'|'mount'|'active',cooldown?,cost?,text,icon}], talents{'1'|'4'|'7'|'10'|'13'|'16'|'20': [{id,name,text,icon,ability?,sort}]}, members?, mechanics[{tag, evidence:[{kind:'ability'|'talent',name,snippet}]}], lastChangedBuild?, isNew }` |
| `maps.json` | Map[]: `{ id, name, kind: 'standard'|'aram'|'brawl', ranked: boolean, rankedSource: 'stats'|'curated', image, profile{size, lanes, objective, tags[]} }` |
| `patches.json` | Patch[]: `{ id, version, build?, date, title, url, kind: 'patch'|'balance'|'hotfix'|'ptr', contentHash, general: string[], heroes: { [heroId]: { changes: [{section, text, dir?: 'buff'|'nerf'|'change'|'rework'}] } } }` — parsed from Blizzard's news feed/articles, merged with data diffs. Text is short factual paraphrase/extraction of numbers, never the article prose verbatim beyond short change lines. |
| `diffs.json` | Build-to-build game-data diffs per hero (abilities/talents/stats old→new). |
| `theory.json` | `{ rulesVersion, counters: Edge[], synergies: Edge[], mapFit: [{hero, map, score, reasons}] }` produced by the theory engine from mechanics + curated YAML. |
| `links.json` | Outbound links per hero (Icy Veins, Psionic Storm, Nexus Compendium, HP `/Global/*`, Liquipedia when the page exists, Fandom wiki). |
| `rotation.json` | Free hero rotation + ranked season (Nexus Compendium API, attributed, "as of"). |
| `pro.json` | **A-SA.** Liquipedia 2026 pro drafts: per-hero picks/bans/presence, sample size, tournaments; licence + attribution fields. |
| `public/draft.json` | Columnar browser shard for the draft tool (heroes, roles, theory edges, map fit; stats merged at stage time if present). |
| `img/**` | WebP portraits, ability/talent icons, map thumbnails converted from HeroesToolChest/heroes-images at a pinned tag. |
| *(private)* `stats.json` | **B.** HP v1 aggregates: per mode (`sl` default; `qm`, `aram` when quota allows) and timeframe (`current` pooled with previous at w=0.5 for the first 14 days of a major; `previous`): hero games/wins/shrunk WR/pick/ban, counter & synergy matrices with n, per-map WR, talent builds. Only when `HP_MODE=on` and the key is present. |
| *(private)* `videos.json`, `streams.json` | **C.** Optional (YouTube Data API key / Twitch app credentials). |

Sources (in order of trust): Blizzard TACT version server (build detection), HeroesToolChest **heroes-data2** release zip gated on `.version.json` (roster, kits, talents, text, maps, localized names), **heroes-images** (pinned tag), Blizzard news feed JSON + article HTML (patch notes, hotfix detection by content hash), Nexus Compendium `/api/currently` (rotation only), Liquipedia MediaWiki API (2 s spacing, custom UA, wikitext of {{Map}} picks/bans), HP v1 (gated). The SL map pool = HP map-level game counts (share ≥ 1.5 %) when available, else `curated/hots/ranked-pool.yaml`.

### 5.1 Theory layer (works with zero HP data)

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

Global: `/` (game picker, what's new across games, freshness), `/about/`, `/credits/`, `/privacy/`, `/404`.

HotS: `/hots/` (hero grid: search incl. aliases/nicknames, role/franchise filters, tier & new badges, free-rotation & owned toggles, patch banner) · `/hots/hero/[slug]/` (header, Counters: strong vs / weak vs / good with — score ring, n, Δ, reasons, source badge, period toggle; Best maps; Talents by tier with builds when stats; Abilities; Patch history; Guides & links; mechanics tags) · `/hots/maps/` · `/hots/map/[slug]/` (best heroes, profile, ranked badge) · `/hots/tierlist/` (stats tiers by mode/period; without HP: pro presence + patch momentum, clearly labelled) · `/hots/draft/` · `/hots/aram/` · `/hots/patches/` + `/hots/patches/[id]/` · `/hots/catch-up/` (pick the date you last played → every hero change since, grouped) · `/hots/pro/` (A-SA) · `/hots/live/` (Twitch directory link + featured channels; live list only if the C-class source is enabled) · `/hots/about/` (methodology: formulas, gates, sources).

MTGA: `/mtga/` · `/mtga/deck/` (paste Arena export → legality in all formats, curve, mana sources, roles, power tier with breakdown, sample hands/mulligan sim, wildcard cost, budget upgrades, compare to meta; share via URL hash; analysis in a Web Worker) · `/mtga/limited/` + `/mtga/limited/[set]/` (17Lands ratings, CC BY credit at top) · `/mtga/search/` · `/mtga/meta/` (curated + bring-your-own lists) · `/mtga/about/`.

Pokémon: `/pokemon/` (regulation banner + countdown, usage grid, freshness) · `/pokemon/mon/[id]/` (base stats + SP sliders, usage by source, moves/items/abilities/teammates, checks & counters, speed position, links) · `/pokemon/tiers/` · `/pokemon/builder/` (Showdown paste import/export with Stat Points, legality, type matrix, coverage, speed vs top 50, threat list via calc) · `/pokemon/calc/` (`@smogon/calc` gen 0 in a worker) · `/pokemon/speed/` · `/pokemon/teams/` (Limitless top cuts, names stripped) · `/pokemon/preview/` (team preview: their 6 vs your 6 → bring 4 + leads) · `/pokemon/about/`.

---

## 9. UI system

- Tokens in `src/styles/tokens.css` (`:root` + `[data-theme=dark]`; dark default with toggle stored in localStorage; respect `prefers-color-scheme` on first visit). Game accents: HotS violet, MTGA amber, Pokémon red. System font stack. 4/8 px spacing scale.
- Shared components: `SiteHeader` (game switcher, search, theme toggle), `SiteFooter` (disclaimers, credits), `FreshnessBadge`, `StaleBanner`, `SourceAttribution`, `EntityGrid` (+ `EntityFilter` island), `ScoreRing` (1–100), `MatchupList` (strong/weak/good-with rows: avatar, name, ring, Δ, n, reasons expandable, source badge; "View more" collapse below threshold), `TierList`, `Tabs`, `PeriodToggle`, `ReasonList`, `EmptyState`, `CopyButton`, `ShareButton`.
- Every island renders meaningful server HTML first where possible (progressive enhancement).

---

## 10. Pipeline & CI

`data-deploy.yml` (critique D3): triggers `schedule: '17 10 * * *'`, `push: main`, `workflow_dispatch(inputs: games, force_deploy)`.
1. `data` job — matrix `game: [hots, mtga, pokemon]`, `fail-fast: false`, per-game timeout (hots 90, mtga 30, pokemon 45). Checks out main + `data` branch (`data/current` as last-good), runs `node pipeline/run.ts --game ${{ matrix.game }}`, uploads artifact `data-<game>` (public A/A-SA and private B/C dirs separately). Secrets passed as env; absent secrets ⇒ that source is `disabled`.
2. `publish` job (`if: always()`) — downloads artifacts, keeps last-good for failed games, commits class A/A-SA changes + history to the `data` branch (creating it orphan if absent), outputs `changed`.
3. `build` job — checkout main, restore `data/`, `node pipeline/stage.ts`, `npm run build`, post-build service worker, `upload-pages-artifact`.
4. `deploy` job — `if: changed || push || force_deploy`, environment `github-pages`, concurrency `pages`.
5. `report` job — on failure open/comment a `pipeline-failure` issue; on success close it; run `gh workflow enable data-deploy.yml` as the 60-day keepalive. No dummy commits.

`ci.yml`: npm ci → lint → typecheck (`astro check` + `tsc` with Node resolution for the pipelines) → vitest → HotS theory validator → build against `fixtures/` → Playwright smoke (every route renders, no console errors, attribution visible on stats routes, draft flow works) → statistics-mode build (`WHETSTONE_FIXTURE_PRIVATE=1`) with the HotS page, draft and ARAM specs.

Phase-in of secrets: `HP_API_KEY` + repo variable `HP_MODE=on` (owner, after HP's OK) · `YT_API_KEY` (optional) · `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` (optional; prefer a Worker later).

---

## 11. Roadmap (from community research, hots-roadmap.md)

**v0.1 (this build)** — HotS: data-driven roster with new-hero badges + freshness; hero/map pages with counters (stats when HP on, theory otherwise) and honest sample sizes; true-order SL draft + free mode with step-aware pick/ban suggestions, role guardrails, why/watch-out lines; hero pool/owned/free rotation; share links; tier list; patch notes + catch-up since you last played; ARAM pick-1-of-3 helper; pro presence; outbound guides; mobile-first, dark mode, alias search; feedback via issue forms; PWA offline shell. MTGA: deck analyzer on grindstone core, Limited ratings, curated meta, card search. Pokémon: MVP pages + builder + calc + speed + teams + team-preview assistant.

**Next** — HP stats on (owner gate); matchup-aware talent builds with "trap talent" flags + copyable build string (verify format); ARAM/QM stat views; YouTube guides; i18n (heroes-data2 has 12 locales); `whetstone-mcp` (class-A data only) alongside grindstone; draft quiz/onboarding; win-probability ranges after calibration.

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
7. **Gates.** `GATES` keep the §6 values. `stats.ts` also offers an optional `|z|` gate (`listMinAbsZ`, with `HIGH_VOLUME_MIN_ABS_Z = 2.5` suggested). The simulation shows it is needed at about 3k games/day with strong effects. It stays **off** (0) until the owner decides from real Heroes Profile volume, and `docs/METHODOLOGY.md` and `/about/` must change with it.
8. **Draftable entities.** Every score-bearing file (theory, stats, pro, the draft shard) is keyed by draftable entity id, with Cho'gall as the composite `chogall`. Patches, links and rotation stay keyed by member hero ids (`CCho`, `Gall`). The HotS pipeline emits the composite record.
9. **Licensed stats in the draft shard.** Heroes Profile numbers reach the draft tool only as the class-B overlay `private/hots/public/draft.json = { stats }`, merged by `stage.ts`. The public manifest keeps pointing at the pure class-A shard.
10. **Meta details.** `SourceStatus.fetchedAt` is `string | null` (null = never fetched). Each game's `meta.json` schema requires its own `extra` block, although `GameMeta.extra` is optional in `game.ts`. Optional keys are omitted, never written as `undefined`.
11. **Loader rows and component props.** The HotS loader's matchup row type is `HeroMatchupRow`, renamed so it no longer collides with the shared component's `MatchupRow` props. `src/games/hots/view.ts` converts one to the other with `toMatchupRow`, and also provides `heroHref` (`/hots/hero/<slug>/`) and `heroPortrait`. Images that `stage.ts` copies unchanged (`img/**`) are addressed with `assetHref(game, rel)` from `src/games/registry.ts`. Hashed JSON shards go through `stagedUrl` (entry 3).
12. **E2E isolation.** Playwright never reuses a server it did not start (`SMOKE_REUSE=1` opts in locally), and `e2e/global-setup.ts` compares the served home page with the `index.html` of the build under test (`dist/` or `WHETSTONE_OUT_DIR`). A busy `SMOKE_PORT`, `astro preview` hopping to another port, or a stale preview from another checkout fails the run instead of testing the wrong build.
13. **Data directories.** `WHETSTONE_FIXTURES=1` skips `data/` (an explicit `WHETSTONE_DATA_DIR` still wins); Vitest sets it, so unit tests always read `fixtures/`. The private (B/C) directory pairs with the chosen data directory and is never mixed: `<root>/private/<game>` for a pipeline output, `fixtures/<game>/_private` (only with `WHETSTONE_FIXTURE_PRIVATE=1`) for fixtures, whose `_private/public/**` overlays `stage.ts` merges like `data/private`. `src/lib/datadir.ts` and `pipeline/stage.ts` implement the same rule.
14. **Service worker.** The precache holds only what every visitor needs: Web Worker chunks (`_astro/*.worker-*.js`: the damage calc, the deck analyzer) are cached on first use, and the stale-while-revalidate data route skips internal `_`-prefixed shards, which their own worker keeps in IndexedDB (the MTGA card index).
15. **GitHub API and status-driven APIs.** `GITHUB_TOKEN` is a pipeline secret; `pipeline/http.ts` sends it as a bearer token to `api.github.com` only (`bearer` option, wired in `run.ts`), and the data job passes the workflow's own token. `Http.request()` returns `{ status, headers, body }` for APIs that answer in statuses; Heroes Profile uses it (no status retries, no dev cache, never recorded as a fixture), keeping its own 202/429/budget logic.
16. **Theory output and lists.** Engine `RULES_VERSION` 1.5: generic edges within ±4 of 50 are not stored (curated pairs always are); a counter rule matching both ways round only counts by its net advantage; reasons that need a talent or one Heroic say "Only when … takes …". Hero pages list theory edges that are curated or score ≥ 65 (`THEORY_GATES`), curated first; the rest sits below the bar. Rules: anti-heal-vs-sustain targets healers only, percent-Health damage is one rule for tanks and bruisers, dive against fragile heroes is milder than against immobile ones.
17. **Draft shard schema 2.** Reason lines are templates with `{a}`/`{b}`/`{m}` name tokens, and talent conditions are separate parts referenced as `[i, j(, k)]`; `draft/data.ts` fills them in. Consumers of the public manifest must read `schema` before decoding reasons.
18. **Redirect slugs.** Composite members, hyphenated hero aliases (heroescounters.com's `li-ming`) and compact map slugs (`cursedhollow`, plus aliases that start one, like `hanamura`) are noindex meta-refresh pages generated from data (`src/games/hots/redirects.ts`) and filtered out of the sitemap. A real slug always wins; an ambiguous alias is dropped.
19. **One hero-pool module.** `src/games/hots/pool.ts` owns the pool contract for the grid, the draft and the ARAM helper, including the tolerant reading (envelope or bare value, entity ids, member ids or slugs). The core `Store` gained `raw()` for that.
20. **Stale free rotation.** A rotation whose window ended before it was fetched (Nexus Compendium lagging the weekly switch) is shown as "not listed yet" and marks no hero free (`rotationIsStale`, `currentRotation`).
21. **Fixtures from real data.** `fixtures/hots` is generated from a live run by `src/games/hots/fixtures/make-fixtures.ts` (same 15-record cast and 6 maps, real kits, mechanics, theory edges, patches and images); `pro.json` and `_private/**` stay synthetic (Liquipedia data is CC BY-SA; licensed and ephemeral sources are never committed). `fixtures/pokemon` carries real sprites for its species. Tests and e2e assert real facts of those fixtures, and the e2e suite also passes on a live-data build.
22. **Sprite credit.** The self-hosted Pokémon sprites are credited through a footer-rule `SourceRef` (`showdown-sprites`), so the credit appears on every Pokémon page and the credits page.
