# Side-Effects Review — scar (d) report partitioning + re-report guard (Phase 1, increment 10)

**Slug:** `feedback-factory-report-partition`
**Date:** `2026-05-27`
**Author:** Echo (autonomous)
**Spec:** `docs/specs/feedback-factory-migration.md` (converged v2, approved by Justin 2026-05-26)
**Scope:** The pure partition decision of scar (d) — the half Dawn flagged at `:2747` that complements the cluster-level cycling already ported in transitions.ts. The Telegram rendering + report-state persistence stay in the (later) notification layer.

## Summary of the change

Ports the operator-report partition decision into `src/feedback-factory/processor/reportPartition.ts` (`partitionClustersForReport(clusters, prev, now)`). Given the current clusters + what was surfaced in the last report, it decides: newly-open vs already-known open issues; new vs continuing investigating; items FIXED since the last report not announced before (the **re-report / cycling guard** — a fix is announced once, never again); severity ordering of the new buckets; and `shouldSkip` (nothing new ⇒ no noisy report). Pure — clusters, previous-report state, and `now` are injected. **Not wired into any route/job yet** — no behavioral change.

This completes scar (d): increment 3 ported the cluster-level cycling (`detect_cycling` + the chronic circuit-breaker); this ports the digest-level lifecycle partitioning + re-report prevention.

## Equivalence verification

The decision is embedded in a Telegram-rendering function in the reference, so equivalence is by faithful transcription + both-sides-of-boundary unit tests (6): new vs continuing open/investigating; severity sort (critical→low); the re-report guard (fix after last-report not-previously-announced included; before-last-report or already-announced excluded); the first-run 4-hour window; and `shouldSkip` true only when nothing is new. The set-membership, the `updatedAt > cutoff` comparison, the 4h first-run window, and the skip condition are transcribed verbatim.

## Seven-dimension review

1. **Over/under-reach** — Pure function, no I/O, no state, not imported by any runtime path. The state load + Telegram render are correctly excluded (notification layer).
2. **Level-of-abstraction fit** — Processor-logic layer; produces a partition the notification layer renders. The report-state persistence (`_save_last_report_state`) + Telegram formatting attach later, around this pure decision.
3. **Signal vs Authority** — N/A; produces buckets + a skip flag. No authority over cluster lifecycle.
4. **Interactions** — None. New isolated module; nothing imports it yet.
5. **Rollback cost** — Trivial: delete the module + tests.
6. **Migration parity** — N/A. New internal library code; no agent-installed file touched.
7. **Failure modes** — (a) Re-report guard inverted (announce a fix twice / never) → both-sides tests on prevFixed + updatedAt-vs-cutoff. (b) First-run window wrong → tested at the 4h boundary. (c) Skip-when-something-new → tested both directions. (d) Severity sort → tested.

## Tests

- Tier-1 unit (CI): `tests/unit/feedback-factory/reportPartition.test.ts` — 6 tests.
- No cross-runtime parity harness (decision embedded in a Telegram-rendering function; equivalence by transcription + boundary tests).
- No integration/E2E this increment: the digest rendering + state persistence are the notification layer, which attaches at cutover. Reasoned, documented.
