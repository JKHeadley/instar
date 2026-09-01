# Window-Lifecycle Engine Calibration Fixes

<!-- bump: patch -->

## What Changed

Four calibration defects in the window-lifecycle obligation engine, each
live-verified during Window 30 of the Echo governance work, are fixed
(PR #1998):

1. `POST /window-lifecycle/compile` no longer mutates the live ledger
   without protection: the store backs up the existing ledger before any
   overwrite, and the route supports a `preview`/`dryRun` compile that
   saves nothing (the 2026-08-30 comparison-compile clobber class).
2. Runtime trigger state for duty-keyed commitments now derives from a
   valid `checkInAt` OR `nextUpdateDueAt`, so commitments created through
   the standard route can actually arm trigger-gated duties. Check-in
   reminder semantics are unchanged.
3. Recurring cadence duties compile with a 15-minute default grace
   (`RECURRING_DUTY_DEFAULT_GRACE_MS = 900000`) instead of `graceMs: 0`,
   which made the whole class structurally unsatisfiable — a completion
   could never legally postdate its own instant.
4. The required-duty catalog's source patterns are widened so a plainly
   written approved window charter compiles as approved (48/48 required
   duties matched against real charter language) — no post-approval
   compiler-shaped annex or derivative rendering needed.

Engine enforcement posture is unchanged (watch-only stays watch-only).

## What to Tell Your User

- "The window-lifecycle checker got four bug fixes: compiling can no longer
  clobber its live record, its duty triggers work with normally-created
  commitments, repeating duties now have a realistic grace window, and a
  plainly written approved charter compiles as approved."

## Evidence

Each defect was reproduced live on Echo's Studio during Window 30 before the
fix, and each fix was verified against the same live-derived scenarios in the
PR #1998 test additions:

- Compile clobber (before): a comparison compile of an old window re-saved
  `.instar/window-lifecycle/ledger.json` in place and contaminated the live
  W29 record (obligation count 139→141, no backup existed to restore;
  disclosed in the Window 30 lane log). After: the production-wiring e2e
  asserts a `preview:true` compile writes nothing and a normal compile
  creates `window-lifecycle/backups/ledger.*.pre-compile.*` before saving.
- Trigger mismatch (before): a live duty-keyed commitment (CMT-217) held a
  server-written heartbeat yet reported `triggerEnabled:false` /
  `durableTriggerState:false` because only `checkInAt` was consulted and
  the creation route stores `nextUpdateDueAt`. After: unit coverage asserts
  trigger state derives from either field.
- Zero grace (before): eight consecutive real 30-minute stall-check
  instants with delivered completions were all refused because
  `graceMs: 0` requires proof to predate its own instant. After: recurring
  duties and materialized cadence instances compile with the 15-minute
  default, asserted in the ledger unit suite (141 tests).
- Compiler contract (before): the approved Window 30 charter failed
  `uncompiled-operative-duty:preground.native-structural-preflight` and the
  window had to run on a disclosed derivative rendering. After: the actual
  approved Window 31 charter file compiles from built dist with
  `requiredMatched: 48/48`, `compiledObligations: 75`,
  `materializedObligations: 132`.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Non-destructive compile preview | `POST /window-lifecycle/compile` with `preview: true` (or `dryRun: true`) returns the compiled ledger without saving |
| Automatic pre-compile backup | No action needed — every normal compile backs up the existing ledger to `window-lifecycle/backups/` first |
| Duty triggers from standard commitments | Duty-keyed commitments created with `nextUpdateDueAt` now arm trigger-gated duties (no manual `checkInAt` needed) |
| Realistic recurring-duty grace | Recurring cadence duties compile with a 15-minute grace window by default |
| Approved charters compile as approved | Write window charters in plain approved language — the required-duty catalog matches it directly |
