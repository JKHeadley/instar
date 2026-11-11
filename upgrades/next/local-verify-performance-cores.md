## What Changed
On macOS, Local Verify now starts each verify run as its own short-lived launchd job marked `ProcessType Interactive`, so the run and its test lanes use the performance cores.

Before this, the run was a child of the agent server. The server lives under a tmux server that a plain launchd job started, so the run was scheduled at priority 20 and kept on the efficiency cores. On a 16-core Mac Studio the same CPU loop took 12.6 s there and 1.2 s in an Interactive job. While sessions were busy, every lane hit its deadline, so `main` could not be re-checked green and the merge queue held.

- The run still leads its own process group, appends to the same log and writes the same result file.
- Its exit status is read back from launchd, and the job is booted out afterwards.
- If launchd cannot start it, the server falls back to the old spawn and files a degradation report, and the run is never started twice.
- Jobs left over from a server that stopped mid-run are swept before the next start.
- `localVerify.performanceCores: false` turns it off. Linux is unchanged.

- A peer machine's in-flight verify now survives the coordinator's own restart. When the coordinator takes its lease back with no other holder in between, the attempt is adopted under the new lease epoch, and its signed result is still checked against the dispatch epoch. Before, every coordinator restart cancelled the peer's run, so 12 of 30 M5 attempts were lost on 2026-11-10.

## What to Tell Your User
Changes waiting to merge are tested faster and stop timing out when the Mac is busy, so they reach you sooner. When something is waiting to merge, I now explain the real cause from our own test queue instead of pointing at GitHub. When I restart, test runs your other machines are doing are no longer thrown away. Nothing for you to do.

## Summary of New Capabilities
- On macOS, Local Verify runs on the performance cores (default on, with fallback to the previous spawn).

## Evidence
- `tests/unit/localVerify-launchdSpawn.test.ts` (8 tests).
- `tests/integration/localVerify-launchdSpawn.test.ts` runs real launchd. It checks that pid equals pgid, priority is at least 31, the log is appended, exit status 7 comes through, and a SIGKILL of the group is reported as a signal.
