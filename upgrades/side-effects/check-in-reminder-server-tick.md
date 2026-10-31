# Side-Effects Review — Check-in reminder server tick

**Version / slug:** `check-in-reminder-server-tick`
**Date:** `2026-10-30`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see end)`

## Summary of the change

Tier 1. A server timer drives the existing LLM-free check-in reminder pass with no session, default
dry-run, with a quiet soak ledger and a `tick` status block. Size: about 9 source files, 2 spec
review rounds. The route and tick now share one pass builder and one single-flight.

## Decision-point inventory

- `isCheckInReminderDue` — modify — adds `other-machine`, which can only narrow sends.
- Tick skip gates — add — reuse the feature gate; `tickEnabled` can only turn the tick off.

---

## 1. Over-block

A row stamped with a machine id that no longer exists is never reminded on the remaining machine.
It stays visible under `pending` on the read route, and `skippedByReason.other-machine` counts it.

## 2. Under-block

A reminder owned by a machine that is down waits for that machine. Stated in the spec. A
server restarting inside every interval never ticks; the ledger shows the gap, the startup log the cause.

## 3. Level-of-abstraction fit

The driver follows the `windowLifecycleTick` precedent: createRoutes installs it, AgentServer owns
the timer. The reconciler stays the only decision and delivery logic.

## 4. Signal vs authority compliance

No blocking authority is added. Reminder text remains a fixed template on the deterministic path.

## 5. Interactions

A job or manual route call beside the tick shares the single-flight. Dry-run writes no stamps and no
attempts, so the soak cannot consume retries. PromiseBeacon is untouched.

## 6. External surfaces

`GET /commitments/check-in-reminder` adds `tick`; the pass report adds `dueIds`, additive. New log
file with ids and counts only. CLAUDE.md template line updated, with a text migration for
existing agents. No Telegram output in any default config.

## 7. Multi-machine posture

Machine-local by design, superseding the parent spec's lease-only rule: the tracker store is
per machine, replicas are never scanned. User-facing delivery keeps the existing origin
hold-and-forward path, so one voice is preserved. No URLs generated.

## 8. Rollback cost

`tickEnabled: false` stops it at the next tick with no restart. Reverting removes the timer. No
state migrates. Worst case on revert: CLAUDE.md keeps wording that names the tick.

## Second-pass review

Independent reviewer raised four concerns, all fixed before commit: config read from the boot
snapshot (now LiveConfig); the undelivered notice would be held by the hub filter (now `needsUser`);
the pass route could wait forever on a stalled pass (now 503); a route or job pass that gave up
skipped the notice (bookkeeping moved into the shared pass). Reviewer concurred on dry-run hold,
single-flight, no session spawn, ledger contents, timer teardown and the migration regex.
Concur with the review after those fixes.

## Class-Closure Declaration

- **Class:** `unbounded-self-action`
- **Closure:** guard
- **Citation:** `tests/unit/self-action-convergence.test.ts` (ratchet), controller `check-in-reminder-pass`
- **How it settles:** the tick only drives that registered pass. The durable sent stamp ends a delivered row, and `CHECK_IN_MAX_ATTEMPTS`, persisted before each send, bounds a failing one.
