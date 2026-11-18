# Side-Effects Review — A dated promise to a person is kept or the person is told it is late

**Version / slug:** `overdue-promise-follow-through`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `not required (spec converged over 3 rounds with codex cross-model review; no protected path touched)`

## Summary of the change

The live check-in reminder pass (`CheckInReminderReconciler`) gains a late batch. When an open, agent-owned promise in a conversation passes its own recorded time (`softDeadlineAt`), the person gets one fixed-template message ("I told you this would be done by …. That time has passed and it isn't marked done"), and a running session for that topic gets a `[promise overdue]` system notice. Thirty minutes before the time, a running session gets a `[promise due soon]` notice. `POST /commitments` returns an advisory `dateMissing` when the words name a time and no promised time was set. PATCHing a `softDeadlineAt` clears the opt-out reason, and age-expiry holds rows with a future `softDeadlineAt`. An awareness entry tells agents about all of this.

Files:
- new: `src/monitoring/lateNoticeCore.ts` (pure), `src/monitoring/promiseHandoff.ts`, `src/data/awareness/overdue-promise-follow-through.md`;
- edited: `CheckInReminderReconciler.ts`, `CommitmentTracker.ts` (fields and the expiry hold), `CommitmentMutation.ts` (forwarded PATCH), `promisedUpdateDetector.ts` (`detectPromisedTime`), `routes.ts` (wiring, `dateMissing`, PATCH).

## Decision-point inventory

- Late notice (person-facing message) — **add** — an invariant over durable fields: open, agent-owned, own machine, `softDeadlineAt` passed, not yet noticed for that time, under the caps.
- Due-soon nudge (session notice) — **add** — session-only; a running session or nothing.
- `dateMissing` advisory — **add** — a field in a route response; writes nothing, blocks nothing.
- Age-expiry hold — **modify** — a future `softDeadlineAt` now holds expiry, as `hardDeadlineAt` already did.
- PATCH opt-out clearing — **modify** — a promised time replaces "no follow-through needed".

---

## 1. Over-block

No block/allow surface. Nothing is refused or held. The nearest thing is the notice caps, which only delay: a 60-minute per-topic cooldown, 3 topics per pass and 12 per hour per machine. Held rows go out on a later pass. The 24 h backlog window drops notices for times that passed more than 24 h before a machine's first live pass. That is intended: those are the pre-existing backlog, triaged by hand.

## 2. Under-block

- A promise recorded with no `softDeadlineAt` is not watched. The `dateMissing` ask covers "by/before <clock>" phrasing only. Durations ("in an hour") are already captured by other lanes as synthetic hard deadlines, which are deliberately ignored.
- A promise whose owner machine is down gets no notice: `ownerMachineId` never changes. This is the same as the check-in reminder, and it is stated in the spec.
- A dead session is not restarted by the handoff. The person is told, and their reply wakes it.
- After three missed times for one promise, nothing more is sent.

## 3. Level-of-abstraction fit

This is the right layer. It extends the existing dated-reminder reconciler, the one place that already turns a date on a commitment into a deterministic message, with its gate, dry-run switch, ticker, single flight, origin-boundary delivery and attention item. Nothing parallel was built. The handoff reuses `injectPasteNotificationObserved`, the existing system-notice inject.

## 4. Signal vs authority compliance

No blocking authority. The late notice is a fixed-template fact on the deterministic path that check-in reminders already use. The `dateMissing` keyword guard decides only whether to *ask*; the recording session is the arbiter of the date, which is "intelligence infers, keywords only guard". The handoff carries no authority: it is a system notice that tells the session to read the record.

## 4b. Judgment-point check

There is no static heuristic at a competing-signals point. The late-notice predicate is arithmetic over durable fields, and "the promised time passed and the person was not told" has no competing signal. What to do about it (deliver, give a new time, withdraw) is left to the owning session with full context. The fixed limits are each contested in the spec's "Fixed limits" section.

## 5. Interactions

- **Check-in reminder.** Same pass and same gate. The late batch runs after it, with its own budget, wrapped so a late-batch error cannot fail the check-in batch. A promised-update row carries only `checkInAt`, so it never matches the late predicate, and there is no double message.
- **PromiseBeacon.** Untouched. Its person-facing output stays off. An agent with `promiseBeacon.userOutputEnabled: true` could get beacon output and a late notice for the same row. That is accepted, because they say different things (cadence status versus a missed time).
- **Attention item.** Late give-ups count into `gaveUp`, which raises the existing "reminders could not be delivered" item.
- **Age-expiry.** A future soft time now holds a row, which only narrows expiry.
- **Inbound pipeline.** Not used. The handoff never calls `onTopicMessage`, so the Chief of Staff gate, the memory-privacy refusals, hub intent, acknowledgements and the standby proxy are all untouched.

## 6. External surfaces

- **Person-facing.** New messages in the person's conversations, one per missed promised time, bounded as above. They are live on development agents only, dark on the fleet (check-in `dryRun` defaults true).
- **Agent-facing.** New `[promise due soon]` and `[promise overdue]` notices in running sessions; the `dateMissing` field on `POST /commitments`; the `late` block in the pass report; the new awareness entry.
- **Timing.** Up to one 5-minute tick after the promised time, plus cooldown and caps during a burst.

## 6b. Operator-surface quality

Not applicable: no dashboard, approval page or grant form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Unified (replicated). The new commitment fields are written through `mutate()` and replicate with the row. One voice: only the row's owner machine speaks, and a legacy row with no owner stamp speaks only from its origin machine. The per-hour cap is per machine. The epoch file is per machine by design: it marks when that machine started speaking.

**Status surfaces.** `POST /commitments/check-in-reminder/pass` gains a `late` block covering this machine's rows. No `/status`, `/health` or `/capabilities` change.

## 8. Rollback cost

`commitments.checkInReminder.dryRun: true`, read live, silences sends, stamps and handoffs without a restart. A revert removes the feature. The new fields are optional, so old code ignores them. The epoch file is inert. No migration and no state repair are needed.

## Conclusion

This is a bounded, deterministic extension of a live, proven mechanism. It holds no blocking authority, it is reversible with one live switch, and it uses no inbound-pipeline path. Clear to ship.

## Evidence pointers

- Spec and convergence report: `docs/specs/overdue-promise-follow-through.md`, `docs/specs/reports/overdue-promise-follow-through-convergence.md`.
- Tests:
  - `tests/unit/late-notice-core.test.ts` (63);
  - `tests/unit/late-notice-reconciler.test.ts` (24);
  - `tests/unit/promise-handoff.test.ts` (10);
  - `tests/unit/CommitmentTracker-auto-expiry.test.ts` (+2);
  - `tests/integration/overdue-promise-follow-through-routes.test.ts`;
  - `tests/e2e/overdue-promise-follow-through-alive.test.ts`.

## Revision — guard-test fixes on the merge with main (2026-11-18)

Two catch blocks gained in-brace `@silent-fallback-ok` notes. Neither is silent: the handoff inject failure returns "not accepted", which the pass report records, and the attempt-count CAS failure is in the pass report with the row left eligible. The spec's maturation `ladder:` field now says "not applicable", because this feature has no flag of its own and rides `commitments.checkInReminder`. No behavior change.
