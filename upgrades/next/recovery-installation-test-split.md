<!-- internal-only -->
# Recovery installation test file split

## What Changed

Split the seventeen recovery installation lifecycle cases across two serial integration files while preserving every test body and independent fresh fixtures. No runtime behavior, verifier limits or timeouts change.

## Evidence

Executed collection matches all seventeen original case identities exactly once, including the three identity-table rows. The focused two-file run passed all 17 tests, skipped none, recorded zero unhandled errors, and exited zero. File times were 39.140 and 47.103 seconds; total file time 86.243 seconds. The ordinary admission wait was 1658.974 seconds, separate from 92.655 seconds after admission. Independent source review found no blocking concerns.

No fresh original unsplit baseline or complete-gate speedup was measured. On cold duration history, the new file is priced at 10 seconds and may run in the sequential first part before rest lanes; the first full gate can therefore be slower. No history or policy was changed. The normal complete exact-head gate remains separate.

## What to Tell Your User

None — internal change with no user-facing surface.

## Summary of New Capabilities

None — internal change with no user-facing surface.
