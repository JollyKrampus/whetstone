# Recorded raw fixtures (HotS pipeline)

`node pipeline/run.ts --game hots --offline` and the pipeline unit tests read these files instead
of the network (`pipeline/http.ts` looks up `<fixture key>.<json|txt|bin>`). They are real
upstream responses recorded on 2026-10-08, trimmed to stay small:

| Key | Source | Trimmed to |
|---|---|---|
| `tact/hero-versions.txt`, `tact/herot-versions.txt` | Blizzard version server (live, PTR) | verbatim |
| `heroes-data2/version.json` | heroes-data2 `.version.json` | versions 2.55.17.98025, 2.57.0.98126_ptr, 2.57.0.98285, 2.57.0.98348 |
| `heroes-data2/releases.json` | GitHub releases API (heroes-data2) | `tag_name` and `published_at` of those builds |
| `heroes-data2/heroes-data-no-maps-<build>.bin` | release zip of each build (MIT) | herodata and enUS game strings of Abathur, Alexstrasza, Cho, Gall and Xal'atath; full mapdata; Korean and Russian hero names (2.57.0.98348 only) |
| `heroes-images/tags.json` | GitHub tags API (heroes-images) | four tags |
| `heroes-images/files/*.png.bin` | heroes-images@v2.57.0.98285 | two images, shrunk to 32 px; every other image is a placeholder offline |
| `blizzard-news/feed-0.json` | news.blizzard.com feed API | three items, one page |
| `blizzard-news/article-<newsId>.txt` | Blizzard patch-note articles | the article section only; new-hero kit text, bundles and most hero blocks removed (Garrosh is kept to exercise the "hero not in the data" path) |
| `nexus-compendium/currently.json` | Nexus Compendium `/api/currently/herorotation+ranked` | verbatim |
| `liquipedia/search-*.json`, `revisions-2026-1.json`, `pages-1.json` | Liquipedia MediaWiki API | three tournament pages reduced to their infobox and first drafted maps (no participant, team or player names); page checks for the five heroes |
| `liquipedia/recentchanges.json` | Liquipedia MediaWiki API | an empty change list, so a second offline run takes the incremental path |

Game data and patch notes are © Blizzard Entertainment. Liquipedia content is CC-BY-SA 3.0
(https://liquipedia.net/heroes/). Nothing from Heroes Profile is ever recorded here.

To refresh a fixture, run the pipeline with `WHETSTONE_RECORD=1` against the live sources into a
scratch directory, then trim the recorded file the same way before committing it.
