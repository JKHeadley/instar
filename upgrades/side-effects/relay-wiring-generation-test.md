# Side-Effects Review — Generation-Aware Relay Wiring Assertion

**Date:** 2026-11-22
**Author:** echo
**Second-pass reviewer:** not required for this test-only correction; existing review-cap restrictions remain in effect.

## Summary of the change

Tier 1: one existing test case changes, with a convergence-report update and this artifact. No runtime file changes. One diagnostic and one corrected-file validation were allocated; no new design review or full manual suite. The reproduced assertion expected unconditional legacy-path interpolation after the approved N73 implementation added strict-generation routing. The revised assertion checks the strict/legacy conditional and the existing manual-redirect policy, retaining the other wiring assertions.

## Decision-point inventory

No runtime decision point is added, modified or removed. This checks the already implemented protocol-path choice in CrossMachineRelayQueue.onePass.

## 1. Over-block

No runtime block/allow surface. A semantically equivalent source refactor can require updating this existing source-wiring test; that limitation is explicit.

## 2. Under-block

No runtime block/allow surface. Source-shape checks alone do not prove transport behavior; the existing signed HTTP and actual-server lifecycle checks plus normal full verification remain required. This correction does not remove or skip any check.

## 3. Level-of-abstraction fit

The existing wiring test continues to check production connection points. Behavioral transport tests remain in their existing suites. No parallel runtime authority is introduced.

## 4. Signal vs authority compliance

No runtime block/allow surface. The regex checks source structure in test code only, not user meaning or agent intent. Reference: [signal vs authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

The same test case remains present, with both path branches required and redirects kept manual for generation-required envelopes. The other four cases and hardcoded-router-path exclusion remain. No shared runtime state, recovery loop or concurrent mutation is introduced.

## 6. External surfaces

No user-facing behavior, operator action, endpoint, configuration, migration, credential, or persistent state changes. The draft verification status changes only after real results; a diagnostic failure is not relabeled as a production defect or flake.

## 7. Multi-machine posture

Repository-local by design: the corrected test ships with source and runs on each verifier checkout. It verifies the shared strict/legacy route choice; no machine identity is hardcoded. No notices, runtime durable state, generated URLs or status/health/capability answers change.

## 8. Rollback cost

Revert this test/artifact delta. No deployment, data migration or agent state repair is involved. Restoring the old assertion also restores the reproduced false failure against the new route selection.

## Conclusion

The captured failure supports a narrow test-only correction. Corrected-file validation passed five of five checks with exit0 at07:56:55.731478Z after enforcing cap1 admission PID11895. Normal full LocalVerify of the new exact head is still required before the draft can advance. No production readiness or full-suite pass is inferred from this artifact.

## Class-Closure Declaration

No prompt, hook, configuration, skill, standards text or self-triggered controller is changed. No agent-authored-artifact defect in the defined class-closure surface — not applicable.

## Evidence pointers

- Exact red merge tree da823ee03253b9c1775d0ac6d6f3d8f6938e775d, head e1bfb93811e88915b4959b9666438b7e56b8a8d7, base22f686b3e821d39173a5351c8a01fc471f323d29.
- /tmp/n73-wiring-diagnostic-2253.log and result.json: four passed, one failed, enforcing admission PID95322, exit1.
- /tmp/n73-wiring-debug.md: actual assertion and root cause. Corrected-file validation /tmp/n73-wiring-corrected-2319.log and result.json: five passed, exit0, enforcing admission PID11895. The validated test file is byte-identical in the candidate and exact-base diagnostic worktrees.
