# Local Verify keeps the next test slot between queued checks

<!-- bump: patch -->

## What Changed

On the default one-suite host, Local Verify now keeps its short priority claim while one verifier holds the slot if another local check is runnable. The claim uses the same queue admission decision as a normal start, so a pause, hold, remote reservation, or empty queue releases it. Hosts where both the server and verifier child can run more than one suite still leave spare capacity to other full suites. Production wiring reads both effective caps.

## What to Tell Your User

When several changes are waiting for merge checks on a one-slot machine, a regular full test run can no longer slip between two checks. The merge line keeps its place while the current check finishes. Small targeted tests remain available, and a machine with extra full-test slots can still use them.

## Summary of New Capabilities

- The next queued merge check keeps the one-slot machine's priority reservation through the current check.
- The reservation follows the live queue decision and the machine's actual suite capacity.

## Evidence

A regression test reproduced the lost reservation before the fix. After the fix, 119 Local Verify unit tests, 13 HTTP integration tests, and 13 production lifecycle tests passed. TypeScript build passed. Full-suite and CI verification remain release gates.
