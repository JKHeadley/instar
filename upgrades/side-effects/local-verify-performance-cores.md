# Side-Effects Review — Local Verify runs on the performance cores (macOS)

**Version / slug:** `local-verify-performance-cores`
**Date:** `2026-11-11`
**Author:** `echo`
**Second-pass reviewer:** `not required (no block/allow decision, no agent-session lifecycle; Tier 1, reverted by config or revert)`

## Summary of the change

What changes:
- `src/localVerify/launchdSpawn.ts` (new): starts a command as a transient launchd job with `ProcessType Interactive`. It records the pid through a `/bin/sh` prelude that then `exec`s the command, watches for exit, reads the exit status from `launchctl print`, and boots out and cleans up the job.
- `src/localVerify/serviceSeams.ts`: `spawnRun` uses it on darwin when `performanceCores` is set. Any failure before start falls back to the plain detached spawn.
- `src/localVerify/localVerifyWiring.ts`: turns the option on by default and adds the config switch `localVerify.performanceCores` (default true). A fallback is reported through DegradationReporter.

Tests:
- Unit: `tests/unit/localVerify-launchdSpawn.test.ts`, 8 tests with a fake launchd.
- Integration: `tests/integration/localVerify-launchdSpawn.test.ts`, real launchd on macOS. It checks that pid equals pgid, priority is at least 31, the log is appended, the exit status comes through, and a killed group is reported as a signal.

Evidence: on 2026-11-11 after 02:11Z, every unit lane on the Studio died at its 20-minute deadline, against a normal time of about 12 minutes. Integration and e2e lanes also hit their deadlines. The verify processes ran at priority 20 with nice 10. A CPU loop took 12.6 s from a session and 1.2 s from an Interactive job.

## Decision-point inventory

- `LocalVerifyService` admission, merge and main-health decisions — pass-through. They are unchanged. Only how the run process is started changes.

## 1. Over-block

No block/allow surface — over-block not applicable.

## 2. Under-block

No block/allow surface — under-block not applicable. Failure modes this change does not remove:
- Real contention on the performance cores, for example an Xcode build plus a verify, can still slow a run. That is ordinary contention, not the clamp.
- Linux machines are unchanged.

## 3. Level-of-abstraction fit

This is a process-start seam (`spawnRun`), the narrowest layer that decides how the run is scheduled. Two alternatives were rejected:
- Moving the whole agent server out of the clamp would need restarting the shared tmux server that every session lives in.
- Raising the lane deadlines would treat the symptom.

## 4. Signal vs authority compliance

No authority is added. A fallback produces a signal (a DegradationReporter row) and never blocks.

## 5. Interactions

- **Orphan reaping** (pid/pgid in inflight.json, `readProcessArgs`): unchanged. Because of the exec, the recorded pid is the command itself, and launchd starts each job in a new session, so pid equals pgid.
- **Restart behavior:** a run survives a server restart, as a detached child did before. A job left loaded after its process ended is booted out by the sweep before the next spawn. The sweep only touches this agent's prefix and only jobs with no running process.
- **Exit status:** `exited` comes from polling `kill(pid,0)` once a second instead of a child 'exit' event. A one-second delay in noticing the end is negligible next to runs that take minutes.
- **FailedFileDiagnosisPeerService** uses the same seam and benefits the same way.
- **Live 2.0 runner:** the verify keeps `nice -n 10`, so it still yields to other work on the performance cores. The live runner already runs as its own Interactive LaunchAgent.

## 6. External surfaces

- A transient user LaunchAgent label `ai.instar.lv-run.<hash>.<ts>.<rand>` exists while a run is live.
- Plists live under `.instar/state/local-verify/launchd/`.
- Nothing reaches other agents or users.

## 7. Multi-machine posture

Machine-local by design. Each machine decides how it starts its own process. Peers run the same code and gain the same speedup on Macs.

## 8. Rollback cost

Set `localVerify.performanceCores: false` and restart, or revert the PR. No data migration and no persistent state.

## Class-Closure Declaration

- `unbounded-self-action` — closure: **n/a**. This is not a new self-triggered action. It is the same single run-child start per verify that the queue already makes, routed through launchd instead of a direct spawn. No retry or loop is added; a failed start falls back once to the plain spawn.

## Addendum: merge-wait diagnosis line in the agent reference

`src/scaffold/templates.ts` gains one line in the Local Verify reference section. It tells agents that GitHub Actions runs are not on the instar merge path: the ruleset requires only `instar/local-verify` plus a code-owner review where CODEOWNERS applies. Before naming the cause of a merge wait, an agent reads `GET /local-verify` for the queue position, the run in progress, main health and recent restarts.

This change is documentation only, with no runtime decision surface. It reaches existing agents because the reference files are regenerated from `generateClaudeMd()` on every update (claudeMdLayout).

What prompted it: on 2026-11-10 a session told the operator that "GitHub's checks are backed up". The real hold was the local queue's main-suspect state and lanes timing out.

## Scope cut and fixes (2026-11-12)

- **Removed:** peer-attempt adoption across the coordinator's own restart (commit 480498ace, reverted). Review found that `lastSeenOtherHolder` is in memory only, so after a restart the code could not tell that another machine had held the lease in between. An attempt could be adopted across another holder's tenure, and nothing tested the rule. Tracked as CMT-1691: rebuild it with the epoch + 1 or persisted-watermark test.
- **Sweep:** `sweepStale` also removes leftover plist/pid files of this prefix that have no launchd job. A plist holds the run's environment, tokens included. Its comment now names the one overlap, a failed-file diagnosis job; an exit read as unknown there is ignored by that service.
- **No double start:** when a job records no pid and its boot-out fails while launchd still lists it, `spawnViaLaunchd` throws `LaunchdNoFallbackError`, and `serviceSeams` rethrows instead of falling back to the plain spawn.

## Second-pass review

**Reviewer:** independent Claude Sonnet subagents (fresh context, given the whole diff vs main), 2026-11-12.
- First pass on the full PR (14:31 PST): **DO NOT CONCUR**. Peer adoption could cross another holder's tenure, and there were no adoption tests. Answered by removing adoption.
- Second pass on the reduced PR (14:46 PST): **CONCUR**. Notes applied: no fallback when a job cannot be confirmed stopped (two new tests), the sweep comment covers diagnosis jobs, and orphan plists are swept. Noted and accepted: plist mode 0600 and the same environment are visible to the same user through `launchctl print`, the same as the plain spawn's environment; pid reuse in `isAlive` is a low-probability hang bounded by the lane deadline.
