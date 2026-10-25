# Round 16 — adversarial and lessons-aware review

Reviewed current body `9294f4b98380ebfb6727a408530ea66092e9710d0971e46a82a67ad7347ca5b5`: corrected metric units, N1–N10 notification contracts, binding/recovery invariants, source anchors, browser activation conditions and conformance round 16. Two perspectives from this same reviewer.

## ADVERSARIAL

**DESIGN: 0. PRECISION: 0.**

Round-15 P1 is resolved: partially delivered is counted per logical operation, separately from accepted/unknown/failed/scheduled physical children and transport attempts. Atomic aggregate updates, idempotency, stale/unknown coverage and archive-total invariance remain required.

Splitting the notification contract into N1–N10 did not weaken its boundaries. N1 exclusively owns special-permit consumption and sabotage controls; N3 binds variants to one child; N4 forbids IPC timeout takeover; N6 independently validates bounded policy state; N7 consumes before the one network attempt; N8 disallows restart reuse; N10 rechecks policy at dequeue under paced bounded fan-out. None creates an ordinary sender bypass or a second execution authority.

Rechecked browser behavior independently of the external review history: the first failed canary or unsupported loaded build already holds writes. One read-only repair attempt cannot submit or replay a message. Two consecutive upstream failures trigger migration, rather than permitting the first incompatible build to send. Receipt uncertainty and durable random IDs remain preserved through any enrolled alternate transport. No new defect found in those contracts. This assessment does not change any external reviewer's declared counts.

## LESSONS-AWARE

**DESIGN: 0. PRECISION: 0.**

P20 is now explicitly listed and remains substantive: model observations, server receipts, projection freshness and production wiring must demonstrate state rather than registration or appearance. P19/P22's persisted recovery latch and explicit brake still survive an observe-only governor. P23 keeps outage notices coalesced at authorized operator hubs; observability measures operations, children and actual attempts without treating counters as permission. The retained-audit and scoped-metrics requirements remain distinct from the activation test matrix.

The shortened Terms introduction avoids duplicate definitions without changing the one-outbox architecture. Runtime compliance remains explicitly unclaimed until all enabled sender families and sub-obligations have production evidence.

## Counts and scope

Combined: **0 DESIGN, 0 PRECISION**. Conformance round 16 checked 90 standards, zero findings, not degraded. All prior findings and independent external classifications remain retained. This internal pass alone does not establish aggregate convergence. No source/runtime edits or external sends performed.
