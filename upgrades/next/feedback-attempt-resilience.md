## What Changed

Three changes to the feedback executor. An open pull request it had not armed for merge is no longer skipped for a tick each time the owner epoch moves (every server restart): it goes on to its review in the same tick, while an armed one is still disarmed and waits a tick as before. When a server restart interrupts an attempt's trusted checks with its workspace intact, the checks now run again up to 3 times (was once); the worker session is never re-run, and past the limit the attempt is stopped as interrupted, never counted as the item's failure. The base and head checks now run only the listed test files that contain the named test (its whole name or its last `>` segment) when at least one does, and log `execute:test-files-narrowed`; when none does, every listed file runs as before.

## Evidence

Operated Studio, 2026-11-13: PR #3129 (an executor design draft, opened 04:17 UTC, CI green) logged `execute:disarm` with reason `stale-epoch` at every 30-minute tick from 05:17 to 09:17 and was never reviewed: the lease epoch moved 23531 → 23538 in about two hours, once per server restart. After (unit level): a never-armed PR under a new epoch each tick reaches the review gate every tick and merges once the reviewers pass; with the old stop path the same test fails. Also on the Studio, 2026-11-12/13: the executor's restart hold yields while Local Verify waits for a restart, and updates restarted the server roughly hourly (server log: GreenPrAutoMerger start lines at 04:19, 04:53, 05:13, 05:52, 06:19 and 07:27 UTC). Attempt 54c2a4aa:a3 was re-verified once at 06:47 and stopped `interrupted` at 08:17 by the next restart; 54c2a4aa:a1 also ended `interrupted`. Attempt 54c2a4aa:a2 fixed the defect but listed an integration file without its test: that run printed `3 skipped` and the attempt failed `head-check:test-not-run-at-head` after 22 minutes. After (unit level, execute-service): three interrupted re-checks each re-verify and the fourth stops `interrupted`; a row from before this change counts as one re-check used; only the file naming the test reaches the base and head commands. execute-units covers `filesNamingTest` both ways.

## What to Tell Your User

Automated fixes were sometimes lost because the server restarted for an update during their final checks, or because a worker listed one test file too many. Those checks now get a few more tries after a restart, and an extra test file no longer fails a good fix.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Fix checks survive several update restarts | Automatic |
| Open fix PRs are reviewed through frequent restarts | Automatic |
| Extra listed test files no longer fail a fix | Automatic |
