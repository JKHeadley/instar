## What Changed

A commitment can now carry a **check-in date**, and a background reconciler
posts one reminder into that commitment's own topic when the date arrives.

Before this, "I'll report back by Friday" lived in the session that said it. If
that session ended, restarted, or compacted, Friday arrived and nothing
happened. The PromiseBeacon nudges on *rhythm*, not on dates — it has no concept
of a specific promised moment.

**What ships (ACT-724 step 1 of 2):**

- `Commitment.checkInAt` — an absolute instant, deliberately separate from the
  beacon's `nextUpdateDueAt` / `softDeadlineAt` so a one-time dated reminder and
  a rolling nudge cadence are not side effects of each other.
- `CheckInReminderReconciler` — a scan over open commitments, driven by the new
  `commitment-checkin-reminder` built-in job (every 5 minutes, `enabled: false`).
- `POST /commitments/check-in-reminder/pass` and `GET /commitments/check-in-reminder`.

**One recurring scan, not one alarm per commitment.** ACT-724 sketched a
per-commitment scheduler entry; taken literally that reproduces two of the three
defects the action itself lists — the two-file job dance (defect b) and
self-disable by file edit (defect c). A scan has neither: coverage is a property
of the scan, so there is no registration step that can be skipped, and teardown
is just the commitment reaching a terminal status.

**The ordering was wrong first, and the fix's own justification was unwired.**
The first design stamped `checkInReminderSentAt` *before* sending — which made
zero delivery a designed outcome, since a failed send left the commitment marked
delivered and permanently ineligible. Inverted to send-then-stamp with bounded
retry (5 attempts, then a loud `checkInReminderFailedAt`). The second review
round then caught that the duplicate mitigation justifying that inversion —
"the relay dedups" — was not connected: `sendToTopic` does not dedup, that lives
in the `/telegram/reply` route. The send is now explicitly routed through the
same durably-backed `OutboundContentDedup`.

**Honest guarantee: at-least-once, deduped at the delivery layer** — not
exactly-once. Both remaining windows are stated in the spec rather than designed
away.

## Evidence

- Tier 1 (41): the full eligibility predicate on both sides of every clause;
  idempotency across repeated passes; **a failed send never reads as sent** (the
  regression test for the round-1 finding); bounded retry to a loud terminal
  state; per-pass cap deferring rather than dropping; the reminder text never
  asserting completion.
- Tier 2 (10): real Express routes + auth — delivery, HTTP-boundary idempotency,
  dark 503, missing-transport 503, and `dryRun` defaulting ON when config omits it.
- Tier 3 (4): real `AgentServer` boot with a real injected `CommitmentTracker`.

## What to Tell Your User

Nothing changes until it's switched on. When it is: on the day the agent said it
would check in on something, you get one short message in that conversation
saying the date has arrived.

It will not claim the work is done — a reminder that implies completion closes
the question instead of reopening it.

**Not yet true:** ACT-724 asks that a dated commitment without a reminder be
structurally impossible. This ships dark, and a disabled watcher guarantees
nothing. What is true today: if the reconciler is running, no dated commitment
can slip past it individually. The creation-time gate that closes the rest is
step 2, and it cannot itself ship dark.

## Summary of New Capabilities

- Commitments carry a first-class check-in date that produces a real reminder.
- A reminder is never recorded as delivered unless it actually was; failures
  retry and then give up visibly.
- Two read/drive endpoints and a built-in job, all dark by default.
