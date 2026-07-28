# Side-Effects Review — Worker blocker lifecycle metrics

**Version / slug:** `throughput-metrics`  
**Date:** 2026-07-21  
**Author:** Instar-codey  
**Second-pass reviewer:** metrics_second_pass

## Summary of the change

CommitmentTracker now acknowledges authoritative persistence and durably retains bounded blocker episodes. A non-authoritative SQLite service records two raw timing factors and exposes bounded local or proxied-per-origin reads. The feature is observe-only and development-agent gated.

## Decision-point inventory

- Commitment persistence — modified — mutations succeed only after atomic rename; failed writes roll back memory and return a typed failure.
- Blocker declaration — pass-through — the existing explicit transition remains the only declaration authority.
- Pool read admission — added — existing credential-safe peer URL allowlisting, schema validation, response limits, and deadlines bound reads.

## 1. Over-block

Persistence failure now rejects a transition that previously could appear successful despite not reaching disk. This is intentional verification of authoritative state. No user-message or work-selection block surface was added.

## 2. Under-block

Best-effort request timing can be lost on process death after commitment persistence and before ledger insertion; coverage reports that absence. A totally unavailable local SQLite ledger degrades telemetry without blocking commitments, by design.

## 3. Level-of-abstraction fit

CommitmentTracker owns authoritative mutation and episode state. The SQLite layer only derives measurements. It neither duplicates commitment authority nor feeds an action gate.

## 4. Signal vs authority compliance

Reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface beyond truthful persistence acknowledgement.

The measurements are raw nullable signals with no score, ranking, notification, work selection, or autonomous consumer.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Persistence acknowledgement and response-size/schema bounds are enumerable invariants; trend summaries remain descriptive.

## 5. Interactions

- Shadowing: the existing transition validation runs before persistence; storage failure is distinguished as 503.
- Double-fire: at-least-once delivery is deduped by `(origin,factor,sourceEventId)`.
- Races: mutation snapshots roll back complete in-memory state; batch effects emit only after the committed flush.
- Feedback loops: none; metrics have no behavioral consumer.

## 6. External surfaces

Adds authenticated summary/trend routes and a machine-local SQLite file. Pool reads use credential-safe allowlisting, four-wide concurrency, per-peer and aggregate size caps, deadlines, a 60-second coalescing cache, and field allowlisting. No external service, notification, operator action, or URL is added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Proxied-on-read:** each origin retains machine-local timing because clocks and persistence are origin-local; `scope=pool` returns bounded per-origin rows without inventing a fleet scalar. It emits no notices, strands no authoritative state, and generates no URLs.

## 8. Rollback cost

Disable the dev-gated feature or revert and ship a patch. The derived SQLite database may remain harmlessly and can be deleted without commitment repair. Episode fields are forward-compatible optional data.

## Conclusion

The review found and corrected persistence error classification, pool-response sanitization/capping/coalescing, and missing runtime guard registration. The feature is clear to ship after independent concurrence.

## Second-pass review

**Reviewer:** metrics_second_pass  
**Independent read of the artifact:** concur.

Concur with the review. The corrected implementation fail-closes unavailable metric reads, bounds and closed-schema sanitizes pool responses, exposes live guard health, and remains strictly measure-only.

## Evidence pointers

- `tests/unit/CommitmentTracker-blocker-lifecycle.test.ts`
- `tests/unit/BlockerLifecycleLedger.test.ts`
- Build plus 192 targeted lifecycle/dev-gate wiring tests.
- The no-silent-fallback ratchet remains at its 494 baseline after explicit fail-soft annotations.
- Capability discoverability, dev-gate attribution, and SQLite registry wiring ratchets pass.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect and no self-triggered action controller — not applicable. The reconciliation timer repairs measure-only telemetry and cannot retry or alter external work.
