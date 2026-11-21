<!-- bump: patch -->
## What Changed

The console's Settings → Context page now has a "Practice folds" section. It shows how many practice runs have been graded of the 40 needed, what share of quiz answers would have been lost, whether any run would have lost the operator's own words or a decision, and why other attempts didn't run, all in plain words. Switched off, it says so in one line.

## What to Tell Your User

On the dashboard's Context settings page you can now see how the context budget's practice runs are going: how many have run, how much they would have forgotten, and why some were skipped.

## Summary of New Capabilities

- A "Practice folds" section on console Settings → Context, read from `GET /context-budget/fold-shadow`.

## Evidence

- Unit: `tests/unit/console-context.test.ts` (+6) covers off, absent, failed, unreadable and ok; loss over 5% and a protected loss marked as needing a look; the exit reached; an empty record; an older server showing no section; the shipped page in jsdom (exact routes read, plain words with no codes, switched off in one line).
- All 127 console and dashboard test files pass (2,249 tests). Lint 54/54.
