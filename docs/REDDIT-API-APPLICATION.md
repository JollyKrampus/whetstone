# Reddit Data API access request (draft for Troy to submit)

Whetstone does not read Reddit today. The community-consensus miner has a Reddit adapter switched off
(`REDDIT_MODE=off`), and it stays off until Reddit approves this request **in writing**, with the
approval explicitly covering the use described below. Submit this through Reddit's developer support /
data API access form while signed in as the account that will own the app. Edit anything that doesn't
sound like you.

---

**App name:** Whetstone community notes (read-only)

**Developer:** Troy (Reddit: u/<your username>; GitHub: JollyKrampus)

**Contact:** <your email>

**Type of use:** Personal, non-commercial, read-only. No ads, no paywall, no data sales. The project
is open source: https://github.com/JollyKrampus/whetstone

**What the project is:** Whetstone is a free fan site for a handful of games (Heroes of the Storm,
MTG Arena, Pokémon Champions, Dead by Daylight, The Duskbloods). It explains matchups, builds and
patch changes. Most of its content comes from game data and the owner's own analysis. We would like
to add a "what players are saying" layer that summarises how the community currently sees a matchup
or a balance change, with links back to the discussions.

**Exactly what we would read:** New public posts and top-level comments from a short, fixed list of
game subreddits (for example r/heroesofthestorm, r/MagicArena, r/VGC, r/deadbydaylight,
r/TheDuskbloods), at most once a day, through the official OAuth API with a descriptive User-Agent,
well under the published rate limits (a few hundred requests a day in total).

**What we would do with it:**
- A language model reads each post once to pull out structured claims such as "hero A is strong
  against hero B because of X" or "this patch made Y weaker".
- Only aggregates are published: how many distinct posters made a claim, whether it is contested, a
  short summary written from our own templates, and links to up to five original threads. We never
  publish quotes, post text, usernames or profile data.
- Raw post text is kept only in memory during the daily run; it is never written to disk or published.
  The working record holds the permalink, a one-way hash of the author id (so one person is counted
  once), the extracted claim fields and the post date.
- Every day we re-check the permalinks behind published claims and drop any claim whose post or
  comment was deleted or removed.
- Reddit data is **not** used to train or fine-tune any model, and is not shared with anyone else.

**Why the API and not scraping:** we want to follow Reddit's terms, respect deletions, and give
Reddit a clear record of what we do.

**Questions we would like answered in the approval:**
1. Is the use above (model-assisted extraction of claims, publishing only aggregates plus links) permitted?
2. Any attribution wording you require next to the summaries?
3. Any limits on retention of the hashed author ids and permalinks (currently 120 days)?

Thank you for considering it.
