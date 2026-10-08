# Grindstone — MTG Arena Deck Tuning MCP Server

> *Grindstone* (n.): an old artifact that mills your opponent; also what you do on the ladder. This server sharpens your deck.

**Repo:** `grindstone-mcp` (public, MIT)
**One-liner:** An MCP server that takes an MTG Arena decklist, validates it, rates its power level (casual → competitive), and suggests upgrades from current cards that fit your wildcard budget.

---

## As built (v0.1.0): where the implementation differs from the original spec

These changes came from checking the current docs and data, as §0 required (October 2026):

- **No Alchemy.** Scryfall no longer lists Alchemy-rebalanced cards, and Alchemy is out of scope by owner decision. `alchemy` is rejected as a format; `A-` lines go to `unresolved` with code `alchemy_card`.
- **Explorer is now Pioneer.** Scryfall's `legalities` object has no `explorer` key; Arena's Explorer format became Pioneer. `explorer` is accepted as an alias for `pioneer`.
- **Bulk file.** Scryfall bulk files are now gzipped JSONL (`jsonl_download_uri`). The index uses `default_cards` (every English printing; each printing carries `games` and `arena_id`), not `all_cards` (every language, several times larger).
- **SQLite.** `node:sqlite` (built into Node 22.13+) instead of `better-sqlite3`, which avoids native-module install failures under `npx` on Windows. The minimum Node version is therefore 22.13. The bundle keeps the `node:` prefix (`removeNodeProtocol: false`), because `sqlite` has no unprefixed alias.
- **Rate limits.** Scryfall publishes hard limits: 500 ms between calls to `/cards/search`, `/cards/named`, `/cards/random` and `/cards/collection`; 100 ms for other endpoints; a 429 locks the client out for 30 seconds. The client spaces calls accordingly and retries once after the lockout. `*.scryfall.io` file downloads are unthrottled.
- **Rules download.** The Comprehensive Rules file name changes with each release, so `lookup_rule` finds the current `.txt` link on `https://magic.wizards.com/en/rules`.
- **Overrides.** Rubric files can be overridden from `<config dir>/rubric/`. Cache and config directories follow each OS's conventions (see README).
- **Extras beyond the spec:** `analyze_deck` reports tapped lands; `simulate_hands` reports exact hypergeometric opening-land odds next to the simulated ones; `rate_power`, `suggest_upgrades` and `compare_to_meta` report `metaSource`.

---

## 0. Instructions for Claude Code

- Read this whole file before writing code. Build in the milestone order in §9; finish each milestone with passing tests and a commit before starting the next.
- Before writing integration code, **verify against current docs** (do not trust this spec on these details):
  - Scryfall API docs (https://scryfall.com/docs/api): required `User-Agent` and `Accept` headers, rate-limit guidance, bulk-data endpoint and file names, the `games` and `arena_id` fields, and search syntax (`game:arena`, `legal:<format>`, `f:`, `id<=`).
  - The current MCP TypeScript SDK (`@modelcontextprotocol/sdk`) README for server and tool registration patterns.
- Ask me before adding any data source not listed in §5.
- Keep the analysis **deterministic**: same deck + same data snapshot = same output. Claude (the client) does the narrative; the server does the math.

---

## 1. Goals and non-goals

**Goals**
1. Paste an Arena export → get a structured, fully resolved deck.
2. Validate legality for an Arena format (Standard, Historic, Pioneer/Explorer, Timeless, Brawl, Standard Brawl), including Arena availability.
3. Produce a stats report: curve, colors, mana sources, card roles, interaction count.
4. Rate power level 1–5 with per-dimension scores and plain-language reasons.
5. Suggest swaps (cut X → add Y) tuned by mode (`casual` | `competitive`) and wildcard budget.
6. Optionally compare against meta decklists that the client supplies.

**Non-goals (v1)**
- No scraping sites whose terms forbid it (untapped.gg, MTGGoldfish, and similar). Meta lists come from the client (Claude can web-search them) or from a local snapshot file.
- No card images in the repo.
- No reading the Arena client log or collection (possible v2).
- No limited/draft support (possible v2).
- No Alchemy.

---

## 2. Tech stack

- **TypeScript**, Node 22.13+, ESM.
- `@modelcontextprotocol/sdk`, stdio transport.
- `zod` for tool input schemas.
- `node:sqlite` for the local card index.
- `vitest` for tests; `tsup` for building.
- Distributed via npm so users can run `npx -y grindstone-mcp`.
- GitHub Actions: lint, typecheck, and test on PRs; publish to npm on tag.

---

## 3. Repo layout

```
grindstone-mcp/
  src/
    index.ts              # MCP server entry
    server.ts             # tool and prompt registration
    context.ts            # injectable network/cache context
    tools/                # thin MCP wrappers
    core/
      parse.ts            # Arena export parser
      deck.ts             # name resolution
      cards.ts            # card index queries and helpers
      search.ts           # Scryfall-syntax subset
      formats.ts
      validate.ts
      analyze.ts          # stats + Karsten checks
      power.ts            # rubric scoring
      suggest.ts          # candidate generation + ranking
      meta.ts             # meta lists, snapshots, comparison
      wildcards.ts
      simulate.ts
      rubric.ts
    data/
      scryfall.ts         # HTTP client w/ headers, throttling, retries
      bulk.ts             # bulk download + SQLite index build
      roles.ts            # oracle-text regexes for role tagging
      rules.ts            # Comprehensive Rules download/cache/parse
      paths.ts
  rubric/
    power-rubric.json     # weights and thresholds (editable, not hardcoded)
    brawl-rubric.json
  meta/
    example-standard.json # sample meta snapshot format
  scripts/
    make-fixture.mjs      # rebuilds the test card fixture from a bulk file
  test/
    fixtures/             # trimmed card data, sample Arena exports, tier decks
  README.md
  LICENSE                 # MIT
  SPEC.md
```

---

## 4. Arena export parsing

Arena exports look like this:

```
Deck
4 Llanowar Elves (DOM) 168
2 Forest (ANB) 112

Sideboard
2 Duress (M21) 96
```

Handle these cases:
- Section headers: `Commander`, `Companion`, `Deck`, `Sideboard`, and `About` (with a `Name <deck name>` line). Lines before any header count as `Deck`.
- A bare blank line separating main and sideboard with no `Sideboard` header (common in older exports).
- Set code and collector number are optional. **Resolve by name**, because Arena set codes sometimes differ from paper codes.
- Double-faced and split cards: `Name // Name`, or the front face only.
- Alchemy rebalanced cards with the `A-` prefix: reported as unresolved (Alchemy is unsupported).
- Unresolvable lines go into an `unresolved[]` array with a reason. Never throw on one bad line.

Output type: `Deck { name?, format?, commander?, companion?, main: Entry[], side: Entry[], unresolved: Issue[] }`.

---

## 5. Data sources

| Source | Use | Notes |
|---|---|---|
| **Scryfall bulk data** | Primary card index: oracle text, mana value, colors, type line, legalities, rarity, release date, Arena availability | `default_cards`, refreshed if older than 24h, stored in SQLite under the user cache dir. Arena availability and `arena_id` aggregated per oracle ID. Stream-parsed. |
| **Scryfall API** | Fallback for fuzzy name lookups | Required headers; throttled to Scryfall's published limits; waits out the 30 s lockout after a 429. |
| **Client-supplied meta lists** | Meta comparison and "what's strong right now" | Tool input accepts an array of Arena-format decklists plus optional win rate and meta share. |
| **Local meta snapshot** | Same as above, offline | JSON files in `<config dir>/meta/<format>.json`. The schema is in `meta/example-standard.json`. |
| **Wizards Comprehensive Rules** | `lookup_rule` | Downloaded at runtime and cached; never committed. |
| **17lands public datasets** (optional, v2) | Card-quality signal | Check the license and terms first. Mostly limited data, so it's low value for constructed play. |

Attribution goes in the README: card data comes from Scryfall. Never paywall Scryfall data.

---

## 6. MCP tools

Every tool returns JSON. Errors are structured `{ error, details }` rather than thrown exceptions.

1. **`parse_decklist`** `{ text, format? }` → `Deck`
2. **`validate_deck`** `{ deck | text, format }` → `{ legal: bool, issues[] }`. Checks deck size, copy limits (singleton for Brawl), banned/restricted lists, Arena availability, commander color identity, and sideboard size.
3. **`analyze_deck`** `{ deck | text, format }` → stats:
   - mana curve of nonland cards, average mana value, land count
   - color pips versus colored sources, compared against the Karsten source-count table (stored as data in the rubric)
   - type breakdown; role counts from `roles.ts` (removal, counterspell, card draw, ramp, sweeper, threat, protection, tutor, lifegain), with each card's role assignments listed so the user can audit them
   - interaction count (removal + counters + sweepers)
4. **`rate_power`** `{ deck | text, format, meta? }` → `{ tier: 1–5, label, score: 0–100, dimensions: [{ name, score, reasons[] }] }`
5. **`suggest_upgrades`** `{ deck | text, format, mode: "casual"|"competitive", wildcards?: { mythic, rare, uncommon, common }, maxSwaps?, keepCards?: string[], meta? }` → `{ swaps: [{ cut, add, qty, reason, wildcardCost }], totalCost }`. A rarity left out of `wildcards` is unlimited.
6. **`compare_to_meta`** `{ deck | text, format, metaLists }` → closest archetype match, overlap %, the meta's core cards that this deck is missing, and this deck's unusual inclusions.
7. **`wildcard_cost`** `{ deck | text }` → wildcard count by rarity, using the lowest-rarity Arena printing of each card.
8. **`search_cards`** `{ query, format? }` → Scryfall-syntax search against the local index, so the client can explore candidates itself.
9. **`simulate_hands`** `{ deck | text, iterations?: 10000, seed?, playDraw?: "play"|"draw", bo1Smoothing?: bool, checks?: [{ card | role, byTurn }] }` → a seeded, deterministic Monte Carlo report: keepable 7 %, London mulligan rate, P(land drops on curve, turns 2–5), P(colors available) per colored card, and user checks. `bo1Smoothing` is documented as an approximation.
10. **`deal_sample_hand`** `{ deck | text, seed? }` → one random opening 7 plus the next 3 draws. Stateless.
11. **`lookup_rule`** `{ number?, query? }` → a rule from the Comprehensive Rules (exact lookups with subrules, keyword search, glossary).

Also exposes an MCP **prompt** called `tune_my_deck` that walks the client through the full sequence: parse → validate → analyze → rate → (client web-searches the current meta) → compare → suggest.

---

## 7. Power-level rubric (60-card formats)

All weights and thresholds live in `rubric/power-rubric.json`, never in code. Each dimension scores 0–100; the weighted total maps to a tier.

| Dimension | Default weight | Signal |
|---|---|---|
| Mana base | 20% | Sources versus the Karsten targets, land count versus the archetype, number of tapped lands |
| Speed / curve | 20% | Average nonland mana value, 1–2 drop density, top end for the inferred archetype (aggro, midrange, control, ramp) |
| Interaction | 15% | Removal, counterspells, and sweepers versus the archetype target, with a share for cheap interaction |
| Card quality | 25% | With meta data: share of cards appearing in meta lists, weighted by play rate. Without it: EDHREC-rank popularity, rarity and age. Marked "low confidence" when no meta data is supplied. |
| Consistency | 20% | `simulate_hands` (keepable 7 %, on-curve land drops, color availability) blended with 4-of density, card selection/tutors and singleton clutter |

| Tier | Label | Score |
|---|---|---|
| 1 | Jank / Precon | < 30 |
| 2 | Casual | 30–49 |
| 3 | Focused | 50–69 |
| 4 | Optimized | 70–84 |
| 5 | Competitive | 85+ |

Brawl uses `brawl-rubric.json`: mana base, commander synergy, ramp, card draw, interaction and card quality.

Each dimension outputs 1–3 human-readable `reasons`, e.g. "Only 9 blue sources for 3 one-pip blue cards at mana value 1; Karsten recommends 14."

---

## 8. Upgrade suggestion algorithm

1. **Find cut candidates.** Rank each nonland card by weak quality, absence from meta lists (when supplied), role redundancy and mana value above the curve target. Never cut anything in `keepCards`.
2. **Generate add candidates.** For each cut: legal in the format, on Arena, within the deck's real colors (commander identity in Brawl; otherwise colors with at least 15% of colored spells or 8+ sources), same creature/noncreature status, a shared role, and mana value within ±1. Aggro burn that can hit players is only replaced by cards that can too.
3. **Rank candidates.** `competitive` weights meta presence heavily; `casual` weights quality and role fit and penalizes wildcard rarity.
4. **Enforce the budget.** Greedy best-value-per-wildcard within the given `wildcards` limits. Never exceed the budget; report what remains.
5. **Write reasons.** One sentence per swap.

---

## 9. Milestones

1. **Scaffold.** Repo, TypeScript config, MCP server with a `ping` tool, CI, MIT LICENSE, README skeleton with disclaimers.
2. **Card index.** Scryfall client, bulk download, SQLite build, `search_cards`. Tested against a small checked-in fixture subset.
3. **Parsing + validation.** `parse_decklist`, `validate_deck`, with fixture tests for every edge case in §4.
4. **Analysis.** `analyze_deck`, role tagging, and the Karsten table.
5. **Power rating.** `rate_power` with the rubric files, and snapshot tests on 5 fixture decks spanning tiers 1–5.
6. **Suggestions + cost.** `suggest_upgrades`, `wildcard_cost`.
7. **Simulation.** `simulate_hands` and `deal_sample_hand`, fed into the consistency dimension, tested against exact hypergeometric values.
8. **Meta + rules.** `compare_to_meta`, local snapshot loading, `lookup_rule`, the `tune_my_deck` prompt.
9. **Release.** README with setup for Claude Code and Claude Desktop, npm publish workflow, v0.1.0 tag.

---

## 10. Prior art (ideas only — do not copy code)

- **ericraio/mtg-mcp** (Swift). Has a stateful deck/hand server with draw, mulligan, and sideboard tools, plus a rules lookup. Grindstone takes its simulation and rules ideas but makes them stateless and probability-based. That repo states no clear license, so **reference it only; do not copy any code from it.**
- **bmurdock/scryfall-mcp** and the other Scryfall wrappers. References for API handling and rate limiting.
- **MTG-Metagame-MCP** (mingun-kim). A reference for the shape of a meta snapshot.

## 11. Stretch ideas (post-v0.1)

- Matchup notes: given a meta archetype, flag which of your cards are weak against it and suggest sideboard plans.
- Rotation alerts: warn when cards leave Standard at the next rotation.
- Deeper Brawl commander synergy scoring.
- Arena collection import, so suggestions only use cards you own.
- A "reach" or "pump" role so non-meta suggestions understand aggro better.

## 12. README must include

- Setup for Claude Code (`claude mcp add grindstone -- npx -y grindstone-mcp`) and Claude Desktop (JSON snippet).
- An example conversation: paste a deck and ask "make this competitive with 4 rares and 2 mythics."
- How to edit the rubric, and the meta snapshot format.
- **Disclaimer:** Grindstone is unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. It is not approved or endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.
- **Attribution:** card data from Scryfall; this project is not affiliated with Scryfall.
