# Alignment scoring refuses malformed confidence

## What Changed

Decision-journal confidence is now normalized and validated before persistence.
Numeric strings become numbers; qualitative labels, non-finite numbers, and
values outside zero through one are refused. Existing invalid rows produce an
explicit unassessable alignment result rather than JSON nulls beside a failing
grade. Drift averages now carry an honest nullable value and their valid/invalid
sample counts.

## Evidence

- 94 focused unit and integration tests pass.
- TypeScript typecheck and diff validation pass.
- Removing the non-finite grade floor reproduces the assessed failing verdict.
- Removing route validation makes the exact refusal contract test fail.
- Existing qualitative rows are fixture-tested through the real alignment API.

## What to Tell Your User

Alignment reports no longer turn malformed confidence data into a confident
failing grade. New journal writes must use a numeric zero-to-one confidence
value, and older qualitative values are reported as unmeasurable rather than
silently assigned a number.

## Summary of New Capabilities

- Honest `N/A` alignment state for a non-empty but unmeasurable journal.
- Numeric confidence normalization and validation at the journal write boundary.
- Explicit valid and invalid confidence counts in drift windows.
