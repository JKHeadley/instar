# Claude Code worktrees work again in Instar sessions

## What Changed

- The event reporter is no longer registered on Claude Code's WorktreeCreate and WorktreeRemove hooks. A hook on those events replaces Claude Code's own worktree creation and must print the worktree path; the reporter printed nothing, so creating a worktree failed in every Instar session. A settings migration removes the entries from existing agents and keeps any other hook on those events.

## What to Tell Your User

If you or I ever tried to start work in a separate working copy and it failed, that is fixed after this update. Nothing to do.

## Summary of New Capabilities

- None; a fix for a broken Claude Code feature.

## Evidence

Reproduced on Claude Code 2.1.310: with a silent hook on WorktreeCreate, worktree creation failed with "hook succeeded but returned no worktree path"; without it, it succeeded. New migration tests run the real settings chain.
