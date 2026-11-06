# Isolate the undeclared-template test

## What Changed

The declaration check's negative Python fixture now lives in a disposable directory. The test still checks the real source tree before and after and requires the exact checker to reject the undeclared Python file. No source deletion allowance or weaker production check.

## What to Tell Your User

No separate product change. This corrects a verification test; the measurement release notes describe the runtime changes in the same candidate.

## Summary of New Capabilities

None from this test repair.

## Evidence

The full verifier reproduced the previous source-cleanup failure, including an unsuccessful isolation rerun. The corrected focused unit test passes and leaves source untouched. Full suite and release are still pending.
