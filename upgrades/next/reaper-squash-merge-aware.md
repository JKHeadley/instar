---
user_announcement:
  - audience: agent-only
    maturity: stable
    summary: "The worktree reaper now recognizes squash-merged branches (via GitHub merged-PR state) so merged worktrees stop accumulating and can finally be reclaimed."
---

## What Changed

Fixed the disk-accumulation root cause in the **AgentWorktreeReaper**: its merged-check
used `git cherry` (patch-id) only, which — as the code itself documents — cannot detect a
MULTI-commit branch that was SQUASH-merged (the squashed commit's SHA/patch-id differs
from the originals). Since this project squash-merges every PR, merged worktrees were kept
forever and piled up (~118GB / 290 worktrees observed on one machine), contributing to the
2026-06-26 resource-exhaustion kernel panic.

The reaper now ALSO consults GitHub merged-PR state — one `gh pr list --state merged` call
per sweep (cached) building a `branch → merged-head-OID` map — and treats a worktree as
merged when its branch has a merged PR whose head commit EXACTLY matches the worktree's
HEAD. A branch with commits added AFTER the merge is still KEPT (unmerged work is never
deleted), and any `gh` failure fails safe to the legacy cherry-only behavior (KEEP).

Config: `monitoring.agentWorktreeReaper.githubMergeCheck` (default `true`; set `false` to
disable the GitHub call). The reaper still ships OFF + dry-run by default.

## Evidence

**Reproduction / observed before:** On the affected machine, `git worktree list` showed
~290 worktrees totalling ~118GB. The 28730 diagnostic session manually verified ~30 of
the worktrees the reaper was KEEPING against GitHub and found their branches had MERGED
PRs (e.g. #1041, #577, #1209) — i.e. the content was already in `main` — yet `git cherry`
reported them unmerged (multi-commit branches squash-merged into one commit have
different SHAs/patch-ids), so the reaper's verdict was `unmerged` → KEEP, forever. It
manually reclaimed 27 of them (~5GB freed) only by checking GitHub by hand.

**Observed after (this fix):** `isMerged` now returns `true` for exactly that case — a
multi-commit squash-merged branch whose merged-PR head OID matches the worktree HEAD —
so the reaper classifies them `reap-eligible` instead of keeping them. Unit tests pin
both sides: the squash-merge-via-PR-map case returns merged; a branch advanced past its
merge (OID mismatch) is still KEPT; gh-unavailable falls back to cherry-only (KEEP). The
real-git end-to-end test ("reaps merged+clean, keeps dirty+unmerged") exercises the live
deps and degrades safely when gh can't resolve the test repo.

## What to Tell Your User

If a user asks "why is my disk full of merged worktrees that never get cleaned?" — the
reaper couldn't tell squash-merged branches were merged, so it kept them; this fix lets it
recognize them (by checking GitHub for the merged PR) and reclaim the disk once the reaper
is enabled. If they ask "why is the reaper calling GitHub?" — that's the squash-merge
detection (one read-only call per sweep, off-switchable, fail-safe).

## Summary of New Capabilities

- The worktree reaper detects multi-commit squash-merges via GitHub merged-PR state.
- Exact head-OID match guarantees branches with post-merge commits are still kept.
- Fail-safe to cherry-only on any `gh` error; one cached `gh` call per sweep.
- New off-switch `monitoring.agentWorktreeReaper.githubMergeCheck` (default on).
