# Side effects: feedback executor named-test proof

## Summary

Tier 1, narrow and reversible. The existing feedback executor proof gate rejects successful Vitest processes that selected zero tests. The build prompt asks for an exact test-name run. This changes no API shape, persistent schema, or published fix by itself.

## Decision-point inventory

The only changed decision is the executor's existing pre-publication failing-then-passing proof. It already required base failure and head exit code zero. It now also requires a nonempty head test summary and distinguishes a passing base test from an empty selection. No message, session, credential, or merge authority changes.

## 1. Over-block

An alternate Vitest output format without a readable `Tests N passed` summary is rejected on the head check even when the process exits zero. Every summary-shaped line must show a positive pass count, so an all-skipped real summary cannot be overridden by a fake positive line printed by test code on stdout or stderr. A spoofed zero line can cause a false rejection; that is a deliberate fail-closed outcome for a publication proof gate. The base check still allows an assertion failure or a missing newly introduced source export, as before. Unit cases cover ordinary, ANSI-colored, all-skipped, conflicting, and summary-free output.

## 2. Under-block

The count proves that at least one named test executed. It cannot prove the test actually captures the reported bug; the pre-existing base-fail/head-pass comparison and independent review remain the authorities for that. Multiple test-file groups share the named pattern, and a positive aggregate count does not prove every file ran a test. The build prompt narrows this by asking for one exact regression name; the test-run proof remains the same published gate.

## 3. Level of abstraction

Vitest output parsing lives in `executorSession.ts` beside the existing base-failure classifier. `FeedbackExecutorService.verifyFix()` calls it at the head boundary before lint, review, or publication. The same parser distinguishes an empty base run from a passing base run. No repository-wide test runner or unrelated CLI is changed.

## 4. Signal vs authority

The Vitest summary is a process-output signal, which test code can contaminate. The parser checks every summary-shaped line and fails closed on any zero-execution or ambiguous summary. The existing executor publication gate remains the sole authority. In this constrained domain, zero executed tests cannot satisfy a failing-then-passing proof; the new signal only tightens that existing gate.

## 4b. Judgment-point check

There is no discretionary judgment in whether a named test actually ran. Ambiguous output fails closed and leaves the item in the existing retry/hold flow. Independent review still judges whether a proposed fix addresses the feedback report.

## 5. Timing and feedback loops

Parsing is in memory and adds negligible time after each test process. Rejected attempts consume the existing bounded retry budget and are reported with a precise reason. The prompt's exact-name instruction may increase successful proof yield, but cannot bypass the gate.

## 6. External surfaces

The executor status and audit reason can now say `base-check:test-not-found-at-base` or `head-check:test-not-run-at-head` for empty runs. No new operator action, external service call, or dashboard surface is added. Failed attempts remain held under the existing policy.

## 7. Multi-machine posture

This is package code deployed per machine. Each machine's executor uses the same parser, while the existing owner epoch and shared drain store continue to prevent duplicate attempt authority. No new machine-local state or cross-machine message is introduced.

## 8. Rollback cost

A package revert restores the prior classifier and prompt. There is no data migration. Attempts rejected by the stricter check remain ordinary failed attempts under existing policy and can be retriaged through that policy.

## Conclusion

The change closes a concrete empty-test proof gap and preserves the existing publication chain. Focused unit service tests pass 140/140; integration and production lifecycle checks are queued behind the shared suite lane. The branch remains unmerged until all required gates pass.

## Second-pass review

Concern raised on first pass: a fake positive summary on stderr could override a real all-skipped summary when only the last line was read. The parser now evaluates every summary-shaped line, and a service regression includes conflicting stdout/stderr. Reviewer re-review: “Concur with the revised review”; no further blocker. Residual: readable Vitest summaries are required and the aggregate proof does not establish a run in every listed file.

## Evidence pointers

Live attempt `feedback-e4ee9e0a-d860-4825-b11d-2c18987d11dc:a2` recorded 33 skipped tests and zero executed in `/feedback-factory/execute/status` `lastCheckFailure` at 2026-10-28 09:35 UTC. Focused source tests: `tests/unit/feedback-factory/execute-units.test.ts` and `execute-service.test.ts`.

## Class-Closure Declaration

Closure class: a successful Vitest process that selected no named regression test. Base and head checks now both reject that class; conflicting summary lines also reject. The existing failing-then-passing and independent review gates continue to handle whether a running test actually proves the feedback fix.
