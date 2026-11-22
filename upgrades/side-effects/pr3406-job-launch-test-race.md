# Side-Effects Review — Job launch E2E timing repair

**Version / slug:** `pr3406-job-launch-test-race`
**Date:** 2026-11-21
**Author:** echo
**Second-pass reviewer:** not required

## Summary of the change

The job launch end-to-end test now waits until the mock CLI's `--effort low` arguments are visible in its argv log before asserting their count. The old wait ended as soon as the log marker appeared, which could precede the later argv bytes under load. Only test timing changes; the server and job launch behavior do not change.

## Decision-point inventory

The test's readiness condition changes from marker presence to the complete required argument pair. No runtime decision point changes.

## 1. Over-block

The test still fails if the launched process does not receive `--effort low`; this is the intended contract. No legitimate runtime input is blocked.

## 2. Under-block

The test does not cover every possible CLI argument combination. The other job launch tests cover the separate launch-record decisions.

## 3. Level-of-abstraction fit

The readiness wait belongs in the test fixture. There is no production scheduler or CLI change.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md). The change has no runtime block or allow surface.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point.

## 5. Interactions

The test reads one temporary argv log while a mock process writes it. Waiting for the complete argument pair closes the read/write race. No shared production state or feedback loop changes.

## 6. External surfaces

No external or operator-facing surface changes. No persistent state or API changes.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Replicated through source control: every test machine runs the same readiness condition. No notices, durable runtime state, URLs, or status surfaces change.

## 8. Rollback cost

Revert this test commit. No migration or agent state repair is needed.

## Conclusion

The test now waits for the evidence it actually asserts. Three targeted runs passed after the change. Clear to verify in Local Verify.

## Second-pass review (if required)

Not required; no runtime decision or agent behavior changed.

## Evidence pointers

- `/tmp/pr3406-e2e-fixed-1.log`
- `/tmp/pr3406-e2e-fixed-2.log`
- `/tmp/pr3406-e2e-fixed-3.log`
