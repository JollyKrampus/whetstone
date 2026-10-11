# Changelog

## 0.3.1 (2026-10-10)

Upgrade suggestions no longer propose downgrades, and two analysis fixes.

- **No downgrades from `suggest_upgrades` and `build_versions`.** Optional swaps (not the ones that replace a banned, off-Arena or companion-breaking card, or a feel-bad card in the casual version) now follow these rules:
  - In a low-curve deck (60-card formats, average mana value at or below the aggro threshold in `power-rubric.json`, 2.4 by default), a swap never raises a card's mana value.
  - An instant is only replaced by an instant or a card with flash.
  - Budget-minded play (`mode: 'casual'`, or the `casual` profile, without `preferPremium`) never spends a rarer wildcard than the card it replaces. This includes land swaps.
  - With no meta lists and no recommendation list, a swap must beat the card it replaces by at least `NO_META_MARGIN` (0.1) on the popularity / rarity / age estimate. The `faithful` profile's swap to a cheaper card doing the same job is exempt, because the lower cost is the upgrade, and its reason now says that. The role-fit bonus alone can no longer push a sidegrade over the bar.
- **Reasons say what actually drives a swap.** "More widely played" is used only when the added card has a better EDHREC rank than the cut. Otherwise the reason names the parts of the estimate where the added card is better ("rarer", "newer", "cheaper to craft") and says that the estimate was made without meta lists or that the card is in none of the meta lists.
- **Treasure counts as ramp only when you can rely on it.** That means the spell itself makes it, the permanent makes it when it enters or is cast, or an activated ability makes it. Treasure from combat damage, attack triggers, saga chapters, upkeep triggers or abilities granted to tokens (Ragavan, Fable of the Mirror-Breaker) no longer tags a card as ramp.
- **A ramp plan needs something to ramp into.** `inferArchetype` picks `ramp` only when the deck also has an average mana value of at least 2.8 or at least 6 cards at 5+ mana (per 60 cards). The new `inference.ramp.minAvgMv` and `minTopEnd` rubric fields are optional, so rubric overrides written for 0.3.0 still load. `inferArchetype` takes an optional `topEnd` count.
- **Fetch lands count only the colors they can actually find.** `landColors` accepts a `FetchContext` (from the new `fetchContext(entries)`) and resolves "an Island or Swamp card" to the deck's own lands of those types, so a dual such as Blood Crypt counts and missing basic types count for nothing. `analyzeDeck`, `simulateHands` and the land upgrades use it. Passing a plain set of basic colors keeps the old behavior.
- **The "hand attack" salt rule matches real cards.** Thoughtseize and Duress reveal the hand and discard in separate sentences, which the old pattern never crossed.
- `heuristicParts` exposes the weighted parts of `heuristicQuality`.
- The test fixture gains Treasure makers, fetch lands and the Rakdos and red removal used in the regression tests.

## 0.3.0

Added deck versions (`build_versions`, `suggest_upgrades({ profile })`), `preferPremium`, the salt rubric, companion deckbuilding checks and `priceUsd` in the card index. See the "Changes from the original spec" list in [SPEC.md](SPEC.md) for this and earlier releases.
