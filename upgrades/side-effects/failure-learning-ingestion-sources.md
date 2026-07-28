# Side-Effects Review — Failure-Learning Ingestion Sources (slice 1)

**Slug:** `failure-learning-ingestion-sources`
**Date:** 2026-05-28
**Author:** echo
**Spec:** `docs/specs/FAILURE-LEARNING-INGESTION-SOURCES-SPEC.md` (CONVERGED v3.1, approved: true — Justin, topic 13201)
**Convergence report:** `docs/specs/reports/failure-learning-ingestion-sources-convergence.md`

## Summary

Slice 1 of the ingestion-sources build (per spec §10): the `ci` + `revert` automatic feeds plus the shared substrate they depend on. This artifact is updated per commit as slice 1 lands.

### Commit 1 — shared substrate (this commit)

Files:
- `src/monitoring/FailureLedger.ts`: extend `FailureCategory` enum additively (`build-failure`, `test-failure`, `regression` — were clamped to `unknown`, spec §7); `open()` now (a) prunes `failure_occurrences` to the most-recent N per dedupeKey (bounded forensic log, spec §5 — safe because the analyzer never reads this table) via a new `maxOccurrencesPerKey` option (default 200), and (b) uses an `INSERT … ON CONFLICT(dedupe_key) DO UPDATE … RETURNING id` upsert so a cross-process race increments instead of dropping the record (spec §5).
- `src/monitoring/FailureAttributionEngine.ts`: `coerceCategory` allow-list extended to the 3 new categories (so they survive instead of clamping to `unknown`).
- `src/monitoring/FailureAnalyzer.ts`: `RECOMMENDATION_BY_CATEGORY` (a total `Record<FailureCategory,string>`) gains entries for the 3 new categories — **required**, the enum extension fails `tsc` without them (spec §7); and `analyze()` now excludes `status === 'resolved'` records from active clustering (spec §6.1 — implements parent §4.4 M6, specified-but-unbuilt; `reopened` stays IN as it is active again).

## Decision-point inventory

- **Enum: extend vs map?** Extend (additive). The dashboard's `CATEGORY_WORDS`/`TYPE_WORDS` already referenced these labels, so the ledger was out of sync; extending aligns them. TEXT column, no CHECK → migration-free for existing rows.
- **ON CONFLICT vs keep SELECT-then-INSERT?** Kept the in-transaction SELECT-existing fast path (avoids burning a sequence number on the common in-process repeat) AND added `ON CONFLICT … RETURNING id` as the cross-process race belt. `better-sqlite3` transactions are synchronous/serialized intra-process, so the race is cross-process only (rare — machine-scoped DB files); the belt makes it lossless regardless.
- **Occurrence retention: which table, what cap?** Only `failure_occurrences` (the forensic log) is pruned; `failure_records` is untouched. Default cap 200/dedupeKey, configurable. Safe because the analyzer's diversity is set-counted over deduped `failure_records`, never the occurrence table (confirmed in review — `distinctCounts()`/occurrences are unused by the analyzer; flagged as a separate parent cleanup).
- **Analyzer status-filter: exclude what?** Only `resolved` (the enum has no `closed`; `reopened` = active-again, kept in).

## Side-effects analysis

- **Behavioral:** Additive + a correctness fix. The enum extension + coerce + recommendation entries are purely additive (no existing category changes). The analyzer status-filter changes behavior only for `resolved` records (they no longer drive a recommendation — the intended parent §4.4 behavior, previously unbuilt). The `open()` upsert is behavior-preserving for the common path; on a cross-process conflict it now increments rather than fail-open-dropping (strictly better).
- **Schema/migration:** No schema migration. `category` is a TEXT column with no CHECK, so the new enum values store fine and existing rows are unaffected. `failure_occurrences` retention only deletes surplus forensic rows.
- **Security:** No new surface. `coerceCategory` still clamps unknown free text to `unknown`; the new values are server-controlled enum members.
- **Performance:** The occurrence prune is one indexed DELETE per `open()` (idx_occ_dedupe), bounded; net effect is to STOP unbounded growth. The upsert is one statement vs the prior two (SELECT+INSERT) on the new-record path.
- **Reversibility:** Fully reversible by revert; the retention prune is the only destructive op and it only removes surplus forensic rows beyond the cap.

### Commit 2 — the `ci` source + reverse-lookup

Files:
- `src/core/InitiativeTracker.ts`: `findByMergeCommit(oid)` / `findByPrNumber(n)` — exact-OID reverse-lookup via `list()` (TaskFlow-safe; no index needed at scale). Net-new (no reverse lookup existed).
- `src/monitoring/CiFailurePoller.ts` (NEW): the §3.1 `ci` source. `gh run list` arg-array only + `repo` regex-validated; flaky guard (latest run per head SHA; recovered SHAs dropped); per-tick write cap; lease-gated; loop self-exclusion (skip `failure-learning-loop`-origin initiatives); constant `filedBy:'source:ci'`; mapped→automatic(0.9) / unmapped→inferred(0.2)→noFeatureLink; deterministic job-name→category allow-list; `scrubSecrets()` on `detail.full`. Fail-open per-run + per-tick.
- `src/monitoring/FailureLedger.ts`: `countOccurrences()` observability/test hook for the retention cap.
- Tests: `tests/unit/CiFailurePoller.test.ts` (12 — category map, flaky guard, scrub, mapped/unmapped/loop-skip/untrusted-repo/fail-open/cap/lease), `tests/unit/FailureLedger-ingestion-substrate.test.ts` (5 — new categories survive, occurrence retention bounded, upsert increments, analyzer status-filter both sides).

Decision points: CI attribution is exact-OID (headSha→findByMergeCommit) only — pre-merge PR runs that don't map land in `noFeatureLink` (honest; PR-number mapping is a refinement). `gh` runner injected for tests. Flaky guard is batch-local (latest-run-per-SHA), not a per-run `gh run view` (cheaper; sufficient for slice 1).

### Commit 3 — config + AgentServer wiring (CI source goes LIVE)

Files:
- `src/core/types.ts`: `failureLearning.sources` block (ci/revert/regression/regressionIncludesBackslide/degradation[]/ciPollMinutes/ciMaxRunsPerTick), all off by default.
- `src/config/ConfigDefaults.ts`: `sources` defaults (all off) under `failureLearning` — `applyDefaults` deep-merges into existing agents existence-checked (migration parity §8, no surprise activation).
- `src/server/AgentServer.ts`: construct `CiFailurePoller` gated on `failureLearning.enabled && sources.ci` (resolveByMergeCommit via `tracker.findByMergeCommit`, resolveRepo via `git remote get-url origin` → regex; interval/cap from config); start it in the post-listen callback; stop it on shutdown. Loop-origin exclusion is inert in slice 1 (Initiative gains `origin` in slice 2) — noted in-code.
- Test: `tests/unit/CiFailurePoller-wiring.test.ts` (3) — the poller is constructed iff `enabled && sources.ci` (not dead code, not always-on), the silently-stopped-trio wiring-integrity lesson.

## Evidence

- `tsc --noEmit`: clean (confirms the `RECOMMENDATION_BY_CATEGORY` totality is satisfied).
- Slice-1 tests green: 12 CiFailurePoller + 5 substrate + 3 wiring-integrity = 20; existing failure-learning tests unaffected.
- Remaining for slice 1: revert source + tests, agent-awareness, integration/E2E (feature-alive over HTTP + seeded-failure-surfaces), then PR.
- Existing failure-learning tests green after the substrate change: `FailureLedger` (11), `FailureAttributionEngine` (10), `FailureLoop` — 28 passing, no regressions.
- Dedicated slice-1 substrate tests (occurrence retention bounded; ON CONFLICT count=2-not-dropped; analyzer status-filter both sides) land with the test commit.
