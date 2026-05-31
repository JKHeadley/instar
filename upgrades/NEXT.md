# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**The stale-worktree cleanup robot can finally run.** The AgentWorktreeReaper
(shipped recently, off by default) finds CLI worktrees that are completely safe to
reclaim — their work is already merged into main, they have no uncommitted changes,
and nothing is using them — and removes the checkout to free disk and reduce macOS
indexing load. But it never worked in production: it lives inside the instar server,
whose working directory is itself a checkout of the instar source tree, so the
SourceTreeGuard (the safety wall that blocks risky git operations against instar's
own code) blocked every git call the reaper made. It silently reported "0 to clean
up" no matter what.

Two fixes: (1) the merged-detection command (`git cherry`) wasn't even recognized as
a read-only command, so it failed instantly and the reaper treated every worktree as
"not merged → keep" — that's the real reason it always said zero; (2) the
source-tree safety wall now recognizes exactly the four operations the reaper needs
— list worktrees, check-clean, check-merged, and remove — and nothing more. The one
operation that deletes a worktree is allowed only in its safe form, which refuses to
touch a worktree with uncommitted changes; the forced variant that could delete
unsaved work stays blocked.

## What to Tell Your User

Nothing to configure. The worktree-cleanup feature stays off by default. If you turn
it on, it can now actually find and reclaim the worktrees that are safe to remove,
instead of always reporting zero. It can never delete a worktree that has unsaved
changes or that something is currently using — those are always kept.

## Summary of New Capabilities

- The AgentWorktreeReaper's git calls (list, status, cherry, non-forced remove) now
  pass the SourceTreeGuard against the agent's own instar checkout, so it reports a
  real reclaimable count and can reclaim when enabled.
- The merged-detection command is recognized as read-only, fixing the silent
  always-zero behavior.
- The forced delete variant remains blocked against the source tree — the reaper can
  never destroy a dirty or in-use worktree.

## Evidence

- `tests/unit/SafeGitExecutor-sourceTreeReadOk.test.ts` — new cases: status / cherry
  / worktree-list blocked-by-default and allowed-with-flag; non-forced worktree
  remove actually removes; `worktree remove --force` and `-f` STILL blocked even
  with the flag; the read flag does not grant remove authority.
- `tests/unit/agent-worktree-reaper.test.ts` — new real-git integration block: the
  real reaper deps against a repo promoted to an instar source tree, with real
  merged / dirty / unmerged worktrees — list, isClean, isMerged, and removeWorktree
  all work through the guard; end-to-end the reaper reaps the merged+clean worktree
  and keeps the dirty and unmerged ones. This is the test the original fake-git suite
  lacked, which is why the bug shipped.
- Live verification: `GET /worktrees/agent-reaper` reports a non-zero reclaimable
  count on echo instead of 0.
- Side-effects: `upgrades/side-effects/source-tree-guard-reaper-readtier.md`.
