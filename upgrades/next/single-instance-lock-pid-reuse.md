# Single-instance lock identifies its holder by start time, not pid alone

## What Changed

- `SingleInstanceLock` decided whether the recorded lock holder was still running from the pid alone. On a host that recycles pids every few minutes, a dead holder's pid is re-issued to unrelated live processes, the lock reads LIVE indefinitely, and the agent's server refuses to boot until a spawn happens to land on a free pid. The lock record now also carries the holder's absolute process start time (`ps -o lstart=`, via the primitive `hostTestRunnerSemaphore` already uses for the same corroboration); a candidate pid whose start postdates the record by more than the shared 120s skew is treated as a different process and the stale lock is reclaimed. One-sided on purpose; every uncertain case (no recorded start, unreadable candidate start) keeps the previous pid-only verdict.
- `ServerSupervisor` now appends the spawned server's stderr to `logs/server-stderr.log` (`tee -a`) instead of truncating it on every spawn. Past 4 MB the newest 512 KB is kept. The crash-output reader takes a bounded tail rather than reading the whole file.

## What to Tell Your User

If one of your agents went quiet for hours and its log showed a long run of "spawns failed before binding", this is the fix. The agent believed a copy of itself was already running because it was identifying that copy by an operating-system ID number the machine had since handed to something else. It now also checks when that process started, so a stale note can no longer keep the agent off. Nothing to configure. Separately, the agent's crash log now keeps the reasons for every failed start instead of only the last one, so a repeat of this kind of outage can be explained in minutes rather than hours.

## Summary of New Capabilities

None — this is a reliability fix to an existing guard. No new setting, route, or surface.

## Evidence

- Measured on the `inspec` agent (monroe-workspace, laptop) 2026-10-12: 48 consecutive `Bind-failure escalation armed: N consecutive spawns failed before binding` in `lifeline-launchd.log`; outage windows from `activity-*.jsonl` `scheduler_start` events of ~35h (Oct 10 22:06 → Oct 12 08:53 PDT) and ~3.5h (Oct 12 12:58 → 16:30 PDT); the recovering boot logged `reclaimed a stale same-host lock (dead pid 86892)`.
- `server-stderr.log` on that host held three lines from an unrelated earlier boot — the truncation defect in one observation.
- Tests: `tests/unit/single-instance-lock.test.ts` (29, including a defaults-only round trip that exercises the real `lstart` write and read together) and `tests/unit/supervisor-crashlog-append.test.ts` (4).
- Side-effects review with an independent second pass: `upgrades/side-effects/single-instance-lock-pid-reuse.md`.
