# Side-Effects Review — Failure-Learning Loop

**Version / slug:** `failure-learning-loop`
**Date:** `2026-05-26`
**Author:** `echo`
**Spec:** `docs/specs/FAILURE-LEARNING-LOOP-SPEC.md` (converged v4, 3 rounds; approved by justin 2026-05-26)
**Second-pass reviewer:** the 3-round convergence panel (security, scalability, adversarial, integration, lessons-aware) — see `docs/specs/reports/failure-learning-loop-convergence.md`

## Summary of the change

Builds the Failure-Learning Loop (instar-self-hosting dev-process forensics). First slice per spec §5 Q3. This artifact is cumulative across the build's atomic commits; each commit lists the decision points it touches.

## Decision-point inventory

### Commit 1 — FailureLedger spine (the dedicated indexed SQLite store)

- `FailureLedger` (`src/monitoring/FailureLedger.ts`) — **add** — new dedicated SQLite store for failure records. First-class indexed columns (`detected_at`, `category`, `initiative_id`, `build_skill`, `attribution`/`provenance`) per spec §4.2/§4.4 — NOT the TaskFlow `flows` blob (round-3 R3-integ-store decision), so analyzer group-bys are indexed.
- `FailureLedger.open()` — **add** — dedupeKey upsert (§4.2 M5): a repeat increments `occurrenceCount` + logs a bounded occurrence row rather than duplicating. Fail-open (§4.2 m9): storage error logs via `onError` and returns null, never throws into the observed commit/reconciler/route.
- `FailureLedger.update()` — **add** — **mandatory `ifMatch` OCC** (§4.2 M4): a stale version returns `{ok:false, conflict:true}`; no last-writer-win. Caller does bounded retry.
- `FailureLedger.distinctCounts()` — **add** — `COUNT(DISTINCT filed_by/cause_commit)` over the bounded `failure_occurrences` table — feeds the §4.4 source-diversity gate so a single session/commit can never manufacture support.
- `FailureLedger.toApiView()` (static) — **add** — strips `detail.full`; the ONLY record shape permitted across an HTTP boundary (§4.8 C7 — `full` is internal-only, never served by any route).
- Machine-scoped IDs (`FAIL-<machineId>-NNN`) via `failure_seq` table — **add** — prevents cross-machine ID collision (§4.2 M2).

**Over/under-block:** none — this commit is pure storage; no gating, no external calls, no mutation of source files. Reads/writes only its own SQLite DB.
**Level-of-abstraction fit:** sibling to `TokenLedger`/`DegradationReporter` in `src/monitoring/`; reuses `NativeModuleHealer.openWithHealSync` + WAL pragmas exactly as `TokenLedger`.
**Signal-vs-authority:** storage layer only — no authority. (The signal-only analyzer + by-construction authority guard land in later commits.)
**Rollback cost:** trivial — new file + new DB table; disabling the feature flag leaves the table inert.
