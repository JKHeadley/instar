# ELI16 — The worktree cleanup double-checks right before it deletes

## What this is
Your agent creates temporary copies of the codebase (called "worktrees") when it builds things. A background cleaner ("the reaper") removes the ones that are finished — safely, only when a worktree's branch is already merged, has no unsaved changes, and nothing is using it.

## The bug
The cleaner works in two steps: first it looks at ALL the worktrees and writes down each one's branch, then a moment later it goes through and deletes the finished ones. The problem is the gap between those two steps. Tonight, a builder grabbed a "finished" worktree in that gap and started a NEW piece of work in it (switching it to a fresh, unmerged branch). But the cleaner was still going off its earlier note that said "this branch is merged" — so it deleted the worktree while a build was live inside it. Nothing was permanently lost, but it was a real race: the cleaner decided based on a stale snapshot.

## The fix
Right before the cleaner actually deletes a worktree, it now re-checks the LIVE state one more time — is it still on the same branch, still merged, still clean, still idle? If ANYTHING changed since the first look, it backs off and keeps the worktree. A builder can also drop a little "I'm using this" marker file to be extra sure the cleaner leaves it alone.

## The safeguards, plainly
This change can only ever make the cleaner MORE careful — it can skip a deletion it would have done, but it can never delete something it wouldn't have. Every "I'm not sure" answer means "keep it, don't delete." There's no new setting and no switch to flip; it's always on. If you ever saw the cleaner remove a worktree mid-build, that can't happen this way anymore.

## What you need to decide
Nothing. It ships with the release and only makes the existing cleanup safer.
