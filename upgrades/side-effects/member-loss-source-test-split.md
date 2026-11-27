# Side-effects review for the member-loss integration test split

## Summary

This Tier 1 change moves a complete suite to a second file and extracts the shared fixture. It preserves the source-inventory suite, bounded-reader suite and interrupted-runtime suite.

## Decision-point inventory

The verifier discovers two integration files. The existing scheduler chooses when each file runs. Test registration, case timeouts and individual assertions are unchanged.

## 1. Over-block

No block/allow surface. Both files use the existing admission path.

## 2. Under-block

The complete suite bodies match their originals byte for byte. The original 36 expanded case identities are the comparison set for the focused run.

## 3. Level-of-abstraction fit

File-level scheduling is already available. The change partitions suites along their existing fixture and behavior boundaries.

## 4. Signal vs authority compliance

The historical timing is a measurement that informed the partition. It grants no execution authority. The verifier retains admission and execution control.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. No scheduler threshold changes.

## 5. Interactions

Each file imports the shared fixture that imports the runtime test helper. The runtime helper registers teardown when loaded and closes the resources created by its worker. Each case calls the same fresh fixture setup. The moved suite retains its test timeout and existing mock restoration. The absence of a history entry for the new filename can affect the first complete verification differently from later runs.

## 6. External surfaces

No external surface changes. The only affected processes and files belong to local test execution.

## 6b. Operator-surface quality

No operator surface. No human action or new setting is needed.

## 7. Multi-machine posture

Machine-local by design. Each test owns its temporary graph runtime on the verification host. The fixture and tests travel with the repository.

## 8. Rollback cost

A single commit revert restores the original file. No persistent data or installed configuration needs restoration.

## Class-Closure Declaration

unbounded-self-action is not applicable. The test runner invokes finite test cases and their teardown.

## Verification

Under allocation f26f16f8-4fdc-4f35-9993-0c79d88f5efe, the two-file invocation ran once. The Vitest JSON report marked all 36 original cases passed, with zero pending, skipped or unhandled errors. The executed full names exactly match the frozen baseline. The reader file took 34.227 seconds and the source file took 33.038 seconds. The invocation waited 1872.230 seconds for admission and held the test slot for 77.313 seconds. All source digests still matched after execution.

The Python receipt writer exited 1 while parsing a UTC timestamp after the Vitest process finished. It had not persisted the child exit code. The recovered receipt uses the original Vitest report, unhandled-error report and the test process's admission events. The Vitest success flag and case counts are established. The numerical child exit is unknown.

The 168.140-second historical comparison came from a full verification. This focused run does not establish a full-gate speedup. The first complete run with the new path and a later run with both paths in duration history provide the cold and warm measurements.

## Second-pass review

**Reviewer:** /root/review

The independent source review matched all original non-import top-level statements, allowing the fixture export and the duplicated per-file timeout, and verified teardown registration. The final artifact and receipt are available for a separate digest-bound review.
