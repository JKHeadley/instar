# Side-Effects Review — locked-proof driver: freeze cases really freeze, and a restarted server is waited for

**Tier 1.** Hand-run proof tooling and its unit tests; no runtime code. Size: 3 code files (driver.mjs, lib.mjs, one test file), about +170/−10, plus the release note, side-effects and ELI16. Effort: no spec rounds; two commits, because the second three faults only showed once the first three let the run get further. Follows PR 2810 (the viewer-wait fix), which merged before these were fixed.

## Summary

Thirteen faults found in the live run on the Mac Mini on 2026-11-05, once the viewer-wait fix let the run start.

- **Freezing the server.** Cases 12.1 and 12.6 send SIGSTOP to the proof server. It ran as a tmux pane process, and tmux resumes a stopped pane process at once, so the server never froze. Both cases now run `serve-under-launchd` first and restore tmux in cleanup (`cont-server`, `end-launchd-serve`, `start-server`). `stop-server` now reads the process state half a second after the signal and throws unless it starts with `T`.
- **Ready after a start.** `start-server` and `serveUnderLaunchd` now call `waitLockStateKnown()` (up to 120 s) before returning, and report `lockStateKnown` in their result.
- **Lock state read.** `readLockState` skips an agent that answers `unknown` and asks the other.
- **Lock state from the Mac itself.** `readLockState` now reads IORegistry (`IOConsoleUsers`, `CGSSessionScreenIsLocked` for the proof user's console session) and falls back to the servers only when the proof user has no console session. A server's `/desktop/locked/status` is a cache that only refreshes while a viewer is connected. Each sample also records `serverLockState`.
- **Both agents after a start.** `start-server` always starts agent A, as before, and also starts agent B when it is not listening; `kill-tmux` takes both down. A first version skipped agent A when its port still had a listener, and after a launchd bootout that left nothing serving (seen live at 12:46 PST: every case after 12.1 failed with a refused connection).
- **Resuming a process that is gone.** `kill(pid, 'CONT')` on a process that has exited returns `skipped: 'gone'`. STOP and KILL on a process that is gone still throw.
- **What "typing" means.** The `typing` trigger in `lib.mjs` now needs a duty in state owed with Enter not yet pending, as well as the input helper running. The helper alone runs for the whole grant.
- **Case 12.5a ends its session.** It now stops the viewer at the `takeover` event (the duty's guard pid changes to the replacement). Before, nothing ended the grant, and an owed duty on a live grant is not due.
- **Revoke as the right operator.** `viewer()` keeps the operator session the page receives from `/dashboard/unlock`; `revoke` sends that session and throws on a 4xx or 5xx answer. The server's refusal of a foreign session is correct and unchanged.
- **Leftover-process rule needs a duty.** `processesGone` is left undefined when the case has no duty at all, so the input helper of a live grant is not read as a leftover typist. With a closed duty the rule is unchanged.
- **Case 12.9 watches long enough.** `timeoutMs: 840_000`, past the 600 s deadline it waits for.
- **Deadline before Enter.** In `typePassword` the before-enter offset is `min(1.5 s, half the calibrated typing time)`. The after-enter offset is unchanged.
- **Security item is given time to arrive.** `extraEvidence` polls the attention list for up to 15 s when a sample shows `relock-failed`. It has no unit test (the function shells out to `log show`); the live rerun of 12.18 is its evidence.
- **What the page said.** `typePassword` returns the last distinct status lines (`pageSaid`, at most six) when no answer is recognised. Status lines are the page's own plain messages and carry no secret.
- **Case 15.9 checks the clearing in the next grant.** New step `next-helper-clears-field`: opens a grant, waits up to 15 s for the store's `dirty` marker to clear, ends the grant and waits for its helper to go. `runCase` now records `then` steps in `fired`. This follows docs/specs/desktop-locked-screen.md, "Half-typed field": the marker "outlives the request" and "the next helper after a kill" clears it.
- **Case 12.9 freezes the owning server.** `before: serve-under-launchd`, a `stop-server` step beside `stop-typist` and `stop-guard`, and the tmux-restoring cleanup. This is a reading of the spec's admission rule ("a marker past its deadline with a stale heartbeat stops blocking only after its guard and its recorded typist are SIGKILLed … and the marker moves to `relock-failed`"), which can only apply when nothing has replaced the guard. If the case was meant to cover something else, that needs its author.

## 1. Over-block

`stop-server` can now fail a case that the old code let run. That is the point: a freeze that did not hold is not evidence. A process that is gone reads an empty state and also throws; a case that wants a dead server uses `kill-server`.

## 2. Under-block

`waitLockStateKnown` gives up after 120 s and returns false; it does not fail the case, so a server that never learns the lock state shows up later as the case's own failure, with `lockStateKnown: false` in the evidence. In the live 12.1 run the launchd-served server did read unknown for the whole wait and the case still passed, so failing there would have been wrong. The state check runs once, half a second after the signal; something that resumes the server later is not caught.

The IORegistry flag is the console session's lock flag only. The server's classifier also knows states the flag cannot express (policy pending, logged out); those are still read from a server when there is no console session, and stay subject to the stale cache. The cache itself is a product fault filed separately as feedback, not fixed here.

The typing window is short (about 0.7 s for a 20-character password on the Mini) and the driver polls every quarter second, with each sample taking a moment itself. A poll that first sees the duty after Enter is pending never fires the injection, and the case then fails honestly with "injection never fired" instead of judging the wrong moment. Cases 12.2e, 12.9 and 15.9 may need a rerun when that happens.

Changing 12.5a changes what the proof asks of the product, so it is stated here plainly: the spec (docs/specs/desktop-locked-screen.md, "A dead guard" and gate P12) asks for a replacement guard and for the Mac to end locked. It does not ask for a relock while the owner's session is still live. The case as written could only pass if the product locked a Mac out from under a live session. If that stricter behaviour is wanted, it is a spec change, not a test fix.

The deadline offset is measured from when the driver saw the grant open, which trails the server's own start of the 10-minute ceiling by the page's opening delay. If that delay is close to half the typing time, 15.3 can still type too late and will fail honestly with no duty; the rerun shows which.

## 3. Level-of-abstraction fit

Right layer: all thirteen are the driver's own assumptions about its target. The page behaviour, the server's start-up and tmux are left as they are.

## 4. Signal vs authority compliance

No decision point in an agent. The new throw gates only the proof run's own verdict. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

The driver no longer needs agent B to answer while agent A is down, but B is still the other agent in the two-agent cases, so it must be up. `python3` is already a driver dependency (reset-attempts.py). `recover()` already ends a launchd job and restarts the server when a case throws mid-way, so the two re-homed cases restore tmux on both paths; in the normal path cleanup has already cleared the job. Cases 12.1 and 12.6 take longer (a stop, a launchd start and a tmux start, each with its wait). Case 12.4 already used the same launchd path.

## 6. External surfaces

None. The driver is run by hand on a proof machine.

## 6b. Operator-surface quality

No page or control changes.

## 7. Multi-machine posture

Machine-local by design: the driver runs on the one Mac under test against its local proof agents.

## 8. Rollback cost

A revert restores the old driver, cases and tests. No state or migration.
