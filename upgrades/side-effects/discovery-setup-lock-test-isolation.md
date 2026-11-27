# Side-Effects Review — Discovery Setup-Lock Test Isolation

## Summary and decision points

This test-only change adds tests/helpers/privateDiscoverySetupLock.ts and replaces the two setup-lock fixture scopes in Discovery.test.ts and discovery-pipeline.test.ts. No production source, path policy, PID/liveness behavior or runner configuration changes. The production module binds LOCK_PATH when imported, so changing the home lookup afterward did not isolate the original functions. The corrected loader returns only real lock functions evaluated under an owned temporary home.

## Over-block and under-block

No production block/allow surface changes. Missing lock, repeated deletion, parent creation, corrupt JSON, update and persistence checks remain. The corrupted-file case now addresses the same private path as the real reader, and checks that corruption remains unchanged rather than being silently removed. A new two-home regression checks both real file bodies, deletes one and verifies the other survives. No unsafe historical baseline, real-lock read for comparison, backup, overwrite or cleanup is performed.

## Level of abstraction and signal versus authority

The defect is test-state ownership, so the repair belongs in fixture initialization rather than a new production home override or lock policy. Refer to docs/signal-vs-authority.md: private-file assertions are fixture invariants, not a production information-flow authority. No new competing-signals judgment or static production gate is introduced.

## Interactions and fault handling

The helper resets Vitest module cache, scopes os.homedir while importing the real module, restores the exact prior function in finally and resets the temporary cache afterward. Only the three returned functions retain their captured private LOCK_PATH. No imported module starts a home-bound background service at evaluation. Unit lock calls use the restored ordinary home lookup. The integration fixture retains its existing case-wide private home for actual filesystem discovery, while its lock functions separately capture the same private home. Its afterEach restores the original lookup and removes only the owned directory; it no longer calls an actual-home captured delete. Test cases are serialized within each file. Unit files use normal separate workers; integration retains its existing file-serial single-worker configuration. No shared source or home file is used as mutable state.

## External surfaces and operator quality

No product/API, installed configuration, live account, marker or operator-facing action changes. The normal parent HOME and runner admission remain unchanged. The test setup globally strips routing variables and isolates CODEX_HOME, but does not isolate the production import-time lock path; this fixture explicitly owns that boundary. Release text describes running tests, not customer update behavior.

## Multi-machine posture

Machine-local by design: each test owns its temporary directory and marker. Source travels through normal checkout, with no runtime test state replication. No durable agent state, user notices, channels or generated URLs are introduced.

## Rollback

Revert the helper and two fixture edits. No data migration, live setup restoration or restart is needed. The separate AgentConnector registry fixture commit is not changed.

## Verification

The parent independently reviewed the frozen source and plan before allocation. Under allocation de224579-b29f-44e3-8661-de7432541f68, the sole full unit-file command passed 53 tests and the subsequent full integration-file command passed 30 tests. Both exited zero with zero failures, skips or recorded unhandled errors. The unit command took 6.618 seconds; the integration command took 1732.206 seconds including its ordinary admission wait. These are not throughput or full-gate measurements. Private Node24, inherited HOME and ordinary enforcing admission were retained, with no unsafe baseline, duplicate or retry. The normal build also exited zero. Raw output, JSON, reporter state and result metadata are preserved under .instar/state/build. Publication belongs to the Chief of Staff and complete exact-head verification to throughput; no full-green or live-recovery claim is made.

## Second-pass review

**Reviewer:** /root

The parent independently read the source and frozen manifest 0b35c3412288283ebdc3f3ea9fce59ac408e59a03b59e13f2052a877c547dce9 before execution. This final artifact is frozen after the actual 53-unit and 30-integration results. Its separate final read and digest-bound concurrence are recorded before a fresh trace and normal commit. No retrospective or unread-artifact concurrence is claimed.

## Class-Closure Declaration

unbounded-self-action: n/a. This is an explicitly invoked test fixture and teardown, not an autonomous retry, restart or recovery controller. No installed hook, prompt or skill changes.
