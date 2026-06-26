# Squash-merge-aware worktree reaper — ELI16 overview

## The problem in plain words

When the agent works on a change, it makes a "worktree" — a full copy of the codebase
in its own folder — so different jobs don't trip over each other. Each one is hundreds
of megabytes. After the change is merged and shipped, that folder is dead weight: the
work is safely in the main branch, so the copy can be deleted.

A background cleaner (the "reaper") is supposed to delete those finished folders. But it
had a blind spot. To decide "is this branch's work already in main?", it compared the
branch's commits to main commit-by-commit (using a git trick called patch-id). That
works when a branch is merged normally — but this project **squash-merges**: it mashes
all of a branch's commits into ONE new commit on main. That single squashed commit has a
different fingerprint than the original commits, so the reaper couldn't recognize the
work as merged. It played it safe and **kept the folder forever**.

Result: merged-but-unrecognized folders piled up — on this machine, hundreds of them,
over 100 GB of disk. That bloat is part of what made the machine slow and, eventually,
contributed to a crash.

## What this change does

The reaper now has a second way to tell a branch is merged: it asks GitHub. Once per
cleanup sweep it fetches the list of **merged pull requests** and the exact commit each
one merged. If a folder's branch has a merged PR, AND the folder is sitting on exactly
that same commit, the reaper knows the work is in main and the folder is safe to delete.

Two safety rules make this trustworthy:
- **Exact-commit match.** If you added new commits to the branch AFTER its PR merged,
  the folder's commit won't match the merged one, so it's still KEPT — new work is never
  thrown away.
- **Fail-safe.** If GitHub can't be reached (offline, not logged in, not a GitHub repo),
  the reaper simply falls back to the old commit-by-commit check and keeps the folder.
  It never deletes on a guess.

It's still off by default and runs in dry-run first (it tells you what it WOULD delete
before it deletes anything), and there's an off-switch (`githubMergeCheck: false`) to
turn off the GitHub call entirely. The GitHub lookup is just ONE call per sweep, cached,
so it's cheap.

The net effect: when you turn the reaper on, it can finally reclaim the squash-merged
folders that were stuck forever — recovering the disk that was quietly disappearing.
