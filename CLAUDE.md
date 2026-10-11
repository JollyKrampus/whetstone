# Whetstone: rules for agents

This repo is **public** (https://github.com/JollyKrampus/whetstone). Everything committed to any
branch — `main`, `data`, feature branches, tags, PR text, issue text — can be read and archived by
anyone, forever. Deleting it later does not undo that. Treat every commit, merge and push as publishing.

## The public-repo law

Before every commit, merge, push, PR or issue:

1. **Look at exactly what you are publishing.** Read `git diff --cached` (or the PR diff, or the issue
   body) in full. Never `git add -A` blindly in a tree that holds local files; check `git status` first.
2. **Never publish secrets.** No API keys, tokens, passwords, private keys, cookies or `.env` contents —
   not in code, fixtures, logs, docs, test snapshots or commit messages. Secrets live only in GitHub
   Actions secrets or the home box's root-only env files.
3. **Never publish the owner's private details.** No personal email (commits use
   `2280396+JollyKrampus@users.noreply.github.com`; the repo-local git config is set to it), real
   address, phone, account ids, gamer tags or battletags, machine or host names, tailnet names or
   addresses, home-network ports beyond what `docs/SPEC.md` already states generically, or file paths
   that reveal them. Refer to the private server as "the home box" and the gaming PC as "the desk PC".
4. **Never publish other people's data.** Player names, handles, battletags, chat and usernames from
   replays, logs, tournaments or forums are stripped or HMAC'd before anything is written. Personal
   match data (custody class **P**) never leaves the private hub. Classes B, C and D are never committed.
5. **Never publish copied creative text.** No prose copied from patch-note articles, wikis, guides,
   forums or tournament write-ups; store facts, numbers, game data fields and our own wording with a
   link. Respect each source's licence and attribution rule.
6. **Keep local-only material local.** `.research/`, `data/`, `.cache/`, `.claude/`, `dist/` and
   anything under the session scratchpad are never committed. If something should be shared, rewrite
   it for a public audience first.
7. **No history surgery on published branches.** Never force-push `main` or `data`, and never rewrite
   commits that have been pushed. If something private was pushed, stop and tell the owner — removal
   means rotating the secret and possibly a GitHub support request, not a quiet rewrite.
8. **Merges are deliberate.** Merge only branches whose full diff you have read and whose gate passed
   (`npm run lint`, `npm run check`, `npm test`, `WHETSTONE_FIXTURES=1 npm run build`,
   `WHETSTONE_FIXTURES=1 npm run e2e`). The `public hygiene` test (`test/public-hygiene.test.ts`) must
   pass; never weaken it to get a change through.

If you are unsure whether something is safe to publish, it isn't. Ask the owner first.

## Other standing rulings

- No beta/alpha labels: every shipped game is `live`.
- Own the tooling: first-party public data, openly licensed data and our own analysis; no dependence
  on paid third-party aggregators.
- Design and decisions: `docs/SPEC.md` (§12 decisions log, §13 v2). Open work: the GitHub issues.
