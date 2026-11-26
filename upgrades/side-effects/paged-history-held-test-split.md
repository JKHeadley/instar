# Side-effects review for the paged-history integration test split

## Summary

This Tier 1 change groups four existing paged-history checks into two integration files. Three cases use the same parameterized privacy callback and the fourth uses the original export callback. The suite name and case timeout remain the same in each file.

## Decision-point inventory

The verifier discovers two files. Each file explicitly registers its assigned cases, and the ordinary scheduler chooses their placement. The assertions inside each callback are unchanged.

## 1. Over-block

No block/allow surface. The test scheduler retains its ordinary admission rules.

## 2. Under-block

The three privacy inputs are assigned exactly once. The held-only export case is assigned once. The raw historical report provides the original four full case names.

## 3. Level-of-abstraction fit

The verifier schedules integration files. A single test helper registers the existing privacy callback against the inputs given by each file, keeping a single copy of its setup and assertions.

## 4. Signal vs authority compliance

The historical report supplied case durations to guide file grouping. It grants no authority to change admission or to declare a verification successful.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Neither the verifier nor the configuration changes.

## 5. Interactions

The fixture creates a fresh graph for each case. Both original callbacks retain their finally blocks, mock restoration and fixture cleanup. The separate-process test resolves its compiled module from the repository working directory, as before. No concurrent registrations or additional child processes are introduced within a file. The new filename initially lacks historical duration, which may influence when the verifier selects it.

## 6. External surfaces

No external surface changes. These integration tests operate on temporary graph state. No agent configuration, production route or user message is altered.

## 6b. Operator-surface quality

No operator surface. The verifier discovers the files without an additional command or setting.

## 7. Multi-machine posture

Machine-local by design. Each verification host runs its own temporary graph fixtures and closes them after each case. The committed test files travel with the source checkout.

## 8. Rollback cost

A revert restores the original four-case file. No persisted user data or installed agent requires restoration.

## Class-Closure Declaration

unbounded-self-action is not applicable. The verifier invokes a fixed set of tests with their existing per-case timeout and cleanup.

## Verification

Allocation 132dd6ce-82d9-4041-a127-1816572afb72 permitted one ordinary two-file run. All four original full test names passed with zero failures, pending cases or unhandled errors. The raw child exit was recorded as zero before report processing. All frozen input digests matched afterward. The file covering detached descendants and independent-process denial took 6.107 seconds. The file covering frozen debt and recipient export took 5.139 seconds. The runner waited 1503.539 seconds for admission and held the slot for 18.478 seconds.

The 174.534-second historical file time came from a full verification run with other workloads. No controlled unsplit run was performed here. Cold and established duration history can lead to different scheduling, and the overall verification runtime benefit remains unmeasured.

## Second-pass review

**Reviewer:** /root/review

Independent source review compared both case callbacks byte for byte, verified all three privacy inputs were assigned exactly once and checked the suite names, per-file timeouts and cleanup. Final artifact and receipt digests are presented separately for independent concurrence.
