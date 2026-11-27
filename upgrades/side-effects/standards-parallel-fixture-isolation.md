# Side-Effects Review — Isolated Standards Drift Fixture

Date: 2026-11-23. Author: Echo. Tier 1: one test plus documentation, one independent review round. A complete unit run exposed a 102/103 article mismatch caused by an adjacent test temporarily editing the real standards document. The test now edits only its own temporary authored document.

## Decision-point inventory
No production decision point changes. The audit still must refuse verification when the source document differs from its packed build. The test asserts that its actual fixture source tree is selected, so a fallback to unrelated source cannot satisfy the refusal.

## 1. Over-block
No production block/allow surface. The audit refusal expectations are unchanged.

## 2. Under-block
The packed metadata is still checked as valid while the separately authored document changes. The test still requires unverified and the specific authored-mismatch cause. Explicit fixture selection and real-document immutability assertions prevent a vacuous replacement.

## 3. Level-of-abstraction fit
The fixture owns the mutable operand. Production source and the shared test checkout should never be rewritten to simulate this input. Unchanged guards are read through temporary symlinks; none is edited.

## 4. Signal vs authority compliance
Reference: docs/signal-vs-authority.md. No new runtime authority, heuristic or detector is added.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point.

## 5. Interactions
Parallel unit files can now read the real source document without observing a temporary extra article. The fixture copies its edited document and links only unchanged evidence. SafeFsExecutor removes the private fixture after the assertion; the real document is never restored because it is never changed. No new retry loop or shared mutation is added.

## 6. External surfaces
Tests and documentation only. No runtime API, standards amendment, live state, notification, GitHub operation or availability claim.

## 7. Multi-machine posture
Test-process-local by design. Each runner creates an independent temporary directory. No status surface, shared state, link or user notice changes.

## 8. Rollback cost
Revert this test correction. No data migration or installed-agent repair is needed.

## Evidence
The complete child-custody unit run passed 74,673 tests and exposed one article-count mismatch in the reader/CLI parity test. Its adjacent stale-build test wrote the shared authored file. The reader suite passed all 38 tests alone, confirming the timing-dependent interaction. The corrected pair is run together and retains the same stale-build refusal, exact fixture selection and unchanged-real-document assertions.

## Conclusion
This removes test interference while preserving the original semantic boundary. Full normal verification is still required before publication.

## Class-Closure Declaration
No agent-authored prompt, hook, config, skill, standards-text defect or self-triggered controller change — not applicable. This is test-fixture isolation.

The corrected adjacent suites passed all 67 tests together. The isolated source uses only guard directories and a synthetic authored-source marker; it does not project package/source identity flags. Normal guarded fixture cleanup passes.
