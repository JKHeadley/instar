# Side-Effects Review — Accept all waits longer for a confirmation and stops later

**Version / slug:** `accept-all-page-patience`
**Date:** `2026-11-19`
**Author:** `Echo (topic 144007, Accept all round 4, part 5)`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1: one dashboard file plus its unit test. A revert undoes it; there is no server, state or migration change.

Live evidence. On 1.3.1908-local.6045422 (PRs 3360, 3448, 3476 and 3481), Accept all ran 04:58-05:36Z and accepted 5 more projects (11 of 20 overall). It then stopped at "Stopped at 10 of 14: your agent is not answering right now. 5 of 14 accepted." Several projects moved on without "Done.": each change was saved, but the M5 took more than 60 s to confirm it. One page sequence was "Saved here. Waiting for Mac M5 Pro to confirm. (33 s)", and projects took about 5 minutes each. Continue resumed those projects from where they stopped, e.g. "Context Budget: Layered Summaries. Naming it…".

Cause. `acceptSuggestion` waits `wait = 60000` per change; after that the project counts as `waiting`. The Accept all loop stopped after 2 waiting projects in a row. With a busy Studio, confirmations of 1-2 minutes are normal, so a working run stopped and needed Continue again and again.

Fix:
- `ACCEPT_CHANGE_CONFIRM_WAIT_MS = 150000` is the default `wait`.
- `ACCEPT_ALL_STOP_AFTER_WAITING = 3`.
- The stop rule moves into the pure, exported `acceptAllStep(waits, out)` so it can be tested. The loop's behaviour is otherwise unchanged: a finished or refused project resets the count, a locked one stops with the unlock words, and the words of the stop and end messages are unchanged.

## Decision-point inventory

- Accept all stop rule — modify — 3 waiting projects in a row instead of 2.
- Per-change confirmation wait — modify — 150 s instead of 60 s.

## 1. Over-block

None.

## 2. Under-block

When the other machine truly is not confirming, Accept all now takes longer to stop: up to 3 projects x 150 s per change, instead of 2 x 60 s. The page shows the live "Saved here. Waiting for <machine> to confirm. (N s)" words the whole time, so the person can see what it is waiting for.

## 3. Level-of-abstraction fit

The page owns how long it waits. The server's confirmation pipeline is unchanged.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface (client-side patience only).

## 5. Interactions

A long wait can now outlast the 15-minute PIN unlock in the middle of a project. That path already exists: the request answers `needsUnlock`, the project returns `locked`, and the page says "Stopped at N of M. Unlock again, then tap Continue." and opens the PIN box. Before each project the page still requires 5 minutes of unlock (`STEP_NEEDS_MS`).

## 6. External surfaces

Operator surface only: the Suggested groups page. No server or wire change.

## 6b. Operator-surface quality

- What the operator sees is unchanged in wording: "Accepting N of M: <project>. <step> Saved here. Waiting for <machine> to confirm. (N s)", "Stopped at N of M: … Tap Continue to try again; nothing is lost.", "N of M projects accepted. … Tap Continue to try again."
- The visible change is fewer stops: a slow confirmation shows its waiting line for up to 2.5 minutes and the run carries on.
- Phone and desktop render the same text (no layout change).

## 7. Multi-machine posture

Machine-local by design (browser-side).

## 8. Rollback cost

Revert and install.

## Evidence

- `tests/unit/console-conversation-suggestions.test.ts`, new "Accept all patience" cases:
  - With no `wait` given, a change that never confirms polls for at least 150 s (and under 160 s) before the project counts as waiting.
  - `acceptAllStep` stops only at the 3rd consecutive waiting project, and resets on a finished or refused one.
  - Both fail on main (the exports do not exist there).
- The file passes 15/15.

## Addendum (2026-11-18 23:02 PST): two page tests that still described the old stop rule

The first Local Verify run of this change (head fe212172d, Studio, 06:59Z) failed on two tests in `tests/unit/console-conversations-dom.test.ts` that still expected the old behaviour (a 60-second wait and a stop after two still-waiting projects). They were not in the first commit's test run, which is the gap. Both now describe the new behaviour: at 151 seconds the second project is running and Accept all has not stopped; with two projects in a row unanswered the run ends and says two did not finish; a new third test shows three in a row unanswered stopping the run at 4 of 5 with project 5 not tried. No source change in this addendum.
