# Topic-bound sessions start again on an agent whose home is an instar checkout

## What Changed

- `WorktreeManager.createBinding` no longer runs `git branch` (or the clone path) against a project that is itself an instar source checkout. SourceTreeGuard refused that step, so every topic-bound `POST /sessions/spawn` on such an agent failed and the session could not be bound to its Telegram topic. It now creates the branch and the worktree in one `git worktree add` (the shape the guard's existing worktree-manager carve-out admits), basing a new branch on `origin/main` (HEAD when there is no `origin/main`) and reusing an existing topic branch. The guard is unchanged.
- The two reads on that path (adopting an existing worktree directory, and reading `core.hooksPath` to seed git hooks) now pass the same carve-out flag, so they no longer fail silently against an instar checkout; worktrees there get the commit/push hooks.

## What to Tell Your User

Nothing for ordinary agents. For an agent that develops instar itself: sessions started for a conversation work again and reply in that conversation.

## Summary of New Capabilities

- None; a fix.

## Evidence

New unit test (`tests/unit/WorktreeManager-instar-source-tree.test.ts`): on the old code all three spawn cases fail with `SourceTreeGuardError`; with the fix 4/4 pass, and a plain `git branch` on the same fixture is still refused. Live check against the real agent home: worktree created on `topic/<id>-live-check` at origin/main with `core.hooksPath` set, then removed.
