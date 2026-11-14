# Local Verify keeps a run that is still alive after a server restart

<!-- bump: patch -->

## What Changed

On macOS the Local Verify run child is its own launchd job (and elsewhere a detached process), so it keeps running when the server dies. At boot, `LocalVerifyService.reapOrphan()` found the in-flight marker, confirmed the live process as this service's own run (its arguments carry the run's token), and killed it; the queue restore then counted an unclean stop and ran the PR again from the start.

A live, identity-confirmed PR run is now kept when `whyNotAdoptable()` finds no reason against it. The boot reap returns `adoptable`, the queue restore matches the saved in-flight entry to it (same PR, head and base ref; PR still open; head unmoved) and `adopt()` makes it the in-flight run again. A live run nothing matched is stopped as before.

Not kept (stopped and re-run, the previous behaviour): the switch is off; the service is peer-only; the run is a `main` verify; the verifier on disk has changed; the run's input file is unreadable, is a peer hand-off, or names a different repo, PR, head, base, verifier version or policy hash than the marker and this server; the run started longer ago than a full run ceiling. Only the boot may keep a run: a reap from `tick()` always stops.

An adopted run has no child handle. `tick()` (every 30 s) ends it when its result file holds a result object, when its group is gone, when its leader is definitely gone (a signal-0 probe says no such process) or its pid belongs to another program, or when it is past its run ceiling plus 5 minutes, about three hours from its start (stopped and handled as a crash). An unreadable `ps` answer ends nothing. A cancelled adopted run is cleared when its group is gone, or at the ceiling. Its record must match the entry it was kept for (repo, PR, head, base, verifier version, policy hash) or it is handled as a crash.

New live switch: `monitoring.localVerify.adoptRunningRun` (absent means on; read at boot).

## What to Tell Your User

Nothing changes that you will see. If the agent's server restarts unexpectedly while a test run is in progress, the run now carries on and its result is collected, where before it was stopped and started again from the beginning.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|------------|
| A Local Verify PR run survives an unplanned server restart | Automatic; `monitoring.localVerify.adoptRunningRun: false` turns it off |

## Evidence

Studio, 2026-11-13. `.instar/logs/local-verify.jsonl` shows `orphan-reap-incomplete` followed about 30 s later by `orphan-gone` and a fresh `started` for the same PR after each unplanned server restart: 03:51Z (PR 3112), 04:19Z (3120), 07:27Z and 07:55Z (3053), 09:19Z (3130), with no `cancel` before them (the server was killed, not stopped). On the live run at 12:27Z, `ps` showed the run child with parent pid 1 and `--attempt-token <token>` in its arguments, matching `inflight.json`: the identity check that authorizes the kill succeeds for a healthy run.

Tests: `tests/unit/localVerify/LocalVerifyService.test.ts`, 29 new in "a run still alive after the server was killed is kept": the run is kept with nothing killed and nothing new started; green, red and crashed endings; handled once; a clean stop during and after; eight reasons it is not kept; ended on a written result with a straggler alive, past the ceiling, on a dead leader, on a reused leader pid, and not on an unreadable `ps`; a cancelled kept run cleared when its group goes and at the ceiling; a record for another head is not journaled; a second server kill; only the boot may keep a run (two cases that would otherwise leave the queue blocked); a failed boot stops the run; the switch is wired. Two reviewed faults were reintroduced one at a time and the tests failed (a tick-time adoption: 2 tests; no result-written ending: 1 test). 186 pass in the file; `peerVerifier`, `waitingListService`, `orphanSweep`, `mainRedHoldService`, `mergeLineWiring` and the self-action convergence ratchet pass unchanged.
