# Side-Effects Review — Agent-Connection Registry Test Isolation

## Summary and decision points

This changes only tests/unit/agent-connector.test.ts. The production writer’s module-load path selection and entry/update/heartbeat behavior remain unchanged. The historical test backed up, removed and restored the actual home registry. Each corrected case owns a temporary home and captures a fresh real writer during private module evaluation. The runner and subsequent writer calls use the restored ordinary environment.

## Over-block and under-block

No production block/allow surface changes. Private-path failures fail the unit fixture instead of trying the actual registry. The new two-home regression verifies both complete registry bodies and mutual independence. These checks do not claim to repair other test files; the parent separately tracks Discovery’s import-time lock-path fixtures.

## Level of abstraction and signal versus authority

The defect is fixture state ownership. Fixing the test’s module initialization preserves the production function and requires no new configuration seam. Refer to docs/signal-vs-authority.md: the assertions are deterministic fixture invariants, not a production information-flow authority. No account, admission or registration policy is changed.

## Interactions and fault handling

The helper clears the module cache, temporarily sets HOME and USERPROFILE, imports the real module, and restores each original value in finally, including deleting values that were originally absent. It resets the cache after restoration so temporary-home dependencies cannot become cached ordinary module state. AgentConnector’s imported graph defines classes/functions; it starts no home-bound daemon during evaluation. The returned writer alone retains its private graph. Cases are serialized in this file; no concurrent environment mutation is introduced. Cleanup removes only the owned temporary root. The original validation, bounded Git probes and unreachable .invalid clone case remain in the complete file. The existing outer global setup strips routing variables and isolates CODEX_HOME but leaves HOME and USERPROFILE unchanged; normal runner admission remains in force.

## External surfaces and operator quality

No product/API, installed configuration, live registry, account or operator-facing action changes. The test does not read the actual registry for a byte comparison. It creates small private JSON fixtures and deletes only those fixtures. Release text describes the isolation repair without a live-release or full-suite claim.

## Multi-machine posture

Machine-local by design: temporary test directories belong to their worker and require no replication. The source change travels through normal checkout. No durable agent state, notices, channels or generated user URLs are introduced.

## Rollback

Revert the unit-fixture change. No migration, live registry restoration or restart is required. GitHub publication belongs to the Chief of Staff and complete verification belongs to throughput.

## Verification

Source and focused-plan review concurred before execution. Under coordinator allocation 113b5946-8f01-462e-9c2b-ae5d07d424ba, the sole entire-file unit invocation passed all 33 tests with zero failures, zero skips, zero recorded unhandled errors and exit 0 in 17.489 seconds. The two-private-home regression passed. Raw JSON, combined output, reporter data and result metadata are preserved under .instar/state/build. The historical unsafe baseline was deliberately not run. Complete exact-head verification remains a separate coordinator-owned gate; no complete-green or live-recovery claim is made.

## Second-pass review

**Reviewer:** /root

The parent independently reviewed the one-file candidate and frozen manifest b4d0db550bc7dad962aad7dadec84f1f3e725af69579c7a31e34e3cd1f19731f before execution. This final artifact is frozen after the actual focused result. Its separate final read, digest-bound concurrence and fresh trace are recorded with the candidate before commit; no concurrence over unread bytes or retrospective change to old review evidence is claimed.

## Class-Closure Declaration

unbounded-self-action: n/a. This is an explicitly invoked test fixture and teardown, with no self-triggered retry, recovery loop, installed prompt or production controller change.
