# Side-Effects Review — store seam + processing composition + observability (Phase 1, increment 9)

**Slug:** `feedback-factory-store-compose`
**Date:** `2026-05-27`
**Author:** Echo (autonomous)
**Spec:** `docs/specs/feedback-factory-migration.md` (converged v2, approved by Justin 2026-05-26)
**Scope:** The data-access seam (`FeedbackStore` interface + `InMemoryFeedbackStore`), the processing composition (`processUnprocessed` = clusterItems + computeReopen over the store), and the observability counters. The REAL Prisma adapter + the HTTP/app placement remain the blocked, credentials/decision-gated pieces.

## Summary of the change

Adds:
- `src/feedback-factory/store/FeedbackStore.ts` — the dependency-injection boundary (interface + `FeedbackMetrics` counters + `InMemoryFeedbackStore`).
- `src/feedback-factory/processor/process.ts` — `processUnprocessed(store, now)`, which composes the already-parity'd pieces, mirroring the reference's `cmd_cluster` (decide) + `cmd_apply_clusters` (write) run back-to-back: read unprocessed + active clusters → `clusterItems` decides → apply create/merge → on a "possible regression" merge, `computeReopen` + `applyReopen` → mark processed → update counters.
- Observability: the `FeedbackMetrics` surface (captured / created / merged / reopened) the store maintains (spec §2.7's "meter the loop", minimal form).

This is the glue that assembles the ported brain. The real Prisma adapter is a thin shim that implements the same interface; **nothing is wired into a route/job yet** — no behavioral change.

## Equivalence / verification

The constituent decision logic (`clusterItems`, `computeReopen`) is each already parity-verified against the reference (increments 4 + 8). This increment adds the **Tier-2 integration test** proving they COMPOSE correctly over the data seam: new clusters created, duplicates merged (order-dependent), the 0.55 false-merge guard blocks a mid-similarity merge into a fixed cluster, a real regression auto-reopens (status → investigating, recurrence bump, audit note), counters tally, and empty input is a no-op. `InMemoryFeedbackStore`'s field mutations (reportCount increment, recurrence bump on regression, note append with blank-line separator) mirror the reference's prisma `update` shapes.

## Seven-dimension review

1. **Over/under-reach** — Pure logic + an in-memory store; not wired to any route/job. The interface is shaped by what the ported drivers + composition need (not speculative). `InMemoryFeedbackStore` mutates only its own Maps.
2. **Level-of-abstraction fit** — `store/` is the data-access layer; `process.ts` is the composition; the real DB adapter (Prisma) implements the interface later. Correct seam — the blocked app/DB decisions sit cleanly behind it.
3. **Signal vs Authority** — The composition applies the decisions the parity'd pieces produce; the evidence gate / curated lifecycle still hold terminal authority (unchanged). Counters are read-only observability.
4. **Interactions** — First module to IMPORT the others (`cluster`, `reopen`, `types`) — but only in `process.ts`, which nothing else imports yet. No runtime path touched.
5. **Rollback cost** — Trivial: delete the store + process + tests. Additive.
6. **Migration parity** — N/A. New internal library code; no agent-installed file touched. (The real-adapter wiring + sender repoint are the separate Migration-Parity'd cutover steps, blocked.)
7. **Failure modes** — (a) Composition mis-wires create vs merge vs reopen → the Tier-2 integration test covers all branches. (b) Order-dependence lost → integration test asserts fb-2 merges fb-1's fresh cluster. (c) Reopen not triggered on regression → asserted (status/recurrence/note). (d) Counter drift → asserted per-branch + empty-input no-op.

## Tests

- Tier-1 unit (CI): `tests/unit/feedback-factory/store.test.ts` — 6 tests (read filters, create/merge/reopen mutations, aged vs regression recurrence).
- **Tier-2 integration (CI): `tests/integration/feedback-factory-process.test.ts` — 4 tests** composing the full pipeline over the real `InMemoryFeedbackStore` (the integration tier the pure-logic increments deferred until a store existed).
- E2E (feature-alive) attaches when the processor job + canonical front are wired — that's gated on the blocked app-placement + Prisma-adapter decisions. Reasoned, documented.
