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

## CI5 test-harness correction

The rendered-summary contract now ignores ANSI terminal decoration before applying its unchanged
requirements: it must contain `Checks 1 failed` and must not contain `Tests 1 failed`. A deterministic
ANSI fixture covers the CI failure shape, and a separate wrong-wording control proves the assertion
still fires when the wrapper violates that contract. The structured production classifier is
unchanged. Final focused proof against the restored bytes passed all 9 tests on Node 22; both negative
controls were separately observed red before restoration.
