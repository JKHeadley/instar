# Local Verify: a merge-throughput PR is admitted past a full queue

## What Changed

- `src/localVerify/LocalVerifyService.ts` / `policy.ts`: a PR labelled `merge-throughput` is admitted past the queue cap (10) while the PR queue is below 15 (`throughputOverflow` 5); ordinary PRs still answer `queue-full`. Boot restore keeps every durably queued entry up to the same bound.
- Agent awareness: template line + migration.

## What to Tell Your User

Nothing changes for an ordinary agent. For maintainers who run Local Verify: a pull request labelled merge-throughput can now enter the test line even when it is full, so it actually goes to the front instead of being turned away.

## Summary of New Capabilities

None — the existing merge-throughput label now also applies when the queue is full.

## Evidence

2026-10-26: the queue was full (10) most of the evening; PRs 2392 and 2393, both labelled, answered `queue-full`. Unit: `LocalVerifyService.test.ts` (labelled admitted up to the overflow, the next labelled and an ordinary PR refused; restart restores every queued entry incl. the overflow); migrator awareness.
