<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Parked-test rechecks now classify completed runs from Vitest's structured JSON report rather than
matching human summary wording. Genuine pass, genuine failure, and runner/report errors remain
distinct, with reason-bearing details for unknown outcomes. The command remains signal-only,
always exits zero, and never edits the quarantine or gates a push or merge.

## Evidence

- A pre-fix control showed a real failing test becoming `could-not-run` when only `Tests` changed
  to `Checks` in the rendered summary.
- Final focused proof passed all 8 controls, including altered-wording failure, genuine pass,
  absent runner, and unparseable structured report.
- TypeScript, destructive-operation containment, production missing-only smoke, syntax, patch
  hygiene, and the instar-dev Tier-1 gate passed.
