# Side-Effects Review — Shared Local History Child Custody

Date: 2026-11-23. Author: Echo. Tier 2 under docs/specs/local-history-native-contract.md. This adds one process-held combined worker lane, connects it to the real parser fork, and updates its real-process fixtures. Independent review covered crash races, storage accounting architecture, private-file boundaries and test integrity. Disk reservations and the complete native workflow remain active work in topic 143810; this component does not advertise an import action.

## Decision-point inventory
A parent acquires the fixed admission database transaction before spawning. Parent and child hold actual shared read transactions on the current custody generation. A replacement must acquire EXCLUSIVE custody before rotating the generation. The fixed parser acknowledges readiness only after it holds matching custody; private source bytes are sent afterward. No timeout or PID-existence heuristic can reclaim the lane.

## 1. Over-block
A live or paused holder keeps the lane busy even if its parent has died. That is intentional conservative resource policy, not proof the holder is authorized to continue. Unsupported private storage, unsafe database files or unexpected WAL mode refuse admission. Separate state directories remain independent.

## 2. Under-block
Custody alone does not grant owner admission, source-file access, a mutation permit or disk space. Current authorization checks, the parser deadline and termination sequence remain in force. This component does not clean artifacts or erase reservations when a lock disappears. Disk disposal must independently prove owned resources gone before releasing accounting. Same-user hostile rewriting of the private storage namespace is not a new trust boundary.

## 3. Level-of-abstraction fit
Two fixed SQLite databases separate serial parent admission from shared child liveness. This uses the existing private namespace and SQLite close registry. The parent holds serial admission across generation commit and shared-lock acquisition, avoiding a transition gap. An old late-start child checks the current generation and refuses after a successor has taken the lane. The custody database is never unlinked or replaced to clear a lock.

## 4. Signal vs authority compliance
Reference: docs/signal-vs-authority.md. Actual transaction ownership and exact generation matching are enumerated resource/idempotency invariants, not judgments about message meaning. No conversational authority or brittle intent filter is added.

## 4b. Judgment-point check
The initial single-lane scheduling policy is declared in the approved contract. It bounds concurrent importer workers; it does not assert that the machine can run only one process. Busy preserves the caller’s independent operation authority. No new competing-signals heuristic is introduced.

## 5. Interactions
SQLite DELETE journal mode is required because WAL readers would not exclude a replacement writer. Both parent and child execute SELECT after BEGIN to hold real shared locks. Admission attempts use zero busy timeout. Parent release cannot free a surviving child’s shared holder. The fixed child closes SQLite synchronously on process exit, since the fork does not inherit server shutdown handlers. Parent cleanup still waits for actual child exit and output disposal before releasing its lease. Existing direct-worker fixtures now acquire real custody and await exact ready; malformed-input cases therefore reach parser validation instead of passing at missing custody.

## 6. External surfaces
No endpoint, native action, capability, setting or user-visible feature is enabled. The worker receives only a trusted server state-directory/generation descriptor through its private startup environment; source provenance and selected bytes still arrive exclusively on stdin after readiness. No private input or SQLite exception is emitted in diagnostics. Fixed database and sidecar names use existing inode-alias denial and private namespace exclusions.

## 7. Multi-machine posture
Machine-local by design: the lane protects workers and files on the destination state directory. A different machine has independent resource admission and cannot infer authority from this lock. No status, health, channels, capabilities, notification or URL surface changes. The protected paths remain excluded from shared state, backup and file serving.

## 8. Rollback cost
The native action remains dark. Revert parent/child protocol and helper together; never deploy one side alone. Preserve custody files while holders may exist. No archive-state migration or cleanup is required. Do not delete a lock database to unblock a live process.

## Evidence
Actual tests cover parent SIGKILL while an orphan child still holds custody, recovery only after that child exits, late-generation refusal, WAL refusal without changing mode or generation, no creation by a missing-run child, redirected-file rejection, independent destinations and the real parser handshake. Fourteen real parse-job tests and nine direct fixed-worker tests cover success, refusal, disconnect, timeout, revoked authority and cleanup. The previous direct-worker fixture produced two failures before it adopted custody; the corrected suite passes with real leases. Full verification remains required before release.

## Second-pass review
Crash reviewer confirmed no remaining concrete finding. Test-integrity review required the WAL negative neighbor and non-vacuous direct-worker admission. Security review required the synchronous SQLite exit finalizer. The fixes are included and targeted checks are run by the primary agent; reviewers reported source review only.

## Conclusion
The shared child lane is a supporting resource component. Its lock can prove that holders have exited; it does not prove disk cleanup, grant permission or complete the native import flow. Those remaining operations stay tracked by topic 143810 and the approved contract.

## Class-Closure Declaration
No agent-authored prompt, hook, config, skill, standards-text defect or self-triggered controller change — not applicable. This helper reacts to explicit admission and process lifetime; it introduces no autonomous retry, reclaim or kill loop.
