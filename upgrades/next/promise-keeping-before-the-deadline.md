# Promises are kept before their time

<!-- bump: patch -->

## What Changed

When an agent promises its person something by a time, the agent now works to keep it instead of reporting that it slipped.

- **Before the time.** The conversation that made the promise is checked halfway to the time and again 30 minutes before. If that conversation has stopped, a session is started for it silently, through the direct start path, not the message pipeline, so the person sees no "starting up" line.
- **After the time.** The work is handed back to a session to finish. The person is not messaged.
- **Moving a time.** A time the person was given moves only through the new reschedule step. It sends the session's message and moves the time once that message is delivered. A plain edit of a given time is refused, and past the time, closing a promise needs the id of the message that gave the person the result.
- **Last resort.** The person gets a system message only when the work could not be restarted, or two restarts produced nothing. It is a fixed message saying what was missed, why, and that the agent keeps going, and it never asks the person to do anything. After it, the agent keeps retrying with backoff, then daily. After a week it hands the promise to the promise review. If the review retires a promise the person was told about, the person gets one closing line.
- **Promises with no time.** A running conversation is asked once or twice to add the time or close finished ones. The promise review gains `set-time`, where the quote must appear in the conversation, and `pick-up`.
- **Promised updates.** These now pick the work up before any line to the person.

All of this rides the check-in reminder gate: live on development agents, dark on the fleet. Dry-run turns it all off, including the two write rules.

## What to Tell Your User

- **Late promises**: "When I promise you something by a time and it slips, I now pick the work back up and finish it instead of messaging you that it's late. You hear from me when it's done. You'd only get a 'missed' message if I couldn't restart the work at all, and that message tells you what I'm doing about it."
- **Moved times**: "If I need more time on something I promised, I'll tell you the new time. A time can't change without you being told."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Pre-deadline checks that restart stopped work | Automatic |
| Overdue pickup with no message to the person | Automatic |
| Reschedule a promised time, telling the person | `POST /commitments/:id/reschedule {newTime, message}` |
| One-off 15-minute grace after a miss | `POST /commitments/:id/reschedule {grace: true, minutes}` |
| Promise review `set-time` and `pick-up` actions | Promise-review job |

## Evidence

Justin, topic 144400, 2026-11-18 12:11 and 12:14 PT, rejected the late list ("These were due and aren't marked done") and asked for prevention first. Spec `docs/specs/promise-keeping-before-the-deadline.md` converged in 6 rounds. Tests: `tests/unit/promise-keeping-core.test.ts`, `tests/unit/promise-keeping-pass.test.ts`, `tests/unit/promise-handoff.test.ts`, `tests/unit/late-notice-reconciler.test.ts`, `tests/unit/PromiseReview.test.ts`, `tests/unit/CommitmentMutation.test.ts`, `tests/integration/overdue-promise-follow-through-routes.test.ts`, `tests/e2e/overdue-promise-follow-through-alive.test.ts`.
