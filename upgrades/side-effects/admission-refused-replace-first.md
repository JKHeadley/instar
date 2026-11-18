# Side-Effects Review — admission-refused inbound messages re-placed on the first drain attempt

**Version / slug:** `admission-refused-replace-first`
**Date:** `2026-11-17`
**Author:** `echo (machine stewardship, topic 144503)`
**Second-pass reviewer:** `not required (Tier 1: reuses the existing forced re-place path; no new block/allow surface)`

## Summary of the change

`src/core/QueueDrainLoop.ts`: a queued row whose enqueue reason is `work-admission-refusal` (new exported constant `WORK_ADMISSION_REFUSAL_REASON`) is, on its drain turn, claimed and sent to `forceReplace` at once instead of first retrying local dispatch through every backoff step. Outcomes map exactly like the existing maxAttempts escape (`true` → delivered, `'local'` → local dispatch with `final:false`, `'rejected'` → sender-deauthorized terminal + unified notice), except `false` (no machine can take it) releases the row with backoff (`releaseWithBackoff`, attempts+1) instead of expiring it, so the maxAttempts escape and the entry TTL still bound it. New durable counter `admissionRefusalReplaced` (listed in the status counters). `src/commands/server.ts` uses the constant at the one enqueue site. Tests: 5 new cases in `tests/unit/queue-drain-loop.test.ts` (peer placement, recovered local, no machine → retried not lost, sender refusal terminal, other reasons unchanged); 48 passed. Motivation: Chief of Staff approved enforcing work admission on the Mac Studio (msg f6bab5ef) on the condition that a message to an existing topic whose session ended is answered, not left waiting; the code answered it only after ~25 min (10 attempts, 5 s → 300 s backoff). Tier 1. Size: 3 files, about 70 lines. Effort: one review round.

## Decision-point inventory

- `QueueDrainLoop` per-row drain step — modify — for admission-refused rows only: re-place first instead of retrying local dispatch first.

---

## 1. Over-block

No block/allow surface — over-block not applicable. Nothing is refused that was delivered before.

---

## 2. Under-block

No block/allow surface — under-block not applicable. Residual: if every machine refuses, the row still waits (as before) and is re-placed each turn; with all machines saturated it ends at the TTL with the existing loss notice.

---

## 3. Level-of-abstraction fit

Right layer: the queue already owns "where does a saved message go next" and already has the forced re-place seam; this only changes WHEN that seam is used for one reason the queue itself records.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point: the placement choice stays with `SessionRouter.placeAndClaim` / `PlacementExecutor` (unchanged); this change only routes one recorded reason to it earlier.

---

## 5. Interactions

- **Shadowing:** hold-for-stability verdicts run before this branch (unchanged order), so a held row is still held.
- **Double-fire:** the row is claimed before `forceReplace`, the same CAS discipline as the maxAttempts escape; a lost claim returns.
- **Races:** same as the existing escape path (per-session chains in the router).
- **Feedback loops:** a re-place onto a peer moves the conversation's ownership there, which is the intended relief for the overloaded machine.

---

## 6. External surfaces

- Users: a person writing in a conversation on an overloaded machine gets the answer from a peer within one drain tick (15 s) instead of up to ~25 min.
- Other agents / install base: only agents with work admission enforced and the inbound queue live produce `work-admission-refusal` rows; others see no change.
- Persistent state: one new counter key in the queue's meta table.
- Operator surface: no operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

Not applicable: no dashboard, approval page or form is touched.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**unified.** The queue lives on the lease holder (unchanged); the re-place uses pool placement across all machines. No new notices (the existing "saved" notice and loss notice are unchanged), no new durable state beyond a counter, no URLs. Status surfaces: `GET /pool/queue` counters gain `admissionRefusalReplaced`.

---

## 8. Rollback cost

- **Hot-fix release:** revert; queued rows keep working under the old local-first retry.
- **Data migration:** none (the counter is inert).
- **Agent state repair:** none.
- **User visibility during rollback:** none.

## Conclusion

A narrow timing fix on an existing, tested path; it removes up to ~25 minutes of waiting for exactly the message class an enforced brake creates, and never turns a wait into a loss.

## Second-pass review (if required)

Not required.

## Evidence pointers

- `src/core/inboundQueueConfig.ts` defaults: maxAttempts 10, baseBackoffMs 5000, maxBackoffMs 300000, entryTtlMs 1800000.
- `src/commands/server.ts` Telegram cold-spawn `.catch`: admission refusal → `enqueueLive(..., 'work-admission-refusal')` + deterministic "Your message is saved..." notice.
- `tests/unit/queue-drain-loop.test.ts`: 48 passed; guard files passed; tsc clean.
