# Side-Effects Review — auto-reopen-on-regression decision (Phase 1, increment 8)

**Slug:** `feedback-factory-reopen`
**Date:** `2026-05-27`
**Author:** Echo (autonomous)
**Spec:** `docs/specs/feedback-factory-migration.md` (converged v2, approved by Justin 2026-05-26)
**Scope:** The pure auto-reopen DECISION (which status/field/recurrence-bump + audit note) extracted from the regression branch of `cmd_apply_clusters`. The prisma writes stay in the (later) store adapter.

## Summary of the change

Ports the auto-reopen-on-regression decision into `src/feedback-factory/processor/reopen.ts` as the pure `computeReopen(cluster, feedbackId, now)`. When the clustering driver merges a report into a fixed/resolved/deferred cluster (a "possible regression"), the cluster is auto-reopened: `deferred → AGED-REOPEN → status 'new', annotate actionTaken, no recurrence bump`; otherwise `REGRESSION → status 'investigating', annotate researchNotes, bump recurrenceCount`. Also templates the audit note verbatim. `now` injected. **Not wired into any route/job yet.**

## Equivalence verification

The decision is interleaved with DB writes in the reference, so equivalence is by faithful transcription + both-sides-of-boundary unit tests (5): deferred vs fixed vs resolved → correct status/field/tag/recurrence; the audit-note string asserted verbatim (tag, time, prior status, `fixedInVersion`, new status, report id); `fixedInVersion=n/a` fallback.

## Seven-dimension review

1. **Over/under-reach** — Pure function, no I/O, no state, not imported by any runtime path. Returns the decision + note; the caller (store adapter) does the prisma update.
2. **Level-of-abstraction fit** — Processor-logic layer, alongside cluster/transition/verify. The DB write (`{ increment: 1 }`, field append) is correctly left to the adapter.
3. **Signal vs Authority** — N/A; produces a decision. The reopen is itself a legitimate guard (regression must not stay marked fixed) that exists in the reference.
4. **Interactions** — None. New isolated module; nothing imports it yet. Pairs conceptually with `cluster.ts` (which emits the regression merge-note) but no code coupling yet.
5. **Rollback cost** — Trivial: delete the module + tests.
6. **Migration parity** — N/A. New internal library code; no agent-installed file touched.
7. **Failure modes** — (a) Wrong field/status/recurrence per prior-status → both-sides tests. (b) Audit-note drift → asserted verbatim. (c) `now` non-determinism → injected.

## Tests

- Tier-1 unit (CI): `tests/unit/feedback-factory/reopen.test.ts` — 5 tests (aged vs regression branches, resolved, verbatim note, n/a fallback).
- No cross-runtime parity harness (decision interleaved with DB writes in the reference; equivalence by transcription + boundary tests).
- No integration/E2E this increment: not wired; attaches when the apply/store layer lands. Reasoned, documented.
