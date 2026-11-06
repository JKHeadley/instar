# Isolate the undeclared-template test

<!-- internal-only -->

## What Changed

The declaration check's negative Python fixture now lives in a disposable directory. The test still checks the real source tree before and after and requires the exact checker to reject the undeclared Python file. No source deletion allowance or weaker production check.

## Evidence

The full verifier reproduced the previous source-cleanup failure, including an unsuccessful isolation rerun. The corrected focused unit test passes and leaves source untouched. Full suite and release are still pending.
