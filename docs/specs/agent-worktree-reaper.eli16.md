# ELI16 — AgentWorktreeReaper (reclaim stale worktrees)

## What this is, in plain English

When instar does parallel development it makes "worktrees" — extra full copies of
the project's code in a folder. They pile up and never get cleaned. On the dev
machine there were over 120 of them, eating tens of gigabytes of disk and giving
macOS's background indexer a huge amount of stuff to keep scanning.

This change adds a careful janitor that can clean up the OLD, FINISHED ones.

## What already exists

There is already a different worktree-cleaner, but it only knows about a separate,
tracked kind of worktree. The plain ones made by the `instar worktree create`
command had no cleaner at all — so they just accumulated forever.

## What's new

A new cleaner, the AgentWorktreeReaper, that looks at each worktree and only ever
removes one when ALL of these are true:
- nobody is actively using it (no lock, and no running program is "sitting inside"
  that folder),
- it has no unsaved changes (nothing you'd lose), and
- its branch's work is already merged into the main code (so deleting the copy
  loses nothing — the branch and its saved history stay; it even detects simple
  "squash" merges where the history looks different but the content is in main).

If there is any doubt about any one of these, it keeps the worktree. (We tried
also requiring "untouched for two weeks," but it turned out useless here: the team
ships so fast that every branch gets refreshed against the latest code constantly,
so the dates always look recent. "Is anyone using it right now" is the signal that
actually matters.) It can only delete a few per run (a safety cap), and the actual
deletion goes through instar's single safe-delete pipeline that logs everything.

## The safeguards, in plain terms

- It ships **turned off**, and even when "on" it starts in **dry-run** — meaning it
  only makes a list of what it WOULD remove, and deletes nothing, until you look at
  that list and decide.
- It will never, ever remove a worktree with unsaved work or unmerged commits.
- Its merged-check is deliberately cautious: when unsure, it assumes NOT merged and
  keeps the worktree.
- There is a read-only report you can pull up that shows every worktree and the
  exact reason it's being kept or could be reclaimed.

## What you actually need to decide

First, just look at the report (it costs nothing and deletes nothing) to see how
much could be reclaimed. Then decide whether to turn the janitor on to keep the
pile from growing back. Nothing happens to your worktrees until you choose to.
