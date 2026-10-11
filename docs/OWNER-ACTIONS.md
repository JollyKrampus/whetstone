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
- [ ] **Run the egress probe.** Actions → Egress probe → Run workflow. Every row should say `ok`; YouTube is expected to answer `400`/`403` (no key). A `FAIL` with "bot challenge" means that source blocks GitHub's runners and its pipeline needs another plan before relying on it.
- [ ] **First data run.** Actions → Data + Deploy → Run workflow (defaults: all games). It creates the orphan `data` branch, commits `current/`, `history/` and `status.json`, builds and deploys. Check https://jollykrampus.github.io/whetstone/ and the run summary.
- [ ] **Branch protection (recommended):** protect `main` (require the CI check). Leave `data` unprotected or allow `github-actions[bot]` to push; the workflow pushes to it daily.

After this, the workflow runs daily at 10:17 UTC and on pushes to `main`. A failure opens a `pipeline-failure` issue; you get GitHub's notification for it.

## 2. Owned data

Whetstone owns its tooling: first-party game data (game files, official patch notes and news), openly licensed data (MIT, CC BY, CC BY-SA), our own curation and our own analysis. It uses no third-party statistics aggregator, so there is no data licence, subscription or API key to obtain for the public site. Statistics about your own games will come from the private hub (planned, SPEC §13.7), never from the public site.

Nothing to do here. If you ever consider a licensed source, it would be class B (DATA.md section 1): never committed, shipped only encrypted, and removable in one run (DATA.md section 7).

## 3. Optional sources

- [ ] **YouTube guides** (phase 2): Google Cloud console → new project → enable *YouTube Data API v3* → create an API key restricted to that API. Add it as secret `YT_API_KEY` (only the HotS data job receives it). Video metadata is class C: never committed, hidden by the site after 30 days. The privacy page already carries what the YouTube API Services policies ask for (what is fetched, retention, and links to the YouTube Terms of Service and the Google Privacy Policy).
- **Twitch streams: not used.** No Twitch credentials are needed and none are read; `/hots/live/` links to the Twitch category and featured channels. If a live list is ever wanted, it needs a frequently refreshing backend (decision below), not the daily job.

Unset secrets simply mark their source `disabled`; nothing breaks.

## 4. grindstone-mcp releases (optional)

grindstone-mcp lives in this repository as the workspace package `packages/grindstone-mcp` (currently 0.3.1). The site imports it as `grindstone-mcp/core`, and the root `prepare` script builds it, so nothing is vendored or synced. Publishing it to npm is only for people who run the MCP server on its own:

- [ ] Give the release workflow (`.github/workflows/grindstone-release.yml`) a way to publish: add an npm automation token as the repository secret `NPM_TOKEN`, or configure **trusted publishing** for the package `grindstone-mcp` with that workflow on npmjs.com (it already requests `id-token: write` and publishes with provenance). (The npm name `grindstone-mcp` was free on 2026-10-08.)
- [ ] To publish a release, push a tag: `git tag grindstone-v0.3.1 && git push origin grindstone-v0.3.1`. The workflow publishes `packages/grindstone-mcp` at that version.

## 5. Decisions to make

Defaults are in brackets; the site works either way.

- [ ] **Votes and live streams backend** (critique D8): one Cloudflare Worker (D1 database + Turnstile), shared by all games, for community votes/tags and, if ever wanted, a cached live-stream list? This adds a small backend to an otherwise static site. [No: no votes; streams are link-outs.]
- [ ] **Custom domain** (e.g. `whetstone.gg`)? Decide before search engines index the site: it changes `site`/`base` in `astro.config.mjs`, `SITE_URL` in `.github/workflows/data-deploy.yml`, and needs the domain set under Settings → Pages. [No: `jollykrampus.github.io/whetstone/`.]
- [ ] **Which modes and formats matter to you** (critique G7): HotS Storm League, ARAM, Quick Match? MTGA Standard, Historic, Limited, Brawl? Pokémon Champions Doubles or Singles? [SL, Standard + Limited, Doubles.]
- [ ] **Usage analytics:** none, or a cookie-less counter such as GoatCounter or Cloudflare Web Analytics (the privacy page must match). [None.]

## 6. Ongoing

- **Refresh the MTGA curated meta** (monthly, and after each Standard ban or set release). Read the newest Wizards magic.gg *Metagame Mentor* (or event decklist) article by hand. Replace the decks in `curated/mtga/meta/standard.json`, copying **card names and counts only**, with each deck's `sourceUrl`, `date` and `metaShare` where the article gives one; update the snapshot date. Then run `npm run data -- --game mtga` (or the Data + Deploy workflow for mtga) and check that `curated-meta` is `ok` with no validation warnings.
- **Review the Pokémon Showdown pin** (when a regulation or Champions update lands, or monthly). `node src/games/pokemon/pipeline/showdown/pin.ts --check` prints the pinned commit against Showdown's master and the compare link. Read the diff, then `--set <sha>` (or `--set latest`) and open a pull request: the daily job only ever builds the pinned commit, in its isolated export job.
- Close or act on `pipeline-failure` issues; the next successful run closes them automatically.
- Review Dependabot PRs weekly (npm and GitHub Actions). Workflow actions are pinned to full commit SHAs with the release in a comment; Dependabot proposes new SHAs, so check the release notes before merging. Preact stays on 10.x and TypeScript below 6.1 until the tooling allows otherwise.
- `DATA_ARTIFACT_KEY` (optional secret) encrypts class-B data between workflow jobs. With no licensed source in use it is not needed; if you set or rotate it, the next run simply uses the new key (an artifact encrypted with an old key is skipped with a warning).
- Workflows are pinned to `ubuntu-24.04`; revisit after GitHub's 26.04 rollout settles.
- The daily run re-enables its own schedule (`gh workflow enable`), so the 60-day inactivity rule should not bite. If it ever does, Actions → Data + Deploy → Enable workflow.
