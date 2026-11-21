<!-- bump: patch -->
## What Changed

"What I'm allowed to do": the need-a-look list counts only checks (unanswered machines move to "Machines I couldn't check", named from the pool), setting names read as words with acronyms kept ("Green PR auto merge"), and row titles drop dated incident tags (the full text stays in the check's detail). Overview: `docs/specs/allowed-checks-plain.eli16.md`.

## What to Tell Your User

The safety checks page now adds up (the number at the top matches the list) and its names read as plain words.

## Summary of New Capabilities

- None (wording and grouping only).

## Evidence

- Unit: `tests/unit/console-allowed.test.ts`. Live page verified through a proxy serving this branch.
