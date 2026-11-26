# Feedback Worker Test Proof — Plain-English Overview

A feedback worker must show that a reported bug is real before proposing a fix. It writes a focused test, runs that test against the old code, and then shows the same test passing after the repair. The executor checks the old-code result so a broken test setup cannot masquerade as proof of a bug.

A recent high-priority SecretStore worker reached that check and stopped. Its test called the broken operation directly, so the old code threw an error. The executor correctly required a failed test assertion for existing behavior, but the worker's instructions only said to make a “failing test.” That wording did not tell the worker how to express a thrown error as an assertion.

This small change makes the instructions explicit: for existing behavior, the old code must fail a Vitest assertion; if the defect throws, the test should assert the desired behavior, such as that the operation does not throw. The existing narrow exception remains for a genuinely new source file or export that does not exist in the old code. A prompt contract test checks the wording so the instructions do not drift away from the executor's proof rule again.

The executor's decision rule, independent code review, and merge checks stay in place. If the wording causes problems, a normal patch can revert it. The practical goal is to let the next worker attempt produce valid evidence and continue to review without weakening the proof check.
