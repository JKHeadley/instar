# ELI16 — Why your worktrees pile up to 118 GB, and the one-line-ish fix

## What this is about

When the agent builds a fix, it makes a private copy of the codebase called a "worktree" so the work is isolated. There's a janitor (the **AgentWorktreeReaper**) whose job is to delete a worktree once its work has safely landed in the main codebase — the copy is then just wasted disk.

On the echo agent these worktrees grew to **290 copies / 118 GB**. That much disk makes a macOS background process (`fseventsd`, which watches files for changes) burn a lot of CPU — which then gets misread as "the agent is overloaded." So this is really a disk-cleanup bug wearing an "overload" costume.

## What's actually broken

The janitor refuses to delete a worktree if it looks "dirty" (has any uncommitted changes) — a good, safe rule. But its check is too crude: it treats **any** leftover file as "dirty," even files that are obviously not real work.

The worst offender: a tiny marker file called `.metadata_never_index` was dropped into every worktree (it tells macOS Spotlight "don't index me," to reduce load). Because that marker is an untracked file, the janitor sees it and thinks "this worktree has unsaved work — keep it forever." So **the file we added to reduce load is the very thing blocking the cleanup that reduces load.** Out of 290 worktrees, 246 are kept for this reason — but only 42 actually have real unsaved work.

## What already exists (so the fix is tiny)

The codebase already has a smarter "is this really dirty?" checker — `classifyPorcelain` — built for a different feature. It ignores known junk (build folders, logs) and only calls a worktree dirty if there's a *real* change. The janitor just isn't using it yet.

## The fix

Two small changes:
1. Point the janitor's "is it clean?" check at the existing smart checker instead of its crude one.
2. Add `.metadata_never_index` (and the agent's own audit-trace folder) to the known-junk list.

That's it. After this, a worktree whose only "changes" are junk markers — and whose real work already landed — becomes deletable. The 42 with genuine unsaved work stay protected (any real file, including a hand-written file you never saved to git, still counts as dirty → kept).

## Safety

- **Nothing with real work is deleted.** Any non-junk change keeps the worktree. The deletion itself uses git's safe mode that refuses to remove a worktree with uncommitted changes — a second seatbelt.
- **Deleting a worktree never loses code.** Once work has merged, the branch and its commits stay in git history; only the redundant on-disk copy goes.
- **Gradual + reversible.** The janitor keeps its existing limits (a cap per run, a dry-run mode, an on/off switch). The ~200 dead worktrees drain over many runs, each logged. You can review the dry-run list first and turn it off anytime.
- **One machine only.** Worktrees live on one disk; this only ever touches the machine's own copies. Nothing syncs across machines.
