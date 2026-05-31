---
title: SourceTreeGuard read-tier + worktree-remove allowance for the AgentWorktreeReaper
slug: source-tree-guard-reaper-readtier
status: approved
review-convergence: 2026-05-31T03:20:00+00:00
approved: true
author: echo
approval-note: >
  Self-approved by Echo under the delegated deploy mandate. Justin explicitly
  authorized this exact change in Telegram topic 16782 (2026-05-31): "yes, both"
  — approving both (1) reclaiming the stale worktrees now and (2) the proper
  SourceTreeGuard reaper-fix. This PR is item (2). Flagged in the PR per
  cross-agent discipline; it is a safety-guard change, so the side-effects
  review below is deliberately exhaustive about the new surface.
---

# SourceTreeGuard read-tier + worktree-remove allowance for the AgentWorktreeReaper

## Problem

The AgentWorktreeReaper (shipped v1.3.133, #589) reclaims merged + clean +
not-in-use CLI worktrees under `~/.instar/agents/<agent>/.worktrees/`. It runs
inside the instar server, and the agent home **is itself a checkout of the instar
source tree**. Every git call the reaper makes therefore hits the SourceTreeGuard
(via `SafeGitExecutor`), which blocks destructive operations against the source
tree as a defense against the 2026-04-22 incident class.

The reaper needs four git operations, ALL of which the guard blocked:

1. `git worktree list --porcelain` — enumerate worktrees (read).
2. `git status --porcelain` — per-worktree cleanliness (read).
3. `git cherry <base> <sha>` — merged-detection via patch-id equivalence (read).
4. `git worktree remove <path>` — reclaim a worktree (mutation, non-forced).

Two distinct failures stacked:

- **`cherry` was an *unknown* verb to `readSync`** — not in `READONLY_GIT_VERBS` —
  so `readSync` rejected it as "destructive verb 'cherry'" before the source-tree
  check even ran. The reaper's `isBranchMerged` caught the throw and returned
  "unmerged" (KEEP), so **nothing was ever detected as merged** → the reaper
  reported 0 reclaimable in production regardless of reality.
- The source-tree bypass allowlists were too narrow: `SOURCE_TREE_READ_TIER_VERBS`
  didn't include `status`/`cherry`, and the worktree-manager invocation allowlist
  (`sourceTreeWorktreeManagerOk`) permitted only `add`/`prune`, not `list`/`remove`.
- The reaper's own git wrapper didn't pass the bypass flags at all.

## What's new

Three precise, minimal widenings — each shape-checked, none broadening the guard
for arbitrary callers:

1. **`cherry` added to `READONLY_GIT_VERBS`.** `git cherry` lists `+`/`-`
   patch-equivalence lines vs an upstream; it never mutates. This makes `readSync`
   accept it (the actual root cause of the silent 0-reclaim).
2. **`status` + `cherry` added to `SOURCE_TREE_READ_TIER_VERBS`.** Both are pure
   reads, gated by the existing `sourceTreeReadOk` opt. This set is already the
   documented home for "read-tier verbs the watchdog/reconciler need against the
   source tree." The bounded-size test still holds (≤10).
3. **Worktree-manager allowlist extended** (`isAllowedWorktreeManagerSubcommand`,
   gated by `sourceTreeWorktreeManagerOk`): in addition to `add`/`prune`, allow
   `list` (read) and `remove` — but **`remove` only in its non-forced form**.
   `git worktree remove` without `--force` refuses to delete a worktree with
   uncommitted changes or a lock, so it cannot destroy in-flight work. `--force`
   / `-f` is explicitly denied and still trips the guard.

The reaper's git wrapper (`agentWorktreeGit.ts`) now passes `sourceTreeReadOk`
+ `sourceTreeWorktreeManagerOk` on its reads and `sourceTreeWorktreeManagerOk`
on the non-forced `worktree remove`.

## Safeguards (why this is safe)

- **`readSync` rejects any destructive shape regardless of flags**, so widening the
  source-tree bypass on the read path cannot enable a mutation there.
- **`--force` remains blocked** even with the flag — the one form of
  `worktree remove` that could destroy uncommitted work. The reaper never passes it.
- **The reaper's safety gates are unchanged**: it still only removes worktrees that
  are merged AND clean AND not-in-use, and ships dark + dry-run by default.
- **No new authority** — these are signals/reads plus one narrowly-shaped,
  self-protecting mutation. Nothing here holds blocking authority over a message.

## Testing

- Unit (`SafeGitExecutor-sourceTreeReadOk.test.ts`): status/cherry/worktree-list
  blocked-by-default + allowed-with-flag; worktree remove (non-forced) actually
  removes; `worktree remove --force`/`-f` STILL blocked even with the flag; the
  read flag does NOT grant remove authority; closed-set membership for status/cherry.
- Integration (`agent-worktree-reaper.test.ts`): the **real** `makeAgentWorktreeReaperDeps`
  (real `SafeGitExecutor`, real git) against a repo promoted to an instar source
  tree with real merged/dirty/unmerged worktrees — list + isClean + isMerged +
  removeWorktree all work through the guard; end-to-end the reaper reaps the
  merged+clean one and keeps dirty + unmerged. This is the test the original
  (fake-git) suite lacked, which is exactly why the bug shipped.
- Live: deploy to echo, then `GET /worktrees/agent-reaper` reports non-zero
  reclaimable instead of 0.

## Rollback

Pure source change. Revert the commit → the reaper reverts to reporting 0
(blocked) and the manual `git worktree remove` path (used for the immediate
reclaim) is unaffected. No config, no migration, no agent-installed files.
