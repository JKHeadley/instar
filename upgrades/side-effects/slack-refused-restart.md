# Side-Effects Review — refused Slack restart keeps the message and tells the person

**Version / slug:** `slack-refused-restart`
**Date:** `2026-11-06`
**Author:** `echo`
**Second-pass reviewer:** independent general-purpose reviewer agent (three rounds, concurred)

## Summary of the change

Tier 1: a revert fully undoes it, and a leftover state file is inert. About 800 lines across 6 source, test and note files, most of it the new module and its tests; about 66 lines of server code moved. Three independent review rounds: 8 issues, then 4, then none in the code. All fixed. That is more than the usual one round on a Tier 1 change because each round found real defects in message handling.

A refused Slack dispatch was dropped by the live caller. Now `repairSlackReplyRelayIfStale` runs before both spawn checks, and `SlackRefusedHold` keeps a retryable refusal and retries it on a fixed 6-step schedule. The person is told at once and the operator after 3 failed tries.

## Decision-point inventory

- Relay readiness gate — modify — a safe repair runs first; the gate is unchanged, and now runs before the resume entry is used.
- Is a refusal retryable — add — each dispatch refusal site marks itself; unmarked refusals (memory privacy, a rejected sender) are already explained and not held.
- Give up — add — after 6 tries, fixed schedule.

## 1. Over-block

Nothing new is blocked. The readiness gate refuses less often, because a stale shipped relay is repaired.

## 2. Under-block

A hand-edited relay keeps refusing every new conversation; each is held, told and given up on, and the operator is told. Nothing repairs it, deliberately. A message delivered to a session that never answers belongs to the standby and stall paths. A machine lost during the hold loses the messages. An all-session emergency stop (from Slack or the app) drops what is held and tells those people; a retry already in flight at that moment still finishes. A one-topic Telegram stop leaves the hold alone. A message refused after a stop is a new person's act and is held.

## 3. Level-of-abstraction fit

The hold consumes dispatch's outcome at its callers rather than sitting inside dispatch. The app route reports refusals its own way and calls dispatch directly, so it is unaffected. The repair reuses the installer's provenance rules rather than adding a second rewriting path. The pool routing block moved into a named function, unchanged except that its three bare returns now state an outcome, so a retry and a new message share one path.

## 4. Signal vs authority compliance

The hold has no blocking authority. It re-offers a message to the existing routing and dispatch, whose checks all stay in force. The repair writes only what the post-update migration would.

## 5. Interactions

A retry passes routing, memory privacy, spawn admission and the context latch again, as a new message does. It uses a fresh message id, because the router dedupes on id. The sentinel classification is not repeated: it ran on the first pass. A retry may spawn a session; the self-action registry bounds it (`slack-refused-hold-retry`, 6 per conversation). A newer message that gets through flushes held ones straight after, so an older message can arrive after a newer one and may already be in the history that session read. The retried text carries when it was sent and asks the session to check first; a double answer remains possible, and is better than none. The fixed notices go through `sendToChannel`, as the standby's do. `#2760` (open) edits nearby server code and may conflict textually.

## 6. External surfaces

Four new fixed messages to people, one to operators. New state file `state/slack-refused-hold.json` holding message text and its metadata at mode 600, only while waiting. The relay may be rewritten at spawn time rather than only after an update, in the same files, with the same backup.

## 7. Multi-machine posture

Machine-local by design: the machine that took the message from Slack holds it, and a retry goes back through pool routing, so a conversation that moved is answered by its owner. Notices come from that one machine, so one voice holds. The forwarded-owner path holds on the owner; `markRemoteInjected` fires as it did for a refusal before this change.

## 8. Rollback cost

Revert and release. A leftover state file is ignored, so held messages in it are not answered, though the person was told it was kept. Acceptable for a rollback.

## Second-pass review

Round 1: concern raised, 8 issues (retry bypassing routing, boot race, spawn after emergency stop, double answer and reordering, lost resume, repeated notices, missed threads, first-pass throw lost). Round 2: routing, boot, notices, threads and throw confirmed closed; 4 more: a one-topic Telegram stop cleared every hold with no notice, the app's stop did not reach it, a tick in flight survived a stop, and the resume entry was lost on later refusals. All four fixed, with tests. The double-answer risk is reduced by a sent-at note, not removed, as stated in section 5. Round 3: all four fixes verified; only two artifact wording corrections, made. Concur.

## Class-Closure Declaration

`unbounded-self-action` — closure: guard, enforcement: ratchet, citation: `tests/unit/self-action-convergence.test.ts`. The retry is registered as `slack-refused-hold-retry`: a fixed schedule of 6 tries per conversation, then the messages are dropped and the person is asked to resend. Attempts persist across restarts, and only a new message from a person adds to the hold.
