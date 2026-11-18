<!-- bump: patch -->
## What Changed

The worktree monitor now keeps the first 50 changed-file names for each branch with unmerged work, plus a count of all of them, instead of the full list. Branches far behind main used to list every file main had changed since then. On one development machine the saved report grew to 314 MB and was rewritten every five minutes, stalling the server for about 0.7 seconds each time (fb-411b9b0c-6a6). The notice still shows five names and now takes its "+N more" from the count.

## What to Tell Your User

Nothing to do. A background check that could slow the agent's server on machines with many old work copies is now lightweight.

## Summary of New Capabilities

- The worktree monitor report stays small however far behind a branch is.

## Evidence

New unit tests in `tests/unit/worktree-monitor.test.ts` cover both sides of the cap. A branch with 65 changed files keeps 50 names and counts 65. A branch with 2 changed files keeps both. The file passes 35 of 35. Measurement behind the fix: the Studio's 314 MB report took 261 ms to stringify and 425 ms to write, in a separate process.
