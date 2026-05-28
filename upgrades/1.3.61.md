# Upgrade Guide — vNEXT

<!-- bump: minor -->

## What Changed

First automatic feed for the Failure-Learning Loop (spec `docs/specs/FAILURE-LEARNING-INGESTION-SOURCES-SPEC.md`, converged + approved). Until now the loop's ledger could only be filled by hand; this adds the **CI-failure source** so failed CI runs land in the ledger on their own — plus the shared groundwork the rest of the ingestion sources will build on. Ships behind `monitoring.failureLearning.sources.ci` (default **off**); when off, nothing changes.

The CI source is a background poller that lists recent CI runs via `gh` (arg-array only; the repo is parsed from the git remote and strictly validated), files the genuinely-failing ones into the ledger, and is careful about it: a flaky run that later passes on re-run is dropped (not filed as a process failure); attribution is exact-commit (a run's head SHA → the matching feature) or else "best guess / not linked"; it is rate-budget-friendly (polls once per fleet on the lease-holder, on the ~6h reconciler cadence) and fail-open (a missing/unauthed `gh`, a rate-limit, or bad output just skips the tick).

Shared groundwork in this release (all additive): three new failure categories (`build-failure`, `test-failure`, `regression`) so CI/revert/regression failures are no longer collapsed to "unknown"; a bounded forensic log so the occurrence table can't grow without limit; an upsert so two processes racing to record the same failure increment a count instead of dropping one; and the analyzer now excludes already-resolved failures from its active pattern-finding (a requirement the parent spec named but had never actually been built).

This is **part 1 of 2** for the first slice — the revert source (catching when a change is undone) follows in a companion PR.

## What to Tell Your User

- The failure-watching system can now notice failed CI runs on its own — no more empty notebook waiting on hand-entered problems. It's off until switched on, and even then it just quietly records (no alerts).
- It's careful: a test that fails once and passes on a retry doesn't get logged as a real problem, and it can't be fooled into mis-filing by a branch name.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| CI-failure ingestion source | Set `monitoring.failureLearning.sources.ci: true` (needs `gh` installed + authed on the machine) |
| New failure categories | Automatic — build/test/regression failures now categorize instead of collapsing to "unknown" |
| Bounded occurrence log + race-safe upsert | Automatic — keeps the ledger's forensic table bounded and never drops a raced write |

## Evidence

- 20 tests green: CiFailurePoller (12 — category mapping, flaky guard, secret-scrub, mapped/unmapped/loop-skip/untrusted-repo/fail-open/per-tick-cap/lease-gate), substrate (5 — new categories survive, occurrence retention bounded, upsert increments, analyzer status-filter both sides), wiring-integrity (3 — the poller is constructed iff `enabled && sources.ci`, never dead code).
- `tsc --noEmit` clean; existing failure-learning tests unaffected.
- Spec converged over 3 code-grounded review rounds (report: `docs/specs/reports/failure-learning-ingestion-sources-convergence.md`); side-effects review: `upgrades/side-effects/failure-learning-ingestion-sources.md`.
