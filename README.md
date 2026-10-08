# Grindstone

> *Grindstone* (n.): an old artifact that mills your opponent; also what you do on the ladder. This server sharpens your deck.

An [MCP](https://modelcontextprotocol.io) server that takes an MTG Arena decklist, validates it, rates its power level (casual → competitive), and suggests upgrades from current cards that fit your wildcard budget.

The server does the math; your AI client does the talking. Same deck + same card-data snapshot = same numbers.

## Setup

Requires Node.js 22.13 or newer (Grindstone uses the built-in `node:sqlite`).

**Claude Code**

```bash
claude mcp add grindstone -- npx -y grindstone-mcp
```

**Claude Desktop**: add this to `claude_desktop_config.json` (Settings → Developer → Edit Config):

```json
{
  "mcpServers": {
    "grindstone": {
      "command": "npx",
      "args": ["-y", "grindstone-mcp"]
    }
  }
}
```

**From a local checkout**

```bash
npm install && npm run build
claude mcp add grindstone -- node /path/to/grindstone-mcp/dist/index.js
```

On first use Grindstone downloads Scryfall's card data (about 80 MB compressed) and builds a local index, which takes 10–30 seconds. After that it refreshes at most once a day.

## Example

An illustrative conversation (the numbers depend on your deck and the current meta):

> **You:** Here's my Standard deck. Make this competitive with 4 rares and 2 mythics.
> *(pastes an Arena export)*
>
> **Claude:** *(parse_decklist → validate_deck → analyze_deck → rate_power)* Your deck is legal and rates **Tier 4 — Optimized (78/100)**. The weakest area is the mana base: only 18 red sources for 4 two-pip red cards at mana value 2, where Karsten recommends 21.
>
> *(searches the web for current Standard lists, then compare_to_meta and suggest_upgrades with `wildcards: { rare: 4, mythic: 2 }`)* You're closest to Boros Aggro (71% overlap). Suggested swaps:
> - Cut 4 Hired Claw → add 4 … (4 rares): fills the same threat role at the same mana value, and appears in 3 of 5 meta lists.
> - …
>
> That spends all 4 rares and 1 of your 2 mythics.

The `tune_my_deck` prompt runs this whole sequence for you.

## Tools

| Tool | What it does |
|---|---|
| `parse_decklist` | Arena export → resolved deck. Bad lines (typos, Alchemy `A-` cards) land in `unresolved` with suggestions. |
| `validate_deck` | Deck/sideboard size, copy limits (singleton for Brawl), banned/restricted cards, Arena availability, commander color identity. |
| `analyze_deck` | Curve, average mana value, lands, colored pips vs. sources (Karsten table), tapped lands, types, card roles (each with the rule that tagged it), interaction. |
| `rate_power` | Tier 1–5 with a 0–100 score and per-dimension scores and reasons. |
| `suggest_upgrades` | Cut X → add Y swaps for `casual` or `competitive` play, within your wildcard budget, without changing more of the deck than you allow. |
| `wildcard_cost` | Wildcards needed by rarity, at each card's cheapest Arena printing. |
| `compare_to_meta` | Closest meta archetype, overlap %, missing core cards, unusual inclusions. |
| `search_cards` | Scryfall-style search over the local index (`t:creature id<=rw mv<=2 f:standard`). |
| `simulate_hands` | Seeded Monte Carlo: keepable 7s, mulligans, land drops, color availability, custom checks. |
| `deal_sample_hand` | One opening 7 plus the next 3 draws, for "would you keep this?" practice. |
| `lookup_rule` | Comprehensive Rules by number (`702.19`) or keyword, plus the glossary. |
| `ping` | Health check. |

Every tool takes a deck as either `text` (an Arena export) or `deck` (the object `parse_decklist` returns). Errors come back as `{ "error": "...", "details": ... }`.

### Formats

`standard`, `pioneer` (alias `explorer`; Arena's Explorer became Pioneer), `historic`, `timeless`, `brawl` (100 cards), `standardbrawl` (60 cards). **Alchemy is not supported**, and Alchemy-rebalanced `A-` cards are reported as unresolved.

### Power tiers

| Tier | Label | Score |
|---|---|---|
| 1 | Jank / Precon | < 30 |
| 2 | Casual | 30–49 |
| 3 | Focused | 50–69 |
| 4 | Optimized | 70–84 |
| 5 | Competitive | 85+ |

60-card decks are scored on mana base, speed/curve, interaction, card quality and consistency. Brawl decks are scored on mana base, commander synergy, ramp, card draw, interaction and card quality.

**Card quality is only as good as the meta data you give it.** With meta lists it measures how many of your cards top decks play. Without them it falls back to a rough popularity/rarity/age estimate. That estimate leans on EDHREC popularity, so it favors Commander staples, and it's marked `"confidence": "low"`.

### Keeping your deck yours

`suggest_upgrades` tunes the deck rather than rebuilding it:

- **Swaps are one-for-one:** same creature/noncreature status, a shared role, within one mana.
- **Changes are capped by `intensity`:**
  - `light`: about 7% of the deck, cutting only from its weakest quarter.
  - `normal` (default): about 15%, from the weakest half.
  - `heavy`: about 30%.
  - `maxChangePercent` sets an exact cap instead. The result reports `changes: { cards, limit }`.
- **Some cards are never cut:** anything in `keepCards`, and the commander.
- **In Brawl, every added card must support the commander's theme,** read from its rules text (tokens, sacrifice, +1/+1 counters, a creature type it names, …). The theme is reported as `commanderThemes`.

## Editing the rubric

All weights, thresholds, archetype targets and the Karsten source table live in [`rubric/power-rubric.json`](rubric/power-rubric.json) and [`rubric/brawl-rubric.json`](rubric/brawl-rubric.json). To tune them without editing the package, copy either file to your config directory's `rubric/` folder; that copy wins.

| OS | Config directory | Cache directory |
|---|---|---|
| Windows | `%APPDATA%\grindstone` | `%LOCALAPPDATA%\grindstone\cache` |
| macOS | `~/.config/grindstone` | `~/Library/Caches/grindstone` |
| Linux | `$XDG_CONFIG_HOME/grindstone` (`~/.config/grindstone`) | `$XDG_CACHE_HOME/grindstone` (`~/.cache/grindstone`) |

Override them with `GRINDSTONE_CONFIG_DIR` and `GRINDSTONE_CACHE_DIR`. Set `GRINDSTONE_OFFLINE=1` to never touch the network; this needs an existing card index.

## Meta snapshots

`rate_power`, `suggest_upgrades` and `compare_to_meta` accept meta decklists directly. Usually Claude finds them with a web search. To work offline, save a snapshot as `<config dir>/meta/<format>.json`; it's used whenever no lists are passed. The format ([`meta/example-standard.json`](meta/example-standard.json) is an example, not real data):

```json
{
  "format": "standard",
  "date": "2026-10-01",
  "source": "where these lists came from",
  "decks": [
    {
      "archetype": "Boros Aggro",
      "name": "optional list name",
      "metaShare": 0.14,
      "winRate": 0.53,
      "list": "Deck\n4 Emberheart Challenger\n...\n\nSideboard\n3 Abrade"
    }
  ]
}
```

`metaShare` may be 0–1 or a percentage. Grindstone does not scrape meta sites.

## How it works

- **Card data** comes from Scryfall's `default_cards` bulk file (every English printing, with `games` and `arena_id`), streamed and folded into one record per card in a local SQLite index. Arena availability and the cheapest Arena rarity are aggregated across printings. Misspelled names fall back to Scryfall's fuzzy lookup, which is rate-limited per Scryfall's guidance.
- **Simulation** is stateless and probability-based (no game engine). `bo1Smoothing` approximates Arena's best-of-one hand smoother; Wizards hasn't published the real algorithm. It's modeled as picking, from 2 candidate opening hands, the one whose land count is closest to the deck's land ratio.
- **Rules** are downloaded from Wizards on first use and cached for a week; the rules text is not part of this repo.

## Development

```bash
npm install
npm test          # vitest, against a small real-data fixture (no network)
npm run lint
npm run typecheck
npm run build
```

`scripts/make-fixture.mjs` rebuilds `test/fixtures/cards.jsonl` from a downloaded bulk file and `test/fixtures/card-names.txt`.

## Disclaimer

Grindstone is unofficial Fan Content permitted under the Wizards of the Coast Fan Content Policy. It is not approved or endorsed by Wizards. Portions of the materials used are property of Wizards of the Coast. ©Wizards of the Coast LLC.

## Attribution

Card data comes from [Scryfall](https://scryfall.com). This project is not affiliated with Scryfall. Scryfall data is free to use and Grindstone will never paywall it.

## License

[MIT](LICENSE)
