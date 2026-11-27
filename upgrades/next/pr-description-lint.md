# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

Every pull request, whatever branch it targets, now gets an early-warning check of its description. It runs the same checks safe-merge runs at merge time (plain-language ELI16, decision records, release note) plus the UX Impact rule, and warns without blocking. Stacked pull requests used to meet these refusals only at merge time, after a full verifier run.

## Evidence

`tests/unit/pr-description-lint.test.ts` (13 tests) covers verdict parity with safe-merge's runLocalBodyChecks on both sides, the never-blocking CLI, and the workflow's any-base, read-only, default-branch properties.
