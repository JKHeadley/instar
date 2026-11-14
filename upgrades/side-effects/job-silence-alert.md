# Side-Effects Review — job silence alert

**Version / slug:** `job-silence-alert`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** independent job alert reviewer (concurred)

## Summary of the change

Tier 1, seven files and about 300 lines including tests and documentation. The scheduler records actionable skip streaks and checks overdue enabled jobs every five minutes. It raises a deduplicated operator message and closes it only after completed success. One design review and one commit attempt planned.

## Decision-point inventory

- Alert eligibility — added. It only produces an operator signal; it never blocks or schedules work.
- Skip recording and successful completion — passed through. Their existing authority is unchanged.

## 1. Over-block

No block/allow surface. The alert may be noisy for a job whose gate intentionally says there is no work on most runs; the job owner can distinguish that from a broken dependency in the message.

## 2. Under-block

A job missing entirely from this machine's definitions is invisible to this step. Lease coverage and job replication address that in the next changes. A job never seen by this scheduler is outside its local catalog. Existing jobs with no first-seen stamp start a durable observation baseline at boot, so the first overdue alert can lag one schedule window.

## 3. Level-of-abstraction fit

The scheduler owns schedule, skip and completion facts, so it is the right place to produce the signal. Attention delivery stays with TelegramAdapter. No second job runner is introduced.

## 4. Signal vs authority compliance

Reference: [Signal vs Authority](../../docs/signal-vs-authority.md). This change has no block/allow surface. It reports observations and leaves job execution untouched.

## 4b. Judgment-point check

No static heuristic is added at a competing-signals block/allow decision. The thresholds only decide when to show an advisory item.

## 5. Interactions

The existing consecutive-failure alert still handles failed runs. While that durable failure episode is active, the silence checker suppresses its parallel notice; the dedicated failure alert and reminder cadence own that case. After recovery, a later missed schedule can open a new silence episode. A skipped run does not count as a success. Successful script and session paths close a silence episode. The durable one-hour send-attempt floor, 24-hour reminder limit and in-flight guard avoid floods; epoch checks prevent a late alert promise reopening a recovered episode.

## 6. External surfaces

The operator receives one message per affected job, with at most daily reminders while it remains silent. No job definition, gate, schedule, machine role, or Telegram topic mapping changes.

## 7. Multi-machine posture

The serving scheduler owns the signal. A read-only standby records its local skip ledger but cannot write alert state or start a new send. A send already handed to Telegram may finish after demotion; the result cannot write alert state on the old holder. The persisted episode is local to the machine that observed it; the later lease coverage change must compare the pool's job catalog so a vanished job is visible on promotion.

## 8. Rollback cost

Revert this code. No attention item is created; the episode is removed on completed success. No migration or job data repair is needed.

## Second-pass review

Independent reviewer raised delivery retry, timing and lease-race concerns. The implementation now uses confirmed sends, the next cron occurrence, a durable baseline, and a live read-only check immediately before send. **Concur with the review** after those changes; a send already in transport is bounded by the existing Telegram delivery path.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action` — **closure: guard**. The durable last-attempt stamp limits failed sends to one per hour; a confirmed send limits reminders to one per day. The `job-silence-alert` entry in `src/testing/selfActionRegistry.ts` and the ratchet in `tests/unit/self-action-convergence.test.ts` prove the one-hour floor under permanent delivery failure, including reconstruction.
