# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

A verifier pauses new PR checks while its server is installing an update or deciding to restart into the installed version. A durable restart deferral retains its existing bounded admission rules. The pause clears after a failed install or when the new server process starts. The update status now shows when this short activation pause began.

An integration test for process ownership now accepts both tmux behaviors for a retained dead pane: older versions report the old pane pid, while tmux 3.7c may report none. The test still requires the verifier not to signal any process in either case. This removes an M5-only false red from PR checks without relaxing the production safety rule.

## What to Tell Your User

A new check may wait briefly during an update. That prevents a check from starting just before a restart and needing to run again.

M5 verification should also stop rejecting unrelated PRs because of its tmux version's dead-pane report.

## Summary of New Capabilities

The existing update and Local Verify paths now coordinate admission through the install-to-restart gap. No new setting or operator action is needed.

## Evidence

On M5, an update applied at 21:10 UTC, PR #2381 was accepted at 21:11:17 before the old process restarted, and its attempt became `unknown` after restart. Three M5 PR checks then failed an unrelated process-ownership test because tmux 3.7c reported an empty dead-pane pid; a captured full-run JSON report identified the assertion. Unit, HTTP integration, and production-shaped E2E tests cover the admission pause, deferral, and release boundaries. Full-suite and exact-head verification are release gates.
