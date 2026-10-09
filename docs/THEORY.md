# HotS theory layer

The theory layer gives every Heroes of the Storm hero page, map page and the draft tool counters,
synergies and map fit **without any win-rate data** (SPEC §5.1). It reads what each hero's kit
does, applies a small set of mechanical rules an experienced player would accept, and adds
matchups that curators wrote by hand. Everything it produces is labelled as theory in the UI and
carries the reasons behind each score.

When Heroes Profile statistics are switched on, stats edges become primary and theory reasons are
shown next to them (`src/games/hots/load.ts`). Without them, theory is all there is, so it has to
be honest: specific where the kit text is specific, and modest where it is not.

Code lives in `src/games/hots/theory/`; curated inputs live in `curated/hots/`.

## Contents

1. [Pipeline contract](#pipeline-contract)
2. [Mechanics extraction](#mechanics-extraction)
3. [Curated traits and per-hero files](#curated-traits-and-per-hero-files)
4. [Rules and scoring](#rules-and-scoring)
5. [Map fit](#map-fit)
6. [Contributing a counter](#contributing-a-counter)
7. [Extractor precision](#extractor-precision)
8. [What pages list](#what-pages-list)
9. [Calibration on the 2.57 roster](#calibration-on-the-257-roster)
10. [Known limitations](#known-limitations)
11. [Developer tools](#developer-tools)

## Pipeline contract

`src/games/hots/theory/index.ts` is what the HotS data pipeline calls:

```ts
const curated = loadCurated(repoRoot);                          // Node only: reads curated/hots/
const tagged = heroes.map((h) => ({ ...h, mechanics: extractMechanics(h) }));
const merged = applyCuratedTraits(tagged, curated);             // heroes.json `mechanics`
const theory = buildTheory({ heroes: merged, maps, curated });  // theory.json
```

| Export | Purity | What it does |
|---|---|---|
| `RULES_VERSION` | constant | Version of the extraction and scoring logic. `theory.json` `rulesVersion` is `RULES_VERSION + "+" + hash(curated inputs)`, so it changes whenever the engine or any curated file changes. |
| `extractMechanics(hero)` | pure, browser-safe | Tags from one hero's ability and talent text, with evidence. A composite (Cho'gall) has no kit and returns `[]`. |
| `loadCurated(repoRoot)` | Node (fs) | Reads `curated/hots/{traits,rules,counters,synergies,maps,aliases}.yaml` and `curated/hots/heroes/*.yaml`, validates them with zod, merges them, and throws a `CuratedError` listing every problem with its file path. |
| `applyCuratedTraits(heroes, curated)` | pure | Adds curated tags (evidence kind `curated`), removes tags marked `op: remove`, and gives a composite the union of its members' mechanics when the members are in the list. Idempotent. |
| `buildTheory({ heroes, maps, curated })` | pure, browser-safe | Counters, synergies and map fit for every draftable hero (composites included, members skipped). Output is sorted and validates against `TheorySchema`. Curated traits are re-applied, so heroes may be passed with or without them. |

`engine.ts`, `extract.ts`, `text.ts` and `weights.ts` never touch Node APIs; only `curated.ts`
(and the CLIs) read files. `index.ts` re-exports `loadCurated`, so browser code imports the engine
modules directly.

## Mechanics extraction

`extract.ts` reads each ability and talent tooltip (as rendered into heroes.json) sentence by
sentence and turns it into tags from the `MECHANIC_TAGS` vocabulary in `schema.ts`. Each tag keeps
up to four pieces of evidence: the ability or talent name and a snippet of at most 120 characters
of the sentence that matched. Abilities come first, then talents by tier.

How a sentence is read:

1. Per-level scaling ("(+4% per level)") and typography are normalised, and the text is split into
   sentences. Quest requirements ("Quest: Stun 20 Heroes") are skipped; rewards are read.
2. The hero's own ability and talent names are masked, so "Snow Blind's cooldown" never counts as
   a blind and "Entangling Roots" never counts as a root unless the sentence applies it.
3. Mentions of crowd control that do not apply it are blanked: states used as conditions
   ("Stunned enemies take…", "while Rooted", "when Malfurion is Stunned"), the hero being the one
   affected ("Nova is Revealed"), lists of effect types ("Stuns, Roots, and Slows"), and removal or
   immunity ("remove all Slows", "cannot be Slowed").
4. Each tag's patterns run on what is left. A tag is credited once per ability or talent.

Tag-specific care:

| Tag | Counts | Does not count |
|---|---|---|
| `heal-self` / `heal-ally` | A heal with an amount or a recipient; the recipient decides which tag. | Healing modifiers ("receive 25% increased healing"), healing reduction, healing by summons, minions or structures. |
| `anti-heal` | Healing reduction applied to enemies. | The hero's own reduced healing, Healing Fountain cooldowns. |
| `shield` | Shields the hero or allies gain. | Damage to enemy Shields, "destroys Shields". |
| `unstoppable` / `cleanse` | Unstoppable for the hero is `unstoppable`; Unstoppable granted to allies, or removal of Stuns/Roots/Silences, is `cleanse`. | |
| `channel` | Channels that can be interrupted. | Channels that make the hero Protected or Unstoppable (Deflect, Lightning Breath, Counter-Strike); abilities usable while channelling; interrupting enemy channels. |
| `block` | Block charges, evasion and Basic Attack parries. | "Blocks 330 damage with Deflect" (damage blocking is not Basic Attack block). |
| `global` | Abilities usable anywhere on the battleground (Flight, Brushstalker, Shadow Fissure, Apocalypse). | "Unlimited range" shots and beams fired from where the hero stands; map-wide vision. |
| `aoe` | Damage to several enemies in an area, line or arc. | A skillshot that stops at the first enemy hit. |

Derived, hero-level tags (thresholds calibrated on the 2.57 roster, constants at the top of
`derive()`):

- `aa-reliant`: a damage role (assassin or bruiser) with at least one basic ability built around
  Basic Attacks and at least three talents that boost them (score ≥ 6, two points per ability).
  Deliberately strict; curators add mixed heroes.
- `sustained-dps`: `aa-reliant`, or two basic abilities that deal damage per second.
- `burst`: an assassin that is not `aa-reliant` with a basic ability hitting for 220+, two hitting
  for 400+ together, or a Heroic hitting for 600+. Damage over time and bonus damage for a
  completed channel do not count.
- `poke`: a ranged assassin or support (not `aa-reliant`) with two basic abilities hitting for 75+.
- `waveclear`: explicit bonus damage to minions, or area damage on two basic abilities.

**Talent-only tags.** A tag whose only evidence is a talent, or one of several Heroic choices,
is optional: the hero may not take it. Rules count at 0.6× their weight when a side only matches
through an optional tag. A tag every Heroic grants (both of a hero's Heroics) counts in full.

**Composites.** Cho'gall has no kit of its own. `applyCuratedTraits` gives the composite the union
of Cho's and Gall's mechanics, and the engine scores only the composite. Curated pairs that name
`cho` or `gall` resolve to `chogall`.

## Curated traits and per-hero files

Some tags cannot be read from tooltips: `immobile`, `dive`, `split-push`, `vulnerable-body`,
`frontline`, `peel`, `engage`, `save` (the `TRAIT_TAGS`), and judgement calls such as
`aa-reliant` for a hero whose numbers do not show it. Curators add them, with a one-line
justification, in the hero's own file. `op: remove` suppresses a tag the extractor got wrong.

Each draftable hero has one file, `curated/hots/heroes/<slug>.yaml` (slug: lowercase
alphanumerics of the English name, `chogall` for Cho'gall):

```yaml
hero: abathur
reviewedFor: "2.57"          # the major patch the whole file was checked against
traits:
  - tag: vulnerable-body
    why: "While he steers a Symbiote, Abathur's body is left alone and nearly defenceless."
counters:                    # a counters b; this file's hero must be a or b
  - a: zeratul
    b: abathur
    why: "Permanent Cloak lets Zeratul reach Abathur's body unseen, and Cleave plus Singularity Spike kill it before Deep Tunnel is ready."
    evidence: ["Permanent Cloak", "Cleave", "Singularity Spike", "Deep Tunnel"]
    conditions: "Abathur is alone in a back-line bush."   # optional, one line or a list
    confidence: high          # low | medium | high
    # weight: 0.5             # optional override of the confidence weight
    # reviewedFor: "2.57"     # optional, defaults to the file's
synergies:                   # stored with a < b (alphabetical)
  - a: abathur
    b: illidan
    why: "A Symbiote on a diving Illidan adds Spike Burst and Stab damage, and Carapace keeps him alive."
    evidence: ["Symbiote", "Carapace", "Dive"]
    confidence: medium
```

`curated/hots/traits.yaml`, `counters.yaml` and `synergies.yaml` hold the same entries for cases
that do not belong to one hero and are normally empty.

**Merging.** The same pair may appear in two heroes' files (Zeratul over Abathur is in both). The
loader keeps one edge per kind and pair: the highest confidence, the union of evidence and
conditions, up to two distinct `why` lines (global files first, then per-hero files by name), the
newest `reviewedFor`, and the explicit `weight` if any file sets one (a warning if files disagree),
else the confidence weight. A counter curated both ways (a > b and b > a) keeps both directed edges
and is reported as a warning. Duplicate traits are dropped with a warning; adding and removing the
same tag warns, and the later entry wins.

**Validation.** Run `node src/games/hots/theory/validate.ts`. It reports, with file paths:

- errors (exit code 1): YAML syntax, unknown keys, unknown tags, a pair that does not involve the
  file's hero, a synergy not stored with a < b, a pair without evidence, a file named after another
  hero, an unknown hero slug;
- warnings: merge conflicts, contradictions and, when hero data is available
  (`--heroes data/current/hots/heroes.json`, the default when a pipeline run left one), heroes that
  are not in the current data and evidence names that are not an ability or talent of either hero.
  Evidence names match regardless of case, apostrophe style and punctuation.

`--strict` also fails on warnings. The unit test suite loads the real curated files, so a broken
file fails CI.

## Rules and scoring

`curated/hots/rules.yaml` holds generic, mechanical rules: 22 counter rules and 11 synergy rules
(documented in the file header). A rule has two sides of tag expressions (`blind`,
`burst&type:ranged`, `role:tank`), a weight and a one-line `why` template.

For every ordered pair of draftable heroes (A, B):

```
net(r, A, B) = weight × min(factor(A side), factor(B side))
               − the same for r applied B → A, when r also matches that way   (never below 0)
rules(A, B)  = Σ over matching counter rules of net(r, A, B)
x(A, B)      = clamp(rules, ±0.6) + curated pair weight            (then clamped to ±2)
score        = round(50 + 50 · tanh(x))                            (50 = neutral, 1..100)
```

- Each rule counts once per pair. `factor` is 1 for a tag the hero always has (a basic ability,
  its trait, every Heroic, a curated trait, a role or type selector) and 0.6 for an optional tag.
- The generic rules of one pair stop at 0.6 (score 77), so a hero with many generic weaknesses is
  not hard-countered by everyone, and a curated pair (low .2, medium .4, high .6) still moves the
  score: a curated pair on top of capped rules reaches 83-92. SPEC §5.1.6 calls this "each rule
  counted once per pair, capped".
- **Mirror matchups are a wash.** A counter rule that matches both ways round (both heroes Blind
  and rely on Basic Attacks; both are global split-pushers) only counts by how much more it
  favours A: Cassia and Xal'atath no longer "counter" each other at 77 through the same blind
  rule. Negative (penalty) rules apply as written.
- Counters are directed (A counters B). An edge is stored when its score is more than 4 points
  from 50 (`PRUNE_MARGIN` in `weights.ts`) or a curated pair exists: the 46-54 band is one mild rule
  reached through a talent, or rules that cancel out, and carries no usable signal. Synergy rules
  are tried both ways and count once (the stronger direction); synergies are stored with a < b.
- Edge `source` is `curated` when a curated pair exists, else `theory`.

| Weight | Score | Used for |
|---|---|---|
| 0.1 - 0.15 | 55 - 57 | broad, mild effects (any stun vs a channel) |
| 0.2 - 0.25 | 60 - 62 | clear but common interactions |
| 0.3 - 0.4 | 65 - 69 | strong, specific interactions (blind vs Basic Attack carriers, reveal vs stealth, dive vs immobile) |
| cap 0.6 | 77 | the most generic rules can say |

**Reasons.** Curated `why` lines come first, then up to four rule reasons, strongest first. A rule
reason renders its template with the hero names, tag labels and up to two evidence names of A's
tag; when A's tag has no evidence (a curated trait, a role selector), the " ({evidence})" group is
dropped. Evidence names come from the current game data, so reasons stay true when a kit changes.
The reason's `evidence` list is only attached when the template does not already quote it.

**Talent conditions.** When a side matches only through a talent or one of several Heroics, the
reason says so, naming the pick: "Abathur can reveal enemies (Toxic Nest), taking away Genji's
stealth. Only when Genji takes Pathfinder." When both sides need one: "Only when Chromie takes
Timewalker's Pursuit. Tassadar must also take Shadow Walk."

**Draft shard.** `public/draft.json` (schema 2) stores each reason once as a template, with the
edge's hero names replaced by `{a}`/`{b}` (map fit: `{a}`/`{m}`) and the talent conditions as separate
parts, so one line serves every pair a rule matches; `src/games/hots/draft/data.ts` fills the names
back in. On the 2.57 roster that takes the shard from 2.14 MB (243 KB gzipped) to 518 KB (100 KB).

## Map fit

`curated/hots/maps.yaml` holds a factual profile for each of the 15 standard and 4 ARAM maps
(size, lanes, a one-line objective in our own words, and `MAP_TAGS`) plus `fit` rules: a map tag
and a hero tag expression with a weight and a template. For each hero and map, the matching rules
add up (same 0.6 cap, same 0.6× for optional tags) to a score; a hero no rule matches on a map gets
no entry, which the UI treats as neutral. Map-fit weights are smaller than counter weights
(0.1 - 0.3), because a map changes a hero's value less than a matchup does. Examples:
`global-on-large-maps` (+0.3), `immobile-on-large-maps` (−0.15), `split-push-on-three-lanes`
(+0.2), `siege-on-structure-maps` (+0.2), `damage-for-pve-objectives` (+0.2),
`poke-in-single-lane` (+0.25).

## Contributing a counter

Counters and synergies are curated by pull request, one hero file at a time.

1. Open `curated/hots/heroes/<slug>.yaml` for either hero in the pair (or both: the same pair in
   two files merges into one edge).
2. Add an entry under `counters` (A counters B) or `synergies` (alphabetical a < b), in the format
   above. Keep `reviewedFor` at the patch you checked.
3. Run `node src/games/hots/theory/validate.ts` and `npm test`.

**The evidence rule.** Every pair names, in `evidence`, the abilities or talents its reason relies
on, spelled as in the game. The reason must be true for the current kit text: if a talent is
needed, name it in `evidence` and say so in `conditions`. Reasons that cannot point at a kit
("he is just strong", "pros pick it") do not belong here; they are what statistics are for.

**Write it yourself.** `why` is shown verbatim to players. Write one or two plain sentences in
your own words about the mechanics. Do not copy or paraphrase closely from guides, tier lists,
Icy Veins, heroescounters.com or other community sites, and do not import their votes or tags.
Ability and talent names and numbers from the game data are fine.

**Confidence guide.**

| Confidence | Weight | Use when |
|---|---|---|
| `high` | 0.6 | The interaction is direct and reliable whatever either player does: a hard answer built into both kits (Permanent Cloak reaching an undefended body, a blind against a pure Basic Attack hero). |
| `medium` | 0.4 | The interaction is real and usually decides trades, but skill, positioning or a common talent can change it. Most entries are medium. |
| `low` | 0.2 | A real but situational edge: it needs a specific talent, map or team setup, or it only matters in one phase of the game. |

Use `weight` only when a matchup is clearly stronger or weaker than its confidence suggests, and
explain why in the pull request. Negative weights are allowed but almost never needed: write the
pair the other way round instead.

**Traits** follow the same rules: one line, true for the current kit, in your own words. Use
`op: remove` (with the reason) when the extractor tagged something the hero cannot actually do;
check `src/games/hots/theory/dev/tags-report.md` to see what was extracted and from which
ability or talent.

## Extractor precision

The extractor was developed against the full 2.57.0.98348 kits of all 89 heroes plus Cho and Gall
(`dev/fromHeroesData.ts` turns a heroes-data2 release into hero records). Every hero's tags and
evidence are listed in `dev/tags-report.md`. 37 heroes were checked by hand against their kit text:
Abathur, Alarak, Alexstrasza, Ana, Anduin, Anub'arak, Artanis, Arthas, Auriel, Azmodan, Blaze,
Brightwing, Cassia, Chen, Cho, Gall, Chromie, Deathwing, Diablo, Garrosh, Genji, Johanna,
Kel'Thuzad, Lúcio, Maiev, Malthael, Nova, Ragnaros, Stitches, Tracer, Tyrael, Valeera, Valla,
Varian, Whitemane, Xal'atath and Zeratul; the rest were reviewed from the compact tag list.

False positives found and fixed during the check (each now has a test):

- Discord Strike's Silence was dropped because "Alarak take 165 damage and are silenced" read as
  Alarak being silenced; the "self is affected" pattern no longer crosses a verb.
- Telekinesis ("pushing Alarak and all enemies hit") was not displacement.
- Deflect, Lightning Breath and Counter-Strike counted as interruptible channels.
- "Usable while Channeling All Shall Burn" made Azmodan's other abilities channels.
- Ana's Eye of Horus, Artanis's Heroics and Nova's Precision Strike counted as map-wide presence
  ("unlimited range").
- Abathur's Stab (first enemy hit) counted as area damage.
- Genji's Dragon Claw ("blocks 330 damage") counted as Basic Attack block.
- Burst read conditional or over-time numbers: Overkill's damage over 4 seconds and All Shall
  Burn's full-duration bonus; Blizzard's damage rating (8+ for nearly every assassin) was dropped
  as a criterion.
- Varian's Parry ("incoming Basic Attacks") counted as Basic Attack reliance; the derived
  `aa-reliant` tag was tightened (Zeratul, Kerrigan and D.Va no longer get it).
- Cheap Shot's "Stun, Blind, and damage an enemy" was read as a list of effect types and lost
  Valeera's stun and blind.
- Flying Kick ("kick through target enemy") was missing as a dash.

Remaining known imprecisions (accepted, or left to curators):

- Abathur's `teleport` evidence includes the Monstrosity's Burrow (a unit he controls).
- Tracer gets `burst` from Melee (220) and Murky from Pufferfish (330); Gall misses `burst`
  (Runic Blast 210 is under the 220 threshold).
- `heal-self` is nearly universal because many talents heal; it only matters through rules that
  also require a role, so it is harmless.
- Generic Armor ("gain 40 Armor") is not counted as `physical-armor` or `spell-armor`; only explicit
  Spell or Physical Armor is.
- Healers whose healing is a toggle or aura (Lúcio's Crossfade) may lack `heal-ally` from basic
  abilities; rules that care use `role:healer` as well.

## What pages list

Hero pages list a theory edge in "strong against", "weak against" or "good with" when a curator
wrote it, or when its generic rules reach **65** (`THEORY_GATES.listMinScore` in
`src/games/hots/load.ts`): one strong interaction the hero always has, or two clear ones. A match
that only works through a talent tops out at 62 on its own, so it never heads a list alone.
Curated matchups come first, then generic ones, each by score. Edges scoring 55-64 stay one tap
away under "weaker mechanical edges"; the draft tool weighs every stored edge by its score.
`docs/METHODOLOGY.md` §11 says the same for players.

## Calibration on the 2.57 roster

From the live pipeline run of 9 October 2026 (build 2.57.0.98348, rules `1.5`, 90 draftable heroes,
572 curated counter pairs, 238 curated synergy pairs):

| | Edges | 55-59 | 60-69 | 70-79 | 80-89 | 90-99 |
|---|---|---|---|---|---|---|
| Counters | 5,039 of 8,010 ordered pairs | 1,660 | 2,234 | 875 | 262 | 8 |
| Synergies | 2,590 of 4,005 pairs | 708 | 866 | 898 | 118 | 0 |

1,370 map-fit entries. 2,314 counter edges clear the list bar (curated or 65+). 181 generic
counters sit at the 77 cap. The strongest counters (92) are Johanna over The Butcher and Illidan,
Genji over Jaina, Medivh over Nova and Zeratul over Abathur and Sgt. Hammer: each a curated pair on
top of capped rules. The most countered heroes by edges scoring 65+ are Murky, Genji, Nova,
Zeratul, Valeera, Thrall, Xal'atath, Probius, Li-Ming and Xul (46-55 edges each, mean incoming
71-74): fragile or Basic-Attack heroes with known hard answers, which matches common experience.
theory.json is 3.1 MB as compact JSON (284 KB gzipped).

Before this tuning (rules `1.1`) the same roster gave 6,489 counters and 2,653 synergies (3.7 MB),
every edge above 50 was listed (Abathur "weak against" 71 heroes, Zeratul "good with" 85), and
generic rules produced lines such as "D.Va reduces healing received (Aggression Matrix), which
cuts into Johanna's healing" at 77 and Abathur and Dehaka "countering" each other at 77 through the
same global-vs-split-push rule. Now Abathur lists 13 / 28 / 14 heroes (strong / weak / good with),
curated first, and those lines are gone or carry their talent condition.

## Known limitations

- **Text is not gameplay.** The extractor reads what tooltips say, not hitbox sizes, cast times,
  projectile speeds or how a hero is actually played. "Immobile", "dive" and similar judgements
  come only from curators.
- **Rules are generic.** A rule fires for every hero with the tag, so it cannot tell a strong stun
  from a weak one or a core talent from a niche one. The cap and the 0.6× talent factor limit the
  damage; curated pairs supply the specifics.
- **Counters are not antisymmetric.** A > B and B > A are scored from different rules, so both can
  be above 50. They are separate statements ("A has tools against B", "B has tools against A").
  Only the same rule matching both ways is netted out.
- **No team context.** Scores are pairwise. Comps, double support, map timing and talent
  build-paths are left to the draft engine's other signals and to statistics.
- **Patch drift.** Curated entries carry `reviewedFor`; evidence names are checked against current
  kits, but a numeric change that flips a matchup is only caught when a curator re-reviews it.
- **Theory is a fallback.** When Heroes Profile statistics exist for a pair, they are primary and
  theory only explains.

## Developer tools

Dev-only scripts (not used by the site or pipeline) need an unpacked heroes-data2 release
(`data/herodata_<build>.json` and `gamestrings/gamestrings_<build>_enus.json`):

```sh
# Tags for every hero (writes src/games/hots/theory/dev/tags-report.md), optional theory.json and calibration stats
node src/games/hots/theory/dev/build.ts --hdp <dir> [--theory out.json] [--stats out.md]

# What the extractor read for some heroes; --sentences shows each matching sentence as read
node src/games/hots/theory/dev/inspect.ts --hdp <dir> --hero alarak,genji [--sentences "silenc"]

# Validate the curated files (add --heroes <heroes.json> for roster and evidence checks)
node src/games/hots/theory/validate.ts
```

Tests: `extract.test.ts` (golden tags for 18 real kits in `__fixtures__/kits.json` plus synthetic
precision cases), `engine.test.ts` (scoring, caps, merging, composites, reasons, determinism,
schema), `curated.test.ts` (loader, merge rules, every error with its file path, the real curated
files), `text.test.ts`, `dev/build.test.ts`. Sample per-hero files for the loader tests live in
`__fixtures__/curated/`, never in `curated/hots/heroes/`.

Game data (ability and talent names and tooltip text) comes from Heroes of the Storm via
HeroesToolChest heroes-data2 (MIT); game content © Blizzard Entertainment, Inc.
