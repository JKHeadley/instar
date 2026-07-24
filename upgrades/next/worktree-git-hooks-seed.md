# Fresh worktrees seed their git-hooks shim (commit/push gates run from the first commit)

## What Changed

`WorktreeManager` creates an isolated dev checkout (`git worktree add`, or `git clone` when the source is outside agent home) and fast-copies `node_modules` — but it never regenerated husky's git-ignored `.husky/_` shim. Since `core.hooksPath = .husky/_` points at that shim, a fresh checkout had the tracked `pre-commit`/`pre-push` hook files but not the directory git actually resolves the hooks to. Git then silently ran **no** hook (no error), so the instar-dev pre-commit/pre-push enforcement was bypassed in every fresh worktree until someone ran `npm install`.

A new best-effort `seedGitHooks(worktreePath)` step runs right after the create/clone: it resolves the effective `core.hooksPath`, and if it is a relative path present in the source but missing in the fresh checkout, copies the shim directory across (and, on the clone path where the fresh `.git/config` carries no hooksPath, replicates the hooksPath config). It is generic (never names husky), fails open (warns, never blocks worktree creation), is idempotent, path-contained, and a no-op for repos with no relative hooksPath or an absolute one.

## Evidence

- Empirically reproduced: a fresh `git worktree add HEAD` has `pre-commit`/`pre-push` but no `.husky/_` → git runs nothing; a live echo dev worktree was found with dead hooks.
- New regression test `tests/unit/WorktreeManager-git-hooks-seed.test.ts` (4 tests) exercises the real create path via the two-session harness: clone path (shim seeded + hooksPath replicated), worktree path (shim seeded, hooksPath inherited), and both no-op boundaries (non-husky repo, absolute hooksPath). Verified test-first: the clone + worktree tests fail without the fix, all 4 pass with it.
- Existing worktree suites (`WorktreeManager`, `InstarWorktreeManager`, `WorktreeManager-merkle` — 64 tests) pass unchanged; full `tsc` build clean.

## What to Tell Your User

Nothing changes in how you use your agent day to day — this is an internal reliability fix for instar development. If you run instar-dev / build worktrees, their local commit/push safety checks now actually run from the first commit instead of being silently skipped until a dependency install. There is no new command, setting, or user-visible behavior.

## Summary of New Capabilities

- Fresh dev worktrees/clones get their git-hooks shim seeded automatically, so the instar-dev pre-commit/pre-push gates are live immediately — no `npm install` required to activate them.
- No new API, config, or operator surface; the seeding is automatic, fail-open, and a no-op for repos that don't use a relative-path hooks framework.
