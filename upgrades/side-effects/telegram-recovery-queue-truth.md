# Side-Effects Review — Telegram recovery queue truth

**Version / slug:** `telegram-recovery-queue-truth`  
**Date:** 2026-07-15  
**Author:** Instar-codey  
**Second-pass reviewer:** pending

## Summary of the change

The relay shell reopens canonical SQLite and proves the delivery ID, topic, text hash, and queued state before claiming durability. `PendingRelayStore.open` atomically quarantines enumerated zero-byte legacy artifacts and never deletes evidence. The delivery sentinel adds compare-and-swap claim ownership, lease renewal during I/O, and ownership-fenced finalization, giving one drain owner authority for each delivery ID.

## Decision-point inventory

- `telegram-reply.sh` recoverable branch — reports queued after durable row verification.
- `DeliveryFailureSentinel.processRow` — grants one drain worker atomic send authority.
- `PendingRelayStore.open` — atomically renames enumerated legacy files observed at exactly zero bytes into quarantine; it never deletes them.

## 1. Over-block

A valid write whose row cannot be reopened within two seconds is reported as unverified even if readability returns later. The durable row remains available to the server drain; the shell chooses an honest loud failure over an unproved promise.

## 2. Under-block

CAS prevents concurrent store drains from double-sending. Remote Telegram send plus local terminal transition remain separate operations; the existing delivery-ID header and server dedup cover response-loss redrive within the server window. Non-empty legacy stores remain preserved for review.

## 3. Level-of-abstraction fit

Path construction stays centralized in `resolvePendingRelayPath`. The shell mirrors the canonical layout because it queues while Node is unreachable, then verifies through SQLite. Exactly-once ownership sits at the database claim chokepoint rather than process timing.

## 4. Signal vs authority compliance

Durable row presence and compare-and-swap ownership are enumerable transport invariants and idempotency mechanics. They fit the documented hard-invariant exception and involve zero conversational judgment.

## 4b. Judgment-point check

File size, exact row presence, and CAS match are mechanical facts rather than competing signals.

## 5. Interactions

- **Shadowing:** verification follows both writer attempts and precedes the user-facing claim.
- **Double-fire:** CAS closes the two-sentinel race; delivery-header dedup remains defense in depth.
- **Races:** cleanup uses same-directory atomic rename; a writer racing after the zero-byte check leaves its bytes under the quarantine name. Claim heartbeats prevent live-send takeover and every final transition requires the exact current ownership token.
- **Feedback loops:** a lost CAS returns retry without sending; the winner advances state.

## 6. External surfaces

Shell stderr becomes truthful on failed persistence. Echo's ten verified zero-byte legacy files were removed after coherence approval; its 880 KB canonical queue and sidecars stayed intact. Existing installations receive the relay through whole-template post-update migration.

## 6b. Operator-surface quality

Dashboard and forms stay unchanged. The shell error uses plain language and excludes secrets and database internals.

## 7. Multi-machine posture

**Machine-local BY DESIGN:** pending relay state describes one machine's local-server attempts. Delivery IDs retain their existing relay-header contract. This change creates zero URLs and zero cross-machine notices.

## 8. Rollback cost

Revert and release. Automatic cleanup selects only legacy files observed at zero bytes and quarantines them without deletion; a racing writer's later bytes remain preserved under the quarantine name. Canonical schema and known non-empty state stay unchanged.

## Conclusion

Current openers were already canonical from the July 10 fix, so this patch targets the remaining false-success and concurrent-drain defects at their evidence and ownership chokepoints. Non-empty legacy evidence remains preserved.

## Second-pass review

**Reviewer:** Codex independent reviewer `/root/identity_repair_side_effects_review`  
**Independent read of the artifact:** concur after atomic-quarantine, exact-message verification, active-send lease renewal, and stale-finalizer fencing were independently verified; 45/45 focused tests passed.

## Evidence pointers

- `tests/unit/pending-relay-store.test.ts`
- `tests/unit/telegram-reply-recoverable-classification.test.ts`
- `tests/integration/sentinel-recovery.test.ts`
- `tests/e2e/telegram-recovery-queue-truth-lifecycle.test.ts`
- Focused result: 45/45 green; build and lint green.

## Class-Closure Declaration (display-only mirror)

`defectClass: unbounded-self-action`, `closure: guard`, `guardEvidence: { enforcementType: ratchet, citation: tests/integration/sentinel-recovery.test.ts, howCaught: the existing watchdog remains bounded by maxConcurrent and per-topic pacing; renewable claims settle to one owner, and exact-token finalization or retry prevents overlapping drains from multiplying sends }`.
