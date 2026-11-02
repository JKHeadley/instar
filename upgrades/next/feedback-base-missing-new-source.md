## What Changed

- The feedback executor now accepts a base-version test failure when the test imports a source file that the proposed fix adds. Vitest reports zero collected tests in that case, but the missing file is the expected proof that the old version lacks the fix. The checker still rejects an unrelated missing import, a nonexistent test file, and a proposed fix whose named test never passes.

## What to Tell Your User

A feedback fix will no longer be discarded just because its test uses a new source file that does not exist in the old version. The fix still has to pass its test on the proposed version and clear review.

## Evidence

- The recorded Vitest failure shape is covered by a unit test, alongside unrelated missing-file and generic zero-test cases. The full unit rerun passed 55,549 tests.
- Full unit, integration, and end-to-end checks are required before merge.

## Summary of New Capabilities

None. This corrects the existing feedback proof gate.
