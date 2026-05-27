# Side-Effects Review — feedback-factory clustering driver (Phase 1, increment 4)

**Slug:** `feedback-factory-clustering`
**Date:** `2026-05-27`
**Author:** Echo (autonomous)
**Spec:** `docs/specs/feedback-factory-migration.md` (converged v2, approved by Justin 2026-05-26)
**Scope:** The clustering decision loop of `cmd_cluster` (:1405) — assign each unprocessed item to an existing cluster or create a new one. Pure orchestration over the already-parity'd Jaccard similarity. The DB read/write halves (the queries + `cmd_apply_clusters`) are the store/adapter layer, a later increment.

## Summary of the change

Byte-exact port of `cmd_cluster`'s decision loop from `the-portal/.claude/scripts/feedback-processor.py` to `src/feedback-factory/processor/cluster.ts` as the pure function `clusterItems(items, clusters)`. Adds shared types (`src/feedback-factory/processor/types.ts`: `FeedbackItem`/`Cluster`/`ClusterResult`), the clustering parity harness, and Tier-1 unit tests. Pure functions, no I/O. **Not wired into any route/job yet** — no behavioral change.

The decision rules ported: per item, pick the highest-Jaccard cluster over `"{title} {description}"`; merge if score ≥ threshold (0.55 for `fixed`/`resolved`/`fix_applied` clusters — the false-merge guard — else 0.35); else create a new `cluster-<slug>` and make it a candidate for later items in the batch (order-dependent, by design). Regression/reopen merge-notes preserved.

## Equivalence verification

- **7/7 fixture decisions match the REAL `cmd_cluster`.** The parity harness monkeypatches the reference's `run_prisma_query` to feed (items, clusters) fixtures and runs cmd_cluster's actual, unmodified loop, capturing its returned results — so this is parity against the real code, not a re-implementation. Matched fields: action, clusterId, rounded similarity, and merge note. Fixture exercises create / merge-open / the 0.55 false-merge guard / merge-into-fixed (regression) / merge-into-deferred (reopen) / order-dependence / slug.
- Builds on the already-parity'd `jaccardSimilarity` (increment 2, 20/20), so the only new surface is the orchestration + `pyRound3` (Python round-half-to-even, unit-tested on exact-half cases).

## Seven-dimension review

1. **Over/under-reach** — Pure deterministic function, no I/O, no global state, not imported by any runtime path. Works on a shallow COPY of the clusters array so the caller's input isn't mutated (while still letting created clusters match later items, as the reference does).
2. **Level-of-abstraction fit** — Processor-logic layer, on top of the similarity primitive. The DB I/O (reads + `cmd_apply_clusters` writes) is deliberately NOT here — it belongs to the store/adapter layer, keeping this pure + parity-testable.
3. **Signal vs Authority** — N/A; pure computation producing a decision list. The FALSE-MERGE-GUARD near-miss LOG line is intentionally NOT emitted by the pure function (it's a stdout side effect of the reference); the observability layer emits it. The DECISION (create vs merge) is identical.
4. **Interactions** — None. New isolated module; nothing imports it yet. Parity scripts LOCAL-only.
5. **Rollback cost** — Trivial: delete the module + tests + scripts. `types.ts` is additive.
6. **Migration parity** — N/A. New internal library code; no agent-installed file touched.
7. **Failure modes** — (a) Port diverges from reference → parity harness (7/7, against the real loop) + unit tests. (b) `pyRound3` half-rounding divergence → unit-tested on exact-half cases + parity. (c) Order-dependence not reproduced → unit + parity both exercise a later-item-matches-earlier-created-cluster case. (d) The FALSE-MERGE-GUARD stdout log isn't reproduced → intentional (pure function); documented; the observability increment will emit it.

## Tests

- Tier-1 unit (CI): `tests/unit/feedback-factory/cluster.test.ts` — pyRound3 (incl. half-to-even), create/merge, the 0.55 guard, regression + reopen notes, order-dependence. 8 tests.
- Parity (local gate, evidence): `scripts/feedback-factory/clustering-parity.mjs` → **7/7** vs the real `cmd_cluster`.
- No integration/E2E this increment: not wired to a route/job; those tiers attach when the store/apply layer + job land. Reasoned decision, documented.
