<!-- bump: patch -->

## What Changed

The Chief of Staff's Work Board cards ("<project> is waiting on you") read better. Their text no longer shows backslashes before brackets, an internal "(wait c5c23e80)" code, or a raw "2026-11-17 22:15:31 UTC" time, and checklist lines read "- item (not checked yet)" instead of "item.: not known". Each such card also carries a new optional `brief` in the card read (`GET /work-board`, `GET /mobile/work-board`, the single-card read): `{ask, goal?, checks?: [{text, status: passes | needs-you | unknown | fails}], chiefSaid?, waitingSince?}`, all plain text, with `waitingSince` as an ISO time for the app to format. `ask` is one sentence of what the owner is asked, taken from the Chief of Staff's note when it names a decision. The brief is display only: it is not part of what an approval covers, and only the server writes it. Existing cards pick up the new text and brief at the next Chief of Staff check of their project.

## What to Tell Your User

The cards the Chief of Staff puts on your Work Board when a project waits on you are easier to read now: what it needs from you comes first in plain words, then the goal, each finish-line item with its state, what the Chief of Staff said, and since when it has been waiting, without the codes and odd characters.

## Summary of New Capabilities

| Capability | How to Use |
|---|---|
| Structured brief on Chief of Staff wait cards | Automatic; apps read `card.brief` from the Work Board card read and can lay the card out from it. |

## Evidence

Unit tests in `tests/unit/chief-of-staff-wait-cards.test.ts` compose the Engine Feature Optimization card from its live goal, checklist and note and check the exact brief and the clean text; they also check the brief leaves the approval hash unchanged, that only the server may write it, that an old-format card gets it once on its next check, and that a repeat wait on a finished card still reopens it. The Work Board service, cards-appear, my-board, wiring and closeout test files pass unchanged.
