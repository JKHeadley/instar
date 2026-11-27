# Side-effects review — test-line-flake-hardening

## Summary

Tier 1, two implementation files and one integration test, plus release notes and this review. The change replaces a three-second native-library scan limit with a ten-second finite limit and gives the Cartographer timeout test a ten-second worker budget. The remote enrollment request allows 35 seconds for the scan, the copied-runtime smoke test, and file I/O. Reverting the change restores the previous deadlines.

## Over-block

No new input is rejected. The Cartographer test still requires a real Git child to start and verifies that it exits after the worker timeout.

## Under-block

If `/usr/bin/otool` hangs for more than ten seconds, the recovery installer still refuses to prepare that runtime. The longer limit can delay that refusal by at most seven additional seconds compared with the prior bound.

## Level of abstraction

The native inspection deadline belongs beside the `otool` call in the runtime-slot implementation. The longer test budget belongs in the integration fixture because it is accounting for parallel worker startup, not changing the production worker's timeout policy.

## Signal versus authority

This change adds no new blocking authority. Recovery continues to fail closed when native library verification cannot complete before a finite deadline.

## Interactions and rollback

The new ten-second limit applies to macOS native-library inspection in `prepareRecoveryRuntimeSlot`. The 35-second mesh deadline applies only to the enrollment request that waits for that work. Revert the three deadline changes to restore the former behavior. This requires no migration.

## Evidence

The latest main run recorded the Cartographer test's PID-file assertion after its one-second worker budget elapsed before the fake Git process started. The recovery lifecycle test timed out waiting for `/usr/bin/otool -L`; the same otool timeout appears in a prior verifier run. Both tests passed in their isolated reruns.

The first build passed both affected integration files with 25 tests. The first independent review found that the caller could time out while a cold enrollment was still preparing its runtime. That led to the 35-second enrollment request deadline.

## External surfaces

A Mac recovery installation may spend up to ten seconds inspecting the installed Node runtime. A paired machine can wait up to 35 seconds for the signed enrollment response. The utility, permitted libraries, error handling, and input format are unchanged. The Cartographer change is scoped to its integration test.

## Multi-machine posture

Native library inspection runs on the Mac whose runtime is being prepared. It checks that machine's binary and linked library paths. No state is replicated or shared between machines.

## Independent review

Concur with the review. The mesh client honors the 35-second per-request deadline. That leaves ten seconds beyond the two subprocess budgets for slot preparation. The reviewer found no tighter deadline on the mesh request or the setup page. The library inspection still fails closed, and the worker test still checks that the recorded child PID exits.

The revised macOS build passed. Seven recovery wiring unit checks and all 25 cases in the two affected integration files passed. The recovery integration file took about 17 minutes while the Studio was verifying another change. The test that had failed in the verifier passed in that run.
