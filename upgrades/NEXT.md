# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Ninth increment of the **Feedback Factory Migration** (Dawn → Echo; spec `docs/specs/feedback-factory-migration.md`, approved) — the piece that assembles the ported brain. Adds the data-access seam (`FeedbackStore` interface + an in-memory implementation) at `src/feedback-factory/store/`, the processing composition `processUnprocessed` at `src/feedback-factory/processor/process.ts` (which wires the already-ported clustering + auto-reopen together, mirroring the reference's "decide then apply" steps), and the factory's own observability counters (captured / created / merged / reopened).

The real database adapter is a thin shim that implements the same interface — left for cutover since it needs cloud credentials and the hosting decision. **Nothing is wired into a route or job yet** — no behavioral change.

## What to Tell Your User

- The individual pieces of the feedback brain now snap together into one working pipeline (read new reports → group them → reopen regressions → count what happened), proven end-to-end against an in-memory test database.
- It also keeps its own running tally — how many reports came in, how many new bug-piles were created, how many merged, how many reopened — the start of the factory's self-monitoring.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| FeedbackStore seam + in-memory store | `src/feedback-factory/store/FeedbackStore.ts` — the DB-adapter boundary (real adapter at cutover) |
| Processing composition | `processUnprocessed(store, now)` in `src/feedback-factory/processor/process.ts` — not yet wired |
| Observability counters | `store.metrics()` — captured / created / merged / reopened |

## Evidence

- The decision logic inside (clustering, auto-reopen) is each already proven identical to Dawn's original in earlier increments. This increment adds the integration-level proof that they **compose** correctly: a Tier-2 test runs the whole pipeline over a real in-memory store and asserts new clusters are created, duplicates merge (order-dependent), the false-merge guard blocks a mid-similarity merge into a fixed bug, a genuine regression auto-reopens (status → investigating, recurrence bumped, audit note written), the counters tally, and empty input is a clean no-op.
