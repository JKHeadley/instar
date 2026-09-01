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
