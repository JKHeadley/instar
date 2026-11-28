# Simulated Provider Host State Isolation — Side Effects

## Scope and decision points

Three existing integration/lifecycle fixtures now own the home-derived host admission ledger used by status routes and a simulated pool provider. No production source, native-provider smoke test, capacity default, configured bound, account policy, approval or release floor changes. This is a small fixture ownership repair, not completion of the broader test-state audit.

## Over-block and under-block

Explicit default-ledger path assertions fail if the actual singleton resolves outside the fixture. The integration saturation case retains its configured cap 2 and now requires both actual acquire calls to return true, followed by an exact private count 2 and saturated status. The default lifecycle still requires cap 8 and an unsaturated fresh fixture. The pool lifecycle still serves completion through the real provider factory and wrapper with its harmless stand-in primitive. No admission outcome is forged, no capacity exception is relaxed, and no test is skipped.

## Level of abstraction and signal versus authority

A temporary project stateDir did not isolate the process-wide singleton whose default path comes from os.homedir. Scoped home lookup and reset place the ownership boundary before singleton construction. Production admission remains the authority for actual native work; moving a real native-provider smoke test to a private host ledger would defeat that safety floor and is explicitly excluded. The invariant is deterministic fixture path ownership, with no new competing-signals judgment rule. Reference: docs/signal-vs-authority.md.

## Interactions and cleanup

Only os.homedir is spied on; the HOME environment is inherited unchanged. Integration and fork-bomb lifecycle cases create fresh temporary homes per case. The pool lifecycle uses its already-owned project directory as the fake-provider home. Default singleton identity is asserted in every fixture. Explicitly injected semaphore cases keep their existing owned holdersPath. Teardown closes owned lifecycle servers before resetting singleton/pollers and restoring the scoped home spy; the pool lifecycle also resets its process breaker. Only owned directories are removed using SafeFsExecutor. No baseline invocation writes to a live host ledger.

## External surfaces and multi-machine posture

No product behavior, HTTP contract, native CLI admission, account state or host settings change. Harmless simulated work and route status reads get independent temporary admission state. Real native provider work keeps normal shared host admission. No cross-machine state or transferable identity is introduced.

## Rollback

Revert this test-only commit to restore previous fixture setup. No migration, deployment, restart or live state repair is required. Published registry fixture repair c21e32f61 is a separate parent commit and its evidence remains untouched.

## Verification

Independent source and focused-plan review concurs with frozen manifest 21b4d68e434f5144a45cb391bc4a08dd0edcebc32c3a27a8bdcb21f6ba2f21d8 and all 14 hashes. Coordinator receipt bd627182-d265-44b7-922d-2daaa7cd8cb7 authorizes exactly three sequential focused invocations under private Node24, normal HOME, enforce1 and normal admission. The actual focused sequence passed 6 unit, 7 integration and 10 lifecycle tests. Every invocation exited 0 with zero skips, failures or unhandled errors. Each command ran exactly once. Integration and lifecycle wall time included ordinary admission waits; these waits are preserved in the raw logs and do not count as test execution. No complete-gate or live-result claim is made.

## Second-pass review

**Reviewer:** /root/main_search_failure_review

The reviewer independently inspected the three fixture changes and full focused plan before execution. A fresh final-artifact concurrence will be obtained for the exact final bytes after actual results are recorded. Historical review metadata is preserved.
