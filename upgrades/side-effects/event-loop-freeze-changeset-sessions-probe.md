# Side-Effects Review — keep two whole-tree and per-session reads off the event loop

**Version / slug:** `event-loop-freeze-changeset-sessions-probe`
**Date:** `2026-11-07`
**Author:** `echo (echo-liveproof-2)`
**Second-pass reviewer:** `independent subagent, see below`

## Summary of the change

Tier 1, 4 source files, about 60 lines of source (fb-53f6f120-219). Two blocks were caught on the Studio server by live profiles. (A) `buildChangeSet` read every file of the session workspace and the publish clone with sync calls inside `verifyAndPublish`; at 08:09 PST on 2026-11-07 that held the event loop for at least 84 s until the server was killed. It now uses `fs.promises` for every per-file call. `treeBytes`, the disk-cap walk over the same tree on every tick for each live attempt, gets the same treatment; the second-pass review found it. The order of the walk, every check, every error and the caps are unchanged. (B) `GET /sessions` called `SessionReaper.snapshot()` for a discrepancy probe that only needs ids, and snapshot runs sync child processes for each session. A new `trackedSessionIds()` returns the same ids with no evaluation. `GET /sessions/reaper` keeps the full snapshot.

## Decision-point inventory

- `buildChangeSet` special-file, hard-link, nested-git, size and sandbox-breach checks — pass-through — same checks, same order, now awaited.
- Sessions read discrepancy probe — pass-through — same ids and counts, cheaper source.

## 1. Over-block

No issue identified. No check changed, so nothing new is refused.

## 2. Under-block

The async walk widens the time between walking a file and reading it from milliseconds to up to about a minute. That matters only if something can write the tree in that time. `verifyAndPublish` first moves the workspace to a path no sandbox policy can write, and `readNoFollow` still opens with O_NOFOLLOW and re-checks file type and link count on the open handle, so a swap is caught as before. A leftover process with a file already open could still change bytes on macOS; that is harmless, because the gates use the buffers already read and links are refused. Still missed: `sweepTrash` and `safeRmSync` delete trees synchronously. They did not show in these captures and are not changed here; filed as fb-c9e6db4d-781.

## 3. Level-of-abstraction fit

Right layer. The cost lives in the function that does the reads, and the probe's cost lives in what it asks the reaper for. A worker thread was considered for (A); it adds a compile and message step and copies buffers, and promises already keep the loop free, measured below.

## 4. Signal vs authority compliance

No decision authority added or moved. The change-set checks keep their authority and logic. The probe stays a signal that never blocks the read.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point added or changed. Both changes alter how data is read, not what is decided.

## 5. Interactions

`tick()` is single-flight through `this.running`, held across the new awaits, so a second tick returns `tick-in-flight` and cannot enter `reconcileLive` for the same row. `verifyAndPublish` was already async with awaits around this call. A server shutdown during the longer await leaves the row in its state, as with any other await there, and the next boot reconciles it. Reads run one at a time, so the libuv pool is not flooded.

## 6. External surfaces

No API change. `buildChangeSet` is now async; its one caller and the tests are updated. A finished attempt takes longer in wall-clock terms: 40.5 s on a 21,261-file pair under load, during which the server keeps answering. Nothing waits on that time.

## 7. Multi-machine posture

Machine-local by design: both are in-process reads on the machine that runs them. The executor runs on its operated host only. Every machine gets the `/sessions` fix through the normal release.

## 8. Rollback cost

Revert the commit and release. No state, config or migration involved.

## Evidence

Captures on the Studio (`.instar/vm-test/tools/freeze-captures/`): 080938 shows 94% sync read inside `verifyAndPublish`, then log silence 16:09:17 to 16:10:41 UTC and `dead pid`. 075020 shows `routes.js:10144` to `SessionReaper.snapshot` to `hasActiveProcesses`, `hasLiveToolShell` and capture. 070645 has the same shape as (B), a block of about 24 s, but its JS frames were not named, so that link is likely, not proven. Measured after the fix: 21,261 files, longest event-loop gap 50 ms. The new event-loop test gets 0 turns with sync reads restored (mutation run) and over 300 with the fix.

## Second-pass review

Concern raised: no code defect; the artifact's list of remaining sync work omitted `treeBytes`, which walks the tree on every tick for each live attempt. Resolved by making `treeBytes` async in this change, with a both-sides test. Checked clean: error classes and ordering, FileHandle behaviour, the trust model, re-entry, and probe equivalence.

After the fix the reviewer re-checked: Concur with the review. All `treeBytes` and `diskOk` uses are awaited.
