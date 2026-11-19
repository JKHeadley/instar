# A test that could fail when the computer was too fast

## What this is

One of the automatic tests checks the step where the agent re-registers its Telegram browser. Each registration writes a short fingerprint (a "proof digest") that includes the time it happened, down to the millisecond. The test registers twice and checks that the second fingerprint is different from the first.

## What went wrong

On a fast machine both registrations can happen inside the same millisecond. The time is then identical, so the fingerprints are identical, and the test fails even though nothing is broken. On 2026-11-16 this failed the full test run of an unrelated change (one that only adds two model names to a list) and cost that change a 22-minute re-run.

## What changes

Only the test. Before the second registration it now waits until the clock has moved past the time recorded by the first one, which takes at most a millisecond or two. The product code is untouched: two registrations in the same millisecond describing the same state are allowed to have the same fingerprint, and nothing relies on them differing.

## What keeps it safe

The test still checks everything it checked before: the reviewed build is enrolled, the previous build is kept as the second one, the operator account matches, the browser is closed afterwards, and the fingerprint changes when the time has changed. The wait reads the first registration's recorded time, so it cannot hang: the clock always moves forward.

## What you need to decide

Nothing. It is a test-only correction that removes one source of wrongful failures in the test line.
