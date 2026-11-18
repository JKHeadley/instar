# Side-Effects Review — Accept all projects: progress beside the button, goes past a stuck project, never greyed out without words

**Version / slug:** `accept-all-progress`
**Date:** `2026-11-16`
**Author:** `Echo`
**Second-pass reviewer:** `not required (dashboard wording and loop behaviour on one view; no gate, sentinel or session lifecycle)`

## Summary of the change
Justin (topic 141385, 2026-11-16 16:24 PST) tapped "Accept all 21 projects" on Conversations → Review suggestions. The button stayed greyed out with no progress or waiting text and the list did not change: "Either this is frozen or we have really bad UX for this process."

What the tap did (read from the Studio's graph state, look-only): project 1 resumed its earlier Accept, and its "move the conversation in" change was certified at 16:23:37 but never reached "committed" (a server fault, fixed separately under `graph-certified-delivery-resume`). The page polled that change for 60 s. The only progress words were inside project 1's card, which sits below eight non-project cards, so nothing was visible beside the button. After 60 s the old code would have stopped at project 1 and never tried the other twenty.

Fix (Tier 1, 1 source file `dashboard/console/conversation-suggestions.js`, about 60 LOC):
- A status line under the Accept-all button: "Accepting N of M: <title>. <step>".
- `runChange` reports each re-check (`onWait`); after 5 s the step words add what it is waiting for and the seconds waited. A request the agent did not answer (status 0) says so instead of "Saved here".
- Every stop carries a kind (`locked`, `waiting`, `refused`, `retry`). Accept all continues past a project that stopped, stops after two `waiting` stops in a row, and stops at once on `locked` (and opens Unlock).
- The Accept-all handler and the card's `run()` catch page errors; the button always returns as "Continue accepting projects" with a line.
- Step words added for the two silent stretches: "Checking where its conversation is…" and "Finishing…"; a card says "Starting…" at once.

Effort: 1 commit attempt, no spec rounds (Tier 1). In line with the size.

## Decision-point inventory
None. The page decides only which project to try next; every change still goes through the same owner pipeline.

## 1. Over-block
Accept all now stops after two projects in a row end "still waiting". If only those two were slow and the rest would have gone through, the owner taps Continue once more. Acceptable: the line says why, and each wait is 60 s, so going on blindly could mean 20 minutes of waiting.

## 2. Under-block
The page still cannot make a change commit; when the machines do not confirm, the owner sees the reason and a retry, not a result. A project skipped past is retried only when the owner taps Continue.

## 3. Level-of-abstraction fit
Wording and loop control live in the view that owns the button. The reasons shown are the ones the server already returns (`waitingMachines`, `subject-change-pending`); no new server field.

## 4. Signal vs authority compliance
No authority. The page reports; the owner pipeline decides.

## 5. Interactions
The refresh hold from `suggestions-accept-refresh` (data-interaction-open while a card runs) is unchanged. The lock watcher still clears private content on PIN expiry; Accept all then shows "Unlock again, then tap Continue." Continuing past a stopped project relies on the existing step 0, which creates nothing for a project whose conversation is already placed.

## 6. External surfaces / 6b. Operator surface
Dashboard Conversations → Review suggestions only. New on-screen words listed in the summary. Checked at 390x844 and 1280x728.

## 7. Multi-machine posture
Client-side only. Progress still resumes across tabs and machines through the server's per-suggestion create request id; the waiting words name the machine the server reports.

## 8. Rollback cost
Revert the commit; the next release restores the old silent button.

## Evidence
`npx vitest run tests/unit/console-conversations-dom.test.ts tests/unit/console-conversation-suggestions.test.ts` — see the PR for the run; the new tests fail with the source change removed.
