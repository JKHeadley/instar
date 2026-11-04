<!-- bump: patch -->

## What Changed

The green-PR auto-merge kill switch now records who a stop belongs to. A rollback with no claim stays operator-class and needs the dashboard PIN, as before. This covers every dashboard stop and every stop that already exists. A session can instead pull a stop as its own by adding an `agentStop` claim, which records its topic and full reason. Any session of that agent can then release it through the new `POST /green-pr-automerge/release`, one named stop at a time. The server reads the class from storage and checks for itself that a PR citing the stop's marker merged after the stop and is contained in the release tag of the version it is running. Anything it cannot read refuses. An invalid claim still stops, on the strict side.

A separate 10-minute pass keeps an agent stop from being orphaned. It keeps a commitment open, wakes a session on the owning topic when the condition is met or the stop has stood 6 hours, and raises one Attention item. Plain stops now get one notice as well, because the watcher's existing notice never reached the operator.

## What to Tell Your User

If I stop auto-merging for my own reason, I can now turn it back on myself once the fix is actually running, so you no longer get a chore for a stop you never pulled. A stop you pull still needs your PIN, and nothing I do can release it. Stopping is exactly as easy as before.

## Summary of New Capabilities

- An agent can pull an auto-merge stop as its own and release it once its fix is in the running release.
- Agent stops can't be orphaned: a tracked commitment stays open, and a session gets woken to finish the job.
- The status route shows who holds each stop, and why.

## Evidence

Three test tiers cover this: `tests/unit/agent-stop-release.test.ts`, `tests/unit/guard-latch-store.test.ts`, `tests/integration/green-pr-automerge-routes.test.ts`, `tests/e2e/green-pr-agent-stop-release-lifecycle.test.ts`. The compare read that decides "in the running release" was checked against the real repository: PR 2648's merge commit against release tag v1.3.1634 read `ahead`, and against the older v1.3.1500 read `behind`.
