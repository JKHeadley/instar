# Side-Effects Review — Squash-merge-aware worktree reaper

**Version / slug:** `reaper-squash-merge-aware`
**Date:** `2026-06-26`
**Author:** `echo`
**Tier:** 1 — enhances an EXISTING merged-detection on the AgentWorktreeReaper (which
ships OFF + dry-run by default). Adds a fail-safe, conservative network SIGNAL + a config
off-switch. No new authority, no new gate, no new route. The reaper's safety contract
("NEVER delete unmerged work") is strengthened, not weakened.

## Summary of the change

The reaper's merged-check used `git cherry` (patch-id equivalence) ONLY, which the code
itself documents cannot detect MULTI-commit squash-merges — the disk-accumulation root
cause (squash-merged worktrees kept forever; ~118GB/290 observed). Added a SECOND,
conservative signal: `fetchMergedPrHeadOids()` does ONE `gh pr list --state merged`
call per sweep (cached 60s) → a `headRefName→headRefOid` map; `isMerged` treats a
worktree as merged only when its branch has a merged PR whose head OID EXACTLY matches
the worktree HEAD. Files: `agentWorktreeGit.ts` (the fetcher + the cached map + the
enhanced `isMerged`), `AgentWorktreeReaper.ts` (config field `githubMergeCheck`,
default true), `types.ts` (config type), `server.ts` (plumb the flag),
`PostUpdateMigrator.ts` (awareness). Tests: 9 new (`fetchMergedPrHeadOids` parse/fail-safe,
`isMerged` PR-map both sides + oid-mismatch keep + disabled-no-call).

## 1. Over-block (over-KEEP)

Possible: a genuinely-merged worktree is still KEPT (e.g. gh offline, PR list older than
`--limit 500`, branch renamed). This is the SAFE direction — a kept worktree wastes disk
but loses nothing. Fully acceptable; it is exactly today's behavior on any gh failure.

## 2. Under-block (the deletion-safety risk — the one that matters)

The hard rule is NEVER delete unmerged work. The new signal can only ADD a "merged"
verdict, so the question is: can it false-positive? Guards: (a) it requires an actual
MERGED PR for the branch (authoritative — the content is in main); (b) it requires the
worktree HEAD to EXACTLY equal the PR's merged head OID, so a branch with commits added
AFTER the merge (unmerged work on top) is KEPT (tested); (c) the upstream `isClean` gate
still independently blocks any uncommitted/untracked changes; (d) fail-safe to cherry-only
on any gh error. A reused branch name resolves to the NEWEST merged PR, and the exact-OID
match still gates deletion. Both sides tested.

## 3. Level-of-abstraction fit

Correct layer — the change lives entirely in the deps factory (`makeAgentWorktreeReaperDeps`);
the pure classifier (`AgentWorktreeReaper.evaluate`) is untouched and stays fake-testable.
The gh call is lazy (only when `git cherry` says unmerged) and cached (one call per sweep).

## 4. Signal vs authority compliance

The merged-PR map is a SIGNAL consumed by the existing deterministic reaper gate-chain;
it has no block/allow surface of its own. It can only contribute a conservative "merged"
input, which the existing in-use/clean/blast-radius/breaker gates still sit in front of.

## 5. Interactions

- **`isClean` ordering:** unchanged — `isMerged` (now with the gh path) is still only
  reached AFTER the cheap protect-gates (in-use, dirty) clear, so no extra gh calls on
  dirty/active worktrees.
- **Caching:** 60s TTL map + the existing 10s cwd cache — one sweep = one gh call.
- **Blast radius:** unchanged `maxReapsPerPass` (default 20) still caps deletions/sweep.
- **Breaker:** unchanged per-path removal-failure breaker still applies.

## 6. External surfaces

- **New external call:** `gh pr list` (read-only) against the repo's GitHub. Requires gh
  installed + authed; absent → fail-safe KEEP. No write, no new credential (uses the
  ambient gh auth). Off-switch: `agentWorktreeReaper.githubMergeCheck: false`.
- No new route, no user-facing message, no config migration required (the field defaults
  true via `?? true`, so existing agents get the behavior on the dist update).

## 7. Rollback

Pure code + one config flag. `githubMergeCheck: false` restores cherry-only at runtime;
reverting the commit removes the path entirely. The reaper's OFF+dry-run default means no
agent reaps anything until explicitly enabled and reviewed.
