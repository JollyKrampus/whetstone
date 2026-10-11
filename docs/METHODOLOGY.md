# How Whetstone computes its numbers

This page explains every formula and threshold behind Whetstone's win rates, counters, synergies,
tier lists, draft suggestions and freshness badges. It is written for players, not statisticians,
but each section names the exact rule so you can check our work. The code lives in `src/core/`
(`stats.ts`, `tiers.ts`, `draft.ts`, `freshness.ts`) and every rule below has a unit test.

Two conventions hold everywhere:

- **Win rates** are shown as percentages (54.1%).
- **Differences** between win rates are shown in **percentage points (pp)**. Going from 50% to
  52% is "+2 pp", not "+4%".

## 1. Where the numbers come from

Statistics need match data. Heroes of the Storm publishes none, and Whetstone builds only on data
it owns or that is openly licensed, plus its own analysis. So Heroes of the Storm pages show
**theory**: matchups derived from ability and talent text plus hand-written notes. The statistics
rules below stay ready for a match-data source that meets that bar; any page that shows its
numbers credits it right next to them. Theory is always labelled as theory and never mixed into a
statistic.

Every number on a page shows **how many games** (`n`) it rests on and where it came from.

## 2. Confidence ranges (Wilson interval)

A win rate from a few games is unreliable: 3 wins out of 4 is "75%", but the truth could easily be
40%. Wherever we show a range, we use the **Wilson score interval** at 95% confidence (z = 1.96).
It behaves sensibly for small samples and never leaves 0–100%.

For `k` wins in `n` games, with `p = k / n`:

- centre = (p + z²/2n) / (1 + z²/n)
- half-width = z · √(p(1 − p)/n + z²/4n²) / (1 + z²/n)

## 3. Hero win rates: shrinkage

A hero with 30 wins in 50 games (60%) is almost certainly not the best hero in the game. Most of
that 60% is luck. We therefore **shrink** every hero's win rate toward the average. Heroes with
few games move a lot, and heroes with thousands of games barely move.

This is called empirical-Bayes shrinkage. It works in three steps:

1. **Average (μ):** all wins divided by all games (about 50%).
2. **Real spread (τ²):** how much heroes truly differ. We take the observed spread between
   heroes with at least 50 games and subtract the spread that luck alone would cause
   (μ(1 − μ)/n for each hero).
3. **Strength of the pull (κ):** κ = μ(1 − μ)/τ² − 1, measured in "pseudo-games". When heroes
   truly differ a lot, κ is small and we trust each hero's own record. When they barely differ,
   κ is large.

Each hero's shrunk win rate is then **(wins + κ·μ) / (games + κ)**.

*Example, with κ = 400:*

| Record | Raw win rate | Shrunk win rate |
|---|---|---|
| 30 / 50 | 60.0% | 51.1% |
| 1,100 / 2,000 | 55.0% | 54.2% |

**Patch-aware starting point.** Early in a patch there are few games. A hero whose kit did not
change in the patch starts from **its own shrunk win rate last patch** instead of the average, at
half the pull (κ/2). A hero that changed starts from the average. The first days of a patch are
therefore steadier without hiding real changes.

**Guards.** If there is no data, or the data shows no real spread beyond luck, κ falls back to a
large value (everyone close to the average). It never becomes infinite or negative.

## 4. Counters and synergies

### 4.1 Why not "win rate against X minus win rate"?

The naive counter number, "A's win rate against B minus A's overall win rate", hides a trap. A hero
that is simply strong looks like it "counters" everyone. A weak hero looks like it loses to
everything. We want the part of the matchup that is **specific to the pair**.

### 4.2 The expected result

We first ask what A should win against B **if neither had any special interaction**, using both
heroes' shrunk win rates (`p̃A`, `p̃B`). We treat a team's chance as the sum of its heroes'
strengths on the log-odds scale:

- **Counter (A against B):** expected = σ(logit p̃A − logit p̃B)
- **Synergy (A with B on the same team):** expected = σ(logit p̃A + logit p̃B)

Here logit(p) = ln(p / (1 − p)) and σ is its inverse. Close to 50%, the counter expectation is
roughly p̃A − p̃B + 50%. A 53% hero facing a 49% hero is expected to win about 54%.

### 4.3 Shrinking toward the expectation

Pair samples are much smaller than hero samples, so we shrink again. This time the pull is toward
the **expected** result, not toward 50%:

- shrunk = (wins + k · expected) / (games + k)
- **Δ = shrunk − expected**, in pp. A positive Δ means A does better against (or with) B than
  their strengths predict.

The pull `k` is estimated from the data the same way as κ. It uses the spread of observed minus
expected over pairs with at least 30 games, beyond what luck explains. It is kept between 25 and
2,000. Each pair also gets a **z-score**, (wins − games · expected) / √(games · expected · (1 −
expected)). This measures how surprising the raw result is, before shrinking.

*Example, expected 52%, k = 500:*

| Record | Raw | Δ after shrinking | Listed? |
|---|---|---|---|
| 60 / 100 | 60.0% | +1.3 pp | No: Δ is below 1.5 pp |
| 600 / 1,000 | 60.0% | +5.3 pp | Yes |

The same raw 60% means little after 100 games and a lot after 1,000.

### 4.4 Consistency

- **Counters are two-sided.** If A gains Δ against B, then B must lose Δ against A. We average
  the two directions: Δ(A,B) = (Δ(A,B) − Δ(B,A)) / 2. This removes small mismatches between the
  two ways the data is recorded.
- **Synergy is symmetric.** "A with B" and "B with A" describe the same games, so we average them
  and store the pair once.

Each statistic carries one reason line, for example: *"Wins 54.1% vs Muradin (expected 50.9%),
n=812"*. The 54.1% is the raw rate. Δ, shown next to it, is the shrunk effect.

## 5. The 1–100 score ring

Matchup rings use a 1–100 score with 50 as neutral:

**score = round(50 + 50 · tanh(Δ / 4 pp))**, clamped to 1–100.

This is the same as tanh(Δ / 0.04) when Δ is written as a proportion.

| Δ (pp) | −6 | −4 | −2 | −1.5 | −1 | 0 | +0.5 | +1 | +1.5 | +2 | +3 | +4 | +6 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Score | 5 | 12 | 27 | 32 | 38 | 50 | 56 | 62 | 68 | 73 | 82 | 88 | 95 |

We always show Δ in pp and `n` next to the ring, because the ring alone hides how much data
backs it.

## 6. What gets shown: sample-size gates

| Rule | Threshold | Effect |
|---|---|---|
| Hidden | n < 15 | The pair is not shown at all. |
| Greyed out | 15 ≤ n < 30 | Shown, but visibly marked as thin data. |
| Listed as "strong against", "weak against" or "good with" | n ≥ 50 **and** \|Δ\| ≥ 1.5 pp | Only these appear in the headline lists. |

When no pair passes, the page says there is no reliable data yet and shows the theory notes.

An optional extra gate, **|z| ≥ 2.5**, is available (see §7). It is **off by default**.

## 7. Calibration: does this actually work?

The thresholds above were first chosen by judgement. We check them with a simulation that runs
on every test run (`src/core/stats.sim.test.ts`):

- 90 synthetic heroes with known strengths and popularity.
- A known, sparse set of real counter relationships.
- 5v5 games simulated at two volumes over a 30-day patch window: about **330 Storm League games
  a day** (the low public estimate) and about **3,000 a day** (the high estimate).
- The exact pipeline above runs on the simulated games, and we count what a hero page would list.

What we found:

- **Hero win rates.** At 330 games a day, shrunk win rates are about 1.4 pp from the truth on
  average, closer than raw rates. At 3,000 a day they are about 0.6 pp away.
- **Low volume.** The gates list essentially nothing: well under one false counter per hero
  page, and almost no true ones either. At this volume Whetstone honestly says "not enough data"
  and leans on theory.
- **High volume, effects like those reported for real counters (a few pp, in a few percent of
  pairs).** False counters stay well under one per page. Roughly half to three-quarters of the
  large effects (6 pp or more) on pairs with 400+ games are found.
- **High volume, stronger and denser effects.** Shrinkage is weaker here, and the default gates
  can list 1–5 false counters per page. Adding the **|z| ≥ 2.5** gate brings this back under one
  per page while keeping most large effects. We will switch that gate on if measured data looks
  like this case.

Once real data exists, we will also check the gates against a held-out patch.

## 8. Tier lists

Tiers use **fixed bands**, not "top 10%". A hero keeps its tier when other heroes move, so the
list does not reshuffle every day.

**Heroes of the Storm:** the band is set by shrunk win rate minus 50%, in pp.

| Tier | Shrunk win rate − 50% |
|---|---|
| T1 | ≥ +2.5 pp |
| T2 | +1 to +2.5 pp |
| T3 | between −1 and +1 pp |
| T4 | −2.5 to −1 pp |
| T5 | ≤ −2.5 pp |

- Heroes with fewer than **200 games** are marked **early data** instead of getting a tier.
- Each hero shows its **change since the previous patch** (up, down or same) and the win-rate
  difference in pp.
- An optional **ban-rate nudge** adds 0.1 × (ban rate − average ban rate) to the win rate before
  banding, for games where bans signal strength. It is off by default.

**Pokémon Champions** bands on **usage %**: S ≥ 20, A ≥ 10, B ≥ 5, C ≥ 2, D below. A Pokémon's
win rate adjusts its usage only when the Wilson interval of that win rate excludes 50%:

- if the whole interval is above 50%, add ½ × (lower bound − 50%), in points;
- if it is below 50%, subtract ½ × (50% − upper bound).

Fewer than 30 games of win-rate data count for nothing, so a 6–1 run moves nothing; a 650–350
record adds about 6 points. Fewer than 30 teams behind the usage figure means early data.

## 9. Community votes (if they ever exist)

If Whetstone ever collects votes, a vote score will be **round(100 × Wilson lower bound)** of
up-votes out of all votes, at z = 1.96. This is the formula heroescounters.com used, and we matched
it on 27,700 of 27,700 rows. Rows whose raw lower bound is below 0.30 go behind "View more".

| Up / down | Score |
|---|---|
| 1 / 0 | 21 |
| 4 / 0 | 51 |
| 10 / 0 | 72 |
| 4 / 2 | 30, but collapsed (raw 0.2999…) |
| 452 / 237 | 62 |

The formula rewards certainty. A 4–0 matchup scores only 51.

## 10. Draft suggestions

The draft tool scores every hero you could pick or ban right now.

1. **Signals.** Each kind of evidence produces signals:
   - win rate, counters against the enemy's picks, synergy with your picks, map fit and tier;
   - theory, votes, role needs, and your personal hero pool.

   Each signal has a value on one shared scale, where **1.0 ≈ a 4 pp edge**: Δ / 4 pp for
   statistics, or the inverse of the ring formula for 1–100 scores. A signal also carries the
   reason that explains it. Counters and synergies use statistics when they exist, and otherwise
   theory, labelled as theory.
2. **Weights.** A *sort mode* is just a set of weights:

   | Mode | Weights |
   |---|---|
   | Composite (default) | win rate 1 · counters 1 · synergy 0.8 · map 0.6 · tier 0.3 · theory 0.5 · votes 0.5 · role 1 · pool 0.5 |
   | Win rate | win rate 1 |
   | Counters | counters 1 |
   | Synergies | synergy 1 |
   | Map | map 1 |
   | Tier | tier 1 |
   | Community | votes 1 (only when votes exist) |

3. **One key cannot drown the rest.** Many small edges of one kind (five enemies each countered a
   little) used to add up to 2–3 and outweigh the role guardrails. So all signals of one key from
   one provider are **soft-capped together**: their sum becomes **KEY_CAP · tanh(sum / KEY_CAP)**
   with KEY_CAP = 1.0 (about a 4 pp edge), shared out in proportion, so every reason keeps its
   share and its sign.
4. **Score.** Total = Σ weight × value. The displayed score is **round(50 + 50 · tanh(total))**,
   on a 0–100 scale.
5. **Why and watch-out.**
   - Up to **three reasons** are shown, from the largest positive contributions. A theory edge
     shows its **headline line** only (curated first); its other lines stay in the breakdown, and
     lines from the same rule (ignoring the evidence in brackets) count once across edges.
   - Statistics are worded as a verdict ("Beats your Valla", "Struggles against", "Works well
     with", "Does well on") only when they pass the list gate of §6 (n ≥ 50 and |Δ| ≥ 1.5 pp).
     Below it the line is neutral ("+0.5 pp against your Valla: too small to call"), stays in
     the breakdown and keeps its small value.
   - A reason that depends on a talent or a situation says so: "Only when …", each condition once.
   - At most **one warning** is shown: the most negative contribution, if it is worth more than
     about 0.4 pp.
6. **Ties.** Heroes are sorted by total, then by the uncapped evidence behind it (for bans, the
   summed strength of every counter), then by name. When the top three or more shown scores lie
   within 2 points, the list says it is a shortlist, not an order.

**Bans.** A ban step ranks heroes by how much they would hurt your team:

- **Breadth:** **0.45 · (1 − e^(−S / 12)) · min(1, picks the other side has left ÷ 5)**, where S
  sums the strength of every hard counter the hero has among the heroes the other side can still
  pick. Smooth and never flat, so a hero that counters 26 heroes outranks one that counters 6. The
  reason names the hardest-countered heroes first.
- **Pro bans** (theory mode only, when there are no match statistics): the share of pro maps
  that banned the hero, shrunk toward the average ban rate with 20 pseudo-maps, adds
  **(shrunk − average) × 3** on the tier key. It is credited to Liquipedia (CC BY-SA 3.0) where it
  is shown.

**Rules the draft respects:**

- The verified Storm League order with first-pick toggle: 3 bans per team, split 2 + 1.
- No hero on both teams, and no picking a banned hero.
- Cho'gall takes two consecutive picks of the same team and is only offered at those steps.
- Free mode places heroes on either team in any order. It can also list suggestions for the
  other team; adding one of those heroes puts it on that team and keeps your own target.

**Role needs** (`src/games/hots/draft/roles.ts`). A team should end with a Healer and a frontline
hero (Tank or Bruiser, main or flex role). Only a short curated list of non-Healers can stand in
for the Healer: **Medivh and Zarya** (their shields and saves carry a team through fights). The
Lost Vikings and Abathur never count.

- A pick that leaves fewer pick slots than unmet needs gets a large penalty and a warning ("No
  Healer").
- A pick that fills an open need gets a bonus: **0.2 + 0.3 to 0.4 × urgency**, where urgency is
  open needs ÷ picks left. In Storm League urgency starts at 0, because your team's later picks are
  planned. A need nobody available can fill any more is dropped and mentioned once.
- Smaller penalties, each with its reason: a second main-role Tank, a second (or third) Healer, a
  second Support, a third Melee Assassin, a fourth melee hero, a finished team without ranged
  damage. On a team's **last two picks** these grow **× 1.75** (× 1.25 in ARAM): the composition
  is all but decided, so a second Healer costs 0.79 instead of 0.45.
- **Last-pick guardrails:** a finished team with **no waveclear**, or with **at most one hero with
  hard crowd control** (stun, root, polymorph, sleep, taunt, fear, time-stop), gets a 0.2 penalty
  (0.15 in ARAM), but only when someone still available could close the gap. The warning names
  the heroes and tags behind it ("only Muradin (stun)").

**Draft review.** When the draft is complete (all 16 Storm League steps, or both teams full in
free mode) a review card shows the three strongest matchups in each direction (each net of the
edge back, edges below 0.1 left out), the best synergy pair of each team, each team's best and
weakest map fit and the role verdict, with the same evidence bar as hero pages: statistics that
pass the list gate when statistics are in use, theory otherwise. A copy button gives a plain-text
summary for Discord, with the share link and the credits of the data it used.

**ARAM helper.** You choose one of the three heroes you are offered, so there is no draft order.
The same role needs apply with gentler penalties, with one difference: **a gap you can fill counts
fully** (urgency never below 1), because your teammates still to lock get random options of their
own and may not be able to fill it. ARAM rankings use theory and ARAM statistics only, never
Storm League numbers.

## 11. Theory scores and what a hero page lists

Without match statistics, matchups come from the theory layer (`docs/THEORY.md`): rules
about what kits do to each other, plus matchups that curators wrote and checked against the
current kit text. Theory scores use the same 1–100 ring, but they measure how hard one kit
punishes another, not how often a matchup is won.

**One list per opponent.** Both heroes of a pair can have tools against each other, so the data
holds two directed scores. A hero page nets them the way the draft tool does: value(you → them)
− value(them → you), where value is the inverse of the ring formula (§10). The opponent appears
under "strong against" if the net is positive and under "weak against" if it is negative, never
under both, with the net as its score. Its reasons show both sides, the winning side first.

| Rule | Threshold | Effect |
|---|---|---|
| Not stored | generic score within 4 points of 50 | Too close to neutral to mean anything; left out of the data. Curated matchups are always kept. |
| Listed as "strong against", "weak against" or "good with" | curated, or a generic score ≥ **65** that is among the hero's **8** strongest generic rows in that list | One strong interaction the hero always has, or two clear ones. A match that only works through a talent tops out at 62 on its own. Broad rules match much of the roster, so only the strongest few generic matches head a list. |
| Below the bar | every other row above 50 | Shown behind "weaker mechanical edges" under the list. |

Within a list, curated matchups come first, then generic ones, each by score. A reason that only
holds when a hero takes a certain talent or Heroic says so, naming every pick that works ("Only
when Anduin takes Lightbomb or Censure"); a hand-written matchup that depends on a talent, a
Heroic or a situation carries the same "Only when …" line, and is rated low confidence when the
whole effect rests on that one choice. A rule that applies both ways round (both heroes blind,
both rely on Basic Attacks) is a wash and only counts by how much more it favours one side. The
draft tool uses every stored theory edge, weighted by its score.

**Map fit.** A hero page's "Best maps" lists only maps scoring above 50. Maps whose layout or
objective works against the kit (below 50) are listed separately as "Harder maps", hardest first.
Map pages split their hero lists the same way.

## 12. Freshness

Every page shows how old its data is. The data job runs once a day.

| Badge | Age of the last successful build |
|---|---|
| Fresh | under 30 hours |
| Aging | 30–54 hours (one run missed) |
| Stale | 54 hours or more |
| Broken | a source failed and has never produced data |

A source whose latest fetch failed keeps showing its last good data. It is labelled as such and is
never called "fresh". Disabled sources (for example an optional source the site owner has not
switched on) are listed as disabled, not broken.

## 13. Known biases

- **Who uploads replays.** Uploaders skew toward engaged, higher-rated players, and some regions
  (notably China) are barely present.
- **Rank.** League bands come from the data provider's own rating, not Blizzard's rank.
- **Parties.** Storm League includes party games, and coordinated groups win more.
- **Quick Match** can contain mirror matches. We exclude them where the source allows.
- **ARAM.** Each player chooses from a small random set, so an ARAM win rate means something
  different from a draft win rate.
- **Patches.** We use whole-patch windows. For the first 14 days of a patch the previous patch's
  data is blended in at half weight, and the page says so.

None of these numbers predict a single game. They describe tendencies over many games.
