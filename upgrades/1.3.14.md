# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Fourth increment of the **Feedback Factory Migration** (Dawn → Echo; spec `docs/specs/feedback-factory-migration.md`, approved). Ports the **clustering driver** — the decision loop of `cmd_cluster` — from the reference Python (`the-portal/.claude/scripts/feedback-processor.py`) to TypeScript at `src/feedback-factory/processor/cluster.ts` (`clusterItems`), plus shared types in `src/feedback-factory/processor/types.ts`.

This is the orchestration that ties the brain together: for each incoming report it picks the most-similar existing cluster (via the already-ported Jaccard matcher) and either merges into it or creates a new one — applying the higher 0.55 similarity bar before merging into an already-fixed cluster (the false-merge guard), and flagging possible regressions/reopens. Pure functions; **not wired into any route or job yet** — no behavioral change.

## What to Tell Your User

- The part of the feedback brain that actually groups reports into "this is one bug" piles is now ported — including the safety rule that makes it harder to wrongly lump a new report onto an already-fixed bug.
- Proven against Dawn's original the strongest way yet: I fed the same reports through her real grouping code and my rewrite and got identical grouping decisions, 7 for 7.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Clustering driver (TS port) | Internal module `src/feedback-factory/processor/cluster.ts` — not yet wired |
| Clustering parity harness | `node scripts/feedback-factory/clustering-parity.mjs` (local; set `PORTAL_PROCESSOR`) |

## Evidence

- **Parity vs the REAL `cmd_cluster`:** the harness monkeypatches the reference's database query to feed a fixture (existing clusters + incoming items) and runs cmd_cluster's actual, unmodified decision loop, capturing its results — then compares to the TS port. Result: **7/7 identical** decisions (merge vs create, which cluster, rounded similarity, and the regression/reopen note). The fixture exercises create, merge-into-open, the 0.55 false-merge guard, merge-into-fixed (regression), merge-into-deferred (reopen), and order-dependence (a later report matching a cluster created moments earlier in the same batch).
- **CI anchors:** unit tests assert each of those behaviors plus the Python-style half-to-even rounding, so a regression fails in CI even without the reference checkout.
