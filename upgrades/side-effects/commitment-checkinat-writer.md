# Side-Effects Review — POST /commitments accepts checkInAt

**Version / slug:** `commitment-checkinat-writer`
**Date:** `2026-10-21`
**Author:** `echo`
**Second-pass reviewer:** `not required` (Tier 1: one optional field added to an existing create path plus its validation; no new route, no config, no migration, no change to any existing field's semantics)

## Summary of the change

`Commitment.checkInAt` — the field `CheckInReminderReconciler` reads to post exactly one dated reminder — was declared on the `Commitment` interface, read in four places (`routes.ts` beacon trigger resolution, `all.filter(c => !!c.checkInAt)` in the dated backlog, and twice in `GET /commitments/check-in-reminder`), and accepted from a caller nowhere: `CommitmentTracker.record()`'s input type did not declare it. A create carrying `checkInAt` returned 201 with the field absent from the stored record. This adds `checkInAt?: string` to `record()`'s input, passes it through to the created commitment, and accepts it on `POST /commitments` with validation stricter than the existing deadline fields: a valid ISO instant **with a time component**, so a bare date is refused rather than resolved to midnight UTC. Files: `src/monitoring/CommitmentTracker.ts`, `src/server/routes.ts`.

## Decision-point inventory

- `POST /commitments` follow-through gate (`isBeaconEnrolled === hasOptOutReason`) — **pass-through, deliberately unchanged** — `checkInAt` is NOT added to `deadlineFields` and does NOT satisfy the gate. See §4b and §5.
- `POST /commitments` field validation — **add** — a `checkInAt` shape check (ISO instant, time component required).
- `CommitmentTracker.record()` input contract — **modify** — one optional field added; no existing field's handling changes.

---

## 1. Over-block

The new validation can refuse a create that previously succeeded — but only one that was already losing its data. Concrete shapes refused: `checkInAt: "2026-10-24"` (bare date) → 400 naming "bare date" with the correct shape shown; `checkInAt: "Friday"` → 400 naming ISO 8601. Both previously returned 201 and silently dropped the value, so no caller is losing working behaviour: a caller sending a bare date was already not getting a dated reminder, and now learns why.

The one real over-block risk is a caller that sends a *valid* bare-date string and does not care about the date (passing it decoratively). That request now fails. Accepted deliberately: a field whose only consumer is a reminder engine has no decorative use, and silently accepting a date that resolves to a wrong hour is the failure mode this refuses.

## 2. Under-block

Still missed, stated plainly: the validation checks **shape, not sense**. A `checkInAt` in the past is accepted; so is one years out. Nothing here reasons about whether the moment is plausible for the promise. That is deliberate — the reconciler owns "has this moment arrived", and a route-level plausibility heuristic would be a brittle detector holding authority over a judgment (§4). Also unchecked: the instant's timezone offset is honoured as given, so a caller that computes the wrong offset gets the moment it asked for.

---

## 3. Level-of-abstraction fit

Right layer. This is the **writer** for a field whose readers and policy already exist a layer above (the reconciler) and below (the `Commitment` interface, with its own long rationale for why the field is separate from `nextUpdateDueAt`). Nothing is re-implemented: no new reminder logic, no second dated-promise concept, no parallel store. The change is deliberately the smallest thing that makes the existing design reachable — the alternative considered and rejected was overloading `nextUpdateDueAt`, which the interface's own comment forbids because cadence logic would then silently reschedule a dated promise.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

The only refusal added is a deterministic **shape** check on a timestamp string (parseable, and contains a time component). That is an invariant, not a judgment: the field's contract states "an absolute ISO instant … never store a bare date", and the check is exactly that sentence. No LLM, no heuristic, no classification of intent.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point — and one was deliberately **not** added where it would have been tempting. The follow-through gate is a genuine policy decision (what counts as adequate follow-through for a promise), and the easy move was to add `checkInAt` to `deadlineFields` so a date satisfies it. That would have been a static rule asserting coverage by a mechanism whose live state (the reconciler's `dryRun`) the rule does not read. Instead the gate is left exactly as it was, with the reason recorded in code at the callsite, and the decision to let a date count as follow-through is deferred to whoever flips the reconciler — where the evidence for it lives.

---

## 5. Interactions

- **Shadowing:** the `checkInAt` validation runs after the existing `deadlineFields` loop and before the `beaconEnabled` type check. It cannot shadow either: it inspects a field neither looks at, and returns early only on its own field being malformed.
- **Double-fire:** the reminder path is untouched, so there is no new emitter. The one interaction worth naming is `routes.ts:2735`, where the beacon resolves a trigger instant as `[commitment.checkInAt, commitment.nextUpdateDueAt].find(…)` — `checkInAt` is already **first** in that list. So a commitment that now carries both will have its beacon trigger resolve to the `checkInAt` instant rather than the cadence deadline. That is the existing code's stated preference order, not a change introduced here, and it is the behaviour the field was designed for; it is named because this change is what makes that branch reachable for the first time.
- **Races:** none. One optional field written at create time, never mutated by this change.
- **Feedback loops:** none. The reconciler reads the field; the field's writer does not read the reconciler.

---

## 6. External surfaces

- **Other agents / install base:** `POST /commitments` gains an accepted optional field. Additive — every existing request body behaves identically. An agent that never sends `checkInAt` sees no difference.
- **External systems:** none. No message is sent by this change.
- **Persistent state:** commitments created from now on may carry one more field. No migration: the field is optional on an interface that already declared it, so existing records are valid unchanged, and nothing reads it as required.
- **Timing we do not control:** the instant is stored as given and compared by the reconciler, not here.
- **Operator surface (Mobile-Complete Operator Actions):** no operator-facing action added or touched. This is an agent-facing API field; the operator's surface for dated promises is the reminder itself, which this change deliberately does not turn on.

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**, with the reason: a commitment is already machine-local state owned by the machine that made the promise (`ownerMachineId` is an existing field on the record, and the reconciler runs per machine against its own store). This change adds one field to that same record and inherits its posture exactly; it introduces no new state and no new replication need. If commitments are ever replicated, `checkInAt` rides whatever the existing commitment replication does — there is nothing special about it.

Explicitly: it emits **no** user-facing notices (one-voice gating not needed — the reminder that would need it is a separate, currently dark mechanism), holds no new durable state beyond the field on an existing record, and generates **no** URLs.

---

## 8. Rollback cost

- **Hot-fix release:** revert the two source files; ship as the next patch. Requests sending `checkInAt` return to being accepted-and-ignored, which is the pre-change behaviour.
- **Data migration:** none needed. Records written while this was live keep a `checkInAt` the reverted code simply does not read — harmless, and read again if the change is re-applied.
- **Agent state repair:** none.
- **User visibility during rollback:** none. Nothing user-facing fires from this field today.

---

## Conclusion

The review changed one thing and refused one thing. It changed the validation: the first cut reused the existing `isIso8601` check, which accepts a bare date — tracing that through showed a Friday promise landing at 5pm Thursday Pacific, so the time-component requirement and its named error were added. It refused the tempting simplification of letting a date satisfy the follow-through gate, because the reconciler that would honour it ships dry-run, and recording a promise as covered by a switched-off mechanism is precisely the failure that let five fixes ship unannounced earlier the same day. The change is clear to ship with its scope stated honestly: a dated promise can now hold its date; it does not yet reliably produce a reminder.

## Second-pass review (if required)

**Reviewer:** not required
**Independent read of the artifact: n/a**

## Evidence pointers

- `tests/unit/CommitmentTracker-checkinat-writer.test.ts` — 5 tests: stored on the record, **persisted** (re-read from a fresh tracker over the same state dir), matched by the dated filter, absent when not promised, and `checkInReminderSentAt` not set at creation (a stored date is not a delivery).
- `tests/integration/commitments-checkinat-route.test.ts` — 8 tests through the real pipeline: accepted and persisted; bare date 400; non-timestamp 400; date alone fails the follow-through gate; rides alongside beacon enrollment; no default date invented; no delivery stamp; the dated filter is no longer necessarily empty.
- Live before-state (2026-10-21): CMT-883 created with `checkInAt` → HTTP 200, field absent from the stored record's keys; `GET /commitments/check-in-reminder` → `datedCount: 0` across 883 commitments.

---

## Class-Closure Declaration (display-only mirror)

- **`defectClass`** — `novel` is NOT claimed. This is the same class as the morning's `/health` finding and the release-gate flip: **a documented capability whose mechanism is unreachable or inert, reported by a surface that cannot distinguish "nothing to report" from "no way to report"**. Here: four readers, no writer, and a count of zero that read as "no dated promises" rather than "dated promises are impossible".
- **`closure`** — `gap`.
- **`guardEvidence`** — not applicable (no guard claimed).
- **`gap`** — the class-level guard worth building is a lint asserting that every field read by a reconciler or sentinel is accepted by at least one writer reachable from a route or in-process caller — a "no readers without a writer" ratchet. Declared as a gap rather than built here because it needs a reader/writer model of the field graph, and claiming `guard` on the strength of this change's thirteen tests would pass instance coverage off as class coverage.
