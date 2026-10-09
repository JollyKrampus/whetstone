Sample curated files for the theory loader tests (src/games/hots/theory/curated.test.ts).
Not real curation: the real per-hero files live in curated/hots/heroes/. The tests copy the
global files from curated/hots/ plus `heroes/*.yaml` from here into a temporary repo root,
and add one file from `invalid/` at a time to check each error.
