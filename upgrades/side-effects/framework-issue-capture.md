# Side-Effects Review — Stage-B auto-capture + funnel (Mentor System §19.2)

**Spec:** `docs/specs/FRAMEWORK-ONBOARDING-MENTOR-SPEC.md` (converged 5 iters, approved by Justin)
**Change:** Adds the Stage-B auto-capture entry point `FrameworkIssueLedger.captureRun()` + a
`framework_capture_runs` funnel table + `captureStats()` + a read-only route
`GET /framework-issues/capture-stats`. Builds on §19.1 (the ledger foundation, PR #405).
**Files:** `src/monitoring/FrameworkIssueLedger.ts`, `src/server/routes.ts`,
`src/server/CapabilityIndex.ts`, `tests/unit/FrameworkIssueLedger.test.ts`,
`tests/integration/framework-issues-routes.test.ts`,
`tests/e2e/framework-issue-ledger-lifecycle.test.ts`, `upgrades/NEXT.md`.

## Principle check (Phase 1)

Does this involve a decision point that gates info flow / blocks actions / constrains behavior?
**No.** `captureRun()` is the write-path the mentor tick will call after forensics — it records
findings and logs the run. It holds no blocking authority. The capture-stats route is read-only
observability. Signal-only. The decision-bearing components (Stage A, the job, graduation) are
§19.3–5.

## The seven questions

1. **Over-block.** None. `captureRun` writes whatever findings it's given (validated against the
   same enum allowlists as `recordObservation`); it rejects only structurally-invalid findings
   (bad bucket/severity), which is correct.

2. **Under-block.** The funnel is the explicit guard against the under-detection failure mode it
   exists for: a run that writes nothing is still logged, so an inert/broken writer (runs climbing,
   observations flat) is visible. It does not *interpret* that signal (no alerting yet) — surfacing
   is via the read-only route; an alert/threshold is a later concern (§19.5 observability surface),
   not under-blocking here. There is still no public write route, so no untrusted-write surface.

3. **Level-of-abstraction fit.** `captureRun` lives ON the ledger (not a separate DI component)
   because better-sqlite3 has no nested transactions and the capture is a thin orchestration over
   `recordObservation` + `suggestRegressions` + a run-log insert. One atomic entry point for the
   tick to call is the right seam; a separate service would add wiring with no benefit.

4. **Signal vs authority.** Compliant. `captureRun` writes signal; regression candidates are
   *surfaced, never auto-linked* (the writer doesn't get to decide a regression — §13.5). Promotion
   and graduation authority stay with the human (§6/§8).

5. **Interactions.** `captureRun` calls `recordObservation` per finding (each its own txn — no
   nested-transaction violation), then writes one `framework_capture_runs` row. Episode-collapsing
   in `recordObservation` already prevents double-counting across runs, so re-observing the same
   open issue next tick does not inflate `observationsWritten`. The funnel table is independent of
   the issues/observations tables — no shadowing.

6. **External surfaces.** One new read-only route (`/framework-issues/capture-stats`) behind the
   standard Bearer middleware, added to the existing `frameworkIssues` CapabilityIndex entry (no
   new prefix → no discoverability-classification gap). No agent-facing template change needed
   beyond §19.1's. No timing/conversation-state dependence.

7. **Rollback cost.** Low. Still dormant — no production caller until the mentor job (§19.4). The
   `framework_capture_runs` table auto-creates at startup (idempotent `CREATE TABLE IF NOT EXISTS`)
   and is harmless read-only data. Back-out = revert; the table can stay or be dropped.

## Phase 5 — second-pass

**Not required.** Read-only observability + a signal-only write-path; no block/allow, no
session-lifecycle, nothing named sentinel/guard/gate/watchdog. The spec passed full convergence.

## Testing

- Tier 1 (unit, +6 = 28 total): captureRun writes findings + reports summary; **every run logged
  to the funnel including a zero-finding run** (inert-writer guard); no double-count across runs;
  regression candidates surfaced not auto-linked; per-framework funnel breakdown; enum guard.
- Tier 2 (integration, +2 = 11 total): `/framework-issues/capture-stats` 503 + 200-with-funnel.
- Tier 3 (e2e, +1 = 7 total): a real capture run surfaces in the funnel route on the live server.
- Affected push-config suite (vs JKHeadley/main): 842 + 299 capability tests green, no regressions.
