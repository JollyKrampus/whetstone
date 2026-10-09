# Owner actions

Things only the repository owner can do: accounts, settings, secrets, emails and decisions. Work through them roughly in order. Nothing here is automated; every item needs you.

## 1. Publish the repository and the site

- [ ] **Create the public repo and push.** From the local clone:

  ```sh
  gh repo create JollyKrampus/whetstone --public --source . --remote origin --push
  ```

- [ ] **Enable Pages from Actions.** Settings → Pages → Build and deployment → Source: **GitHub Actions**. (API alternative: `gh api -X POST repos/JollyKrampus/whetstone/pages -f build_type=workflow`.)
- [ ] **Create the issue labels** used by the issue forms and the failure report:

  ```sh
  gh label create feedback       --color 0E8A16 --description "Feedback and ideas"
  gh label create counter-theory --color 5319E7 --description "Proposed or corrected counter/synergy theory"
  gh label create data-problem   --color D93F0B --description "Wrong, stale or missing data"
  gh label create pipeline-failure --color B60205 --description "The daily data pipeline failed"
  ```

- [ ] **Optional variable** (Settings → Secrets and variables → Actions → Variables): `LIQUIPEDIA_UA_CONTACT` = an email or URL where Liquipedia (and other sources) can reach you. It is appended to the pipeline's User-Agent; Liquipedia's API terms ask for contact details.
- [ ] **Run the egress probe.** Actions → Egress probe → Run workflow. Every row should say `ok`; Heroes Profile is expected to answer `401` (no key). A `FAIL` with "bot challenge" means that source blocks GitHub's runners and its pipeline needs another plan before relying on it.
- [ ] **First data run.** Actions → Data + Deploy → Run workflow (defaults: all games). It creates the orphan `data` branch, commits `current/`, `history/` and `status.json`, builds and deploys. Check https://jollykrampus.github.io/whetstone/ and the run summary.
- [ ] **Branch protection (recommended):** protect `main` (require the CI check). Leave `data` unprotected or allow `github-actions[bot]` to push; the workflow pushes to it daily.

After this, the workflow runs daily at 10:17 UTC and on pushes to `main`. A failure opens a `pipeline-failure` issue; you get GitHub's notification for it.

## 2. Heroes Profile (statistics for HotS)

HotS counters, tiers and the draft's win-rate modes need Heroes Profile's v1 API. Their terms require a subscription for any data use and an agreement for projects that could be seen as competing, so **ask first and subscribe only after a yes**. Until then the HotS module runs in theory-and-static mode and `HP_MODE` stays off.

- [ ] **Register on the API portal** (heroesprofile.com, you must be 18+, a project description is required) and stay in **fixture mode**: it returns real response shapes with placeholder values and uses no quota. Do not activate live data yet.
- [ ] **Read the portal's "Endpoint Limits" page** and note the weekly quotas, especially `heroes/matchups` on Basic (the source code says 700/week, the pricing page reportedly 70/week). This decides the plan:
  - 700/week on Basic: Basic ($5, or a $5 Patreon pledge), one Storm League matrix a day.
  - 70/week on Basic: Intermediate ($10, or a $10 pledge), two matrices a week.
  - Developer ($25 plus approval) only if you want daily ARAM and Quick Match matrices.
- [ ] **Email Heroes Profile** and wait for a written answer. Draft (edit freely):

  > **To:** zemill@heroesprofile.com
  > **Subject:** API use request: "Whetstone", a free HotS draft and counter helper
  >
  > Hi,
  >
  > I'm Troy (GitHub: JollyKrampus). I'm building Whetstone, a free, ad-free, non-commercial companion site for a few games, hosted as a static site on GitHub Pages (https://jollykrampus.github.io/whetstone/). Its Heroes of the Storm part is a draft helper and counter picker: true Storm League pick and ban order, role guardrails, and short "why" explanations built from hero kits. It works without any Heroes Profile data today, and I would like to add aggregate statistics from your API with proper credit.
  >
  > What I would do, if you agree:
  >
  > - Subscribe (Patreon or a Basic/Intermediate plan, depending on the quota answer below) and call the v1 API once a day: `heroes/stats` (Storm League, current patch, `group_by_map`), `heroes/matchups` for each hero (Storm League, current patch) and `heroes/talents/builds/all`. That is roughly 100 calls a day, with cold queries staggered and run one at a time.
  > - Store no player-level data, only aggregates. I would still poll the privacy changes feed daily.
  > - Never commit Heroes Profile data to any repository, public or private. Each daily run fetches it fresh, turns it into small display-ready aggregates, and ships them only inside the site build under content-hashed file names that are not listed or documented anywhere. One switch removes all HP-derived data from the site in a single run.
  > - Show "Data provided by Heroes Profile" with a link on the same screen as every number, including on share links.
  >
  > Questions:
  >
  > 1. Is this OK under section 6 of the API terms (projects that might compete)? The HotS draft tool is one part of a multi-game site, but I would rather ask than assume.
  > 2. Because the site is static, browsers load those small JSON files of derived aggregates from my site. Do you consider that "display" rather than "an endpoint of your own"?
  > 3. What is the production weekly quota for `heroes/matchups` on the Basic plan? I have seen both 700 and 70 mentioned, and it decides which plan I buy.
  > 4. Is it fine to also show ARAM and Quick Match views (with `mirror=0`) when the quota allows?
  > 5. Is it OK to show a player's own replay statistics, computed in their browser from replay files they choose (nothing uploaded or stored), next to Heroes Profile numbers?
  > 6. May I use `heroes/stats` `group_by_map` game counts to show which maps are currently in the Storm League pool?
  > 7. Would you prefer deep links to Heroes Profile pages instead, or some kind of partnership?
  > 8. Is there a cadence or set of filters that keeps your cache warm and your servers happy?
  >
  > Thank you for building and running Heroes Profile.
  >
  > Troy

- [ ] **Only after a written yes:** subscribe at the plan chosen above, activate live data on the portal (this expires any legacy key immediately), then add:
  - secret `HP_API_KEY`: the v1 key;
  - secret `DATA_ARTIFACT_KEY`: a long random string, for example from `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. It encrypts the short-lived artifact that carries HP data from the data job to the build job; without it, HP data is left out of the site;
  - variable `HP_MODE` = `on`.
- [ ] Run Data + Deploy with `games` = `hots` and check that stats pages show the Heroes Profile credit next to the numbers.
- [ ] Keep the answer email. If Heroes Profile ever withdraws permission or the subscription ends, follow the **kill switch runbook** in [DATA.md](DATA.md) section 7 (30-day deletion).

## 3. Optional sources

- [ ] **YouTube guides** (phase 2): Google Cloud console → new project → enable *YouTube Data API v3* → create an API key restricted to that API. Add it as secret `YT_API_KEY`. Video metadata is class C: never committed, hidden by the site after 30 days.
- [ ] **Twitch streams:** dev.twitch.tv → Register an application (client credentials). Add secrets `TWITCH_CLIENT_ID` and `TWITCH_CLIENT_SECRET`. A once-a-day refresh is a poor fit for "live now", so the default is a link to the Twitch category plus featured channels; a frequently refreshing Worker is the better long-term answer (decision below).

Unset secrets simply mark their source `disabled`; nothing breaks.

## 4. grindstone-mcp on npm

Whetstone currently vendors grindstone's core build in `vendor/grindstone/` (`npm run sync:grindstone`). To switch to the published package:

- [ ] In the grindstone session/repo: create the public repo `JollyKrampus/grindstone-mcp` and push (the core export is in v0.2.0, commit `2dbc5b3`).
- [ ] Publish v0.2.0 once by hand from your machine: `npm login`, then `npm publish --access public` in the grindstone repo. (The npm name `grindstone-mcp` was free on 2026-10-08.)
- [ ] On npmjs.com, configure **trusted publishing** for `JollyKrampus/grindstone-mcp` with its `release.yml` workflow, so later releases publish from CI with provenance and no token.
- [ ] Then in Whetstone: add `"grindstone-mcp": "^0.2.0"`, replace `#vendor/grindstone/core.js` imports with `grindstone-mcp/core`, delete `vendor/grindstone/` and the `sync:grindstone` script (README → grindstone-mcp).

## 5. Decisions to make

Defaults are in brackets; the site works either way.

- [ ] **Votes and live streams backend** (critique D8): one Cloudflare Worker (D1 database + Turnstile), shared by all games, for community votes/tags and a cached Twitch proxy? This adds a small backend to an otherwise static site. [No for v1: no votes; streams are link-outs.]
- [ ] **Custom domain** (e.g. `whetstone.gg`)? Decide before search engines index the site: it changes `site`/`base` in `astro.config.mjs`, `SITE_URL` in `.github/workflows/data-deploy.yml`, and needs the domain set under Settings → Pages. [No: `jollykrampus.github.io/whetstone/`.]
- [ ] **Which modes and formats matter to you** (critique G7): HotS Storm League, ARAM, Quick Match? MTGA Standard, Historic, Limited, Brawl? Pokémon Champions Doubles or Singles? [SL, Standard + Limited, Doubles.]
- [ ] **Monthly budget** for Heroes Profile: $5, $10 or $25 (see section 2). [Decide after the email.]
- [ ] **Usage analytics:** none, or a cookie-less counter such as GoatCounter or Cloudflare Web Analytics (the privacy page must match). [None.]

## 6. Ongoing

- Close or act on `pipeline-failure` issues; the next successful run closes them automatically.
- Review Dependabot PRs weekly (npm and GitHub Actions). Preact stays on 10.x and TypeScript below 6.1 until the tooling allows otherwise.
- Workflows are pinned to `ubuntu-24.04`; revisit after GitHub's 26.04 rollout settles.
- The daily run re-enables its own schedule (`gh workflow enable`), so the 60-day inactivity rule should not bite. If it ever does, Actions → Data + Deploy → Enable workflow.
