# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The Codex archive unit tests check bounded filesystem work and verify that a large scan waits for the event loop between and within directories. Regular integration tests continue to check HTTP health, lease ownership, tracker writes, and inventory results. The tight during-scan timing comparisons are available on a quiet machine with `INSTAR_TEST_ROLLOUT_TIMING=1`.

## Evidence

The Studio's isolated unit file passed all 20 tests after the shared run reported timing and worker-reporting failures. The focused checks on the Laptop exercised both the default verification and strict timing paths.
