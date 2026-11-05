<!-- bump: patch -->

## What Changed

Instar's git safety funnel kept two lists of allowed commands, one for commands that change things and one for commands that only read. A command on neither list was refused twice, and each refusal told the caller to use the other route. `git check-ignore` was one of them. There is now one table and one classifier for every entry point. `check-ignore` is allowed as a read, including on Instar's own source tree when a caller opts in. A command outside the table gets a single clear refusal that says it is not classified. Non-read `reflog` forms now route correctly through the funnel's dispatcher.

## What to Tell Your User

Nothing changes for you. This is an internal safety cleanup in how Instar runs git.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Internal code can ask whether a file is git-ignored through the safety funnel | automatic, for code that calls the funnel |

## Evidence

New test file `tests/unit/SafeGitExecutor-verb-classifier.test.ts` drives real git through every entry point in sandbox repositories and a source-tree fixture. Before the fix, 14 of its 16 tests failed, with `check-ignore` refused as a "destructive verb" and an unclassified verb producing four different messages.
