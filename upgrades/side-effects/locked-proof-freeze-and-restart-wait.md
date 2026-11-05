# Side-Effects Review — locked-proof driver: freeze cases really freeze, and a restarted server is waited for

**Tier 1.** Hand-run proof tooling and its unit tests; no runtime code. Size: 3 code files (driver.mjs, lib.mjs, one test file), about +70/−5, plus the release note, side-effects and ELI16. Effort: no spec rounds; one commit. Follows PR 2810 (the viewer-wait fix), which merged before these three faults were fixed.

## Summary

Three faults found in the live run on the Mac Mini on 2026-11-05, once the viewer-wait fix let the run start.

- **Freezing the server.** Cases 12.1 and 12.6 send SIGSTOP to the proof server. It ran as a tmux pane process, and tmux resumes a stopped pane process at once, so the server never froze. Both cases now run `serve-under-launchd` first and restore tmux in cleanup (`cont-server`, `end-launchd-serve`, `start-server`). `stop-server` now reads the process state half a second after the signal and throws unless it starts with `T`.
- **Ready after a start.** `start-server` and `serveUnderLaunchd` now call `waitLockStateKnown()` (up to 120 s) before returning, and report `lockStateKnown` in their result.
- **Lock state read.** `readLockState` skips an agent that answers `unknown` and asks the other.

## 1. Over-block

`stop-server` can now fail a case that the old code let run. That is the point: a freeze that did not hold is not evidence. A process that is gone reads an empty state and also throws; a case that wants a dead server uses `kill-server`.

## 2. Under-block

`waitLockStateKnown` gives up after 120 s and returns false; it does not fail the case, so a server that never learns the lock state shows up later as the case's own failure, with `lockStateKnown: false` in the evidence. In the live 12.1 run the launchd-served server did read unknown for the whole wait and the case still passed, so failing there would have been wrong. The state check runs once, half a second after the signal; something that resumes the server later is not caught.

## 3. Level-of-abstraction fit

Right layer: all three are the driver's own assumptions about its target. The page behaviour, the server's start-up and tmux are left as they are.

## 4. Signal vs authority compliance

No decision point in an agent. The new throw gates only the proof run's own verdict. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

`recover()` already ends a launchd job and restarts the server when a case throws mid-way, so the two re-homed cases restore tmux on both paths; in the normal path cleanup has already cleared the job. Cases 12.1 and 12.6 take longer (a stop, a launchd start and a tmux start, each with its wait). Case 12.4 already used the same launchd path.

## 6. External surfaces

None. The driver is run by hand on a proof machine.

## 6b. Operator-surface quality

No page or control changes.

## 7. Multi-machine posture

Machine-local by design: the driver runs on the one Mac under test against its local proof agents.

## 8. Rollback cost

A revert restores the old driver, cases and tests. No state or migration.
