# Side-Effects Review: locked-Mac proof, on-console secure input and a real launchd kill

**Version / slug:** `locked-proof-console-filter`
**Date:** `2026-11-05`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent (see below)`

## Summary of the change

Tier 1: small, dark and fully undone by a revert. About 8 files, 220 lines, first commit attempt. The Swift helper's `secureInputOwner()` reads only the session on the console; with no console session it reads all entries as before. `secureTargetHolds()` also requires this helper's own session to be on the console. Proof case 12.4 gets a `before` step that runs the proof server under its own launchd job and fires once the guard has acknowledged. `launchd-kill` throws unless a job, a server and a guard exist, the server dies and that same guard survives. `recover()` restores the server if the case fails partway, a stale job is cleared first, and `start-server` throws if nothing listens. Each case now sees only its own markers, so a finished marker from an earlier case can no longer fire injections, settle the case, count as its evidence or be the one revoked (this makes 12.2a, 12.2b, 12.2d and 15.8 stricter). `runCase` gains the `before` steps. Cases 15.10 and 15.11 opened no duty, so their revoke hit nothing: they now open one with a refused password and stop it, and a revoke with no request throws. A person step now counts only when its result is seen, with its own timeout, so a case cannot pass with nobody at the Mac. A password case fails if it never opened a duty, and a case landing on typing or Enter fails if nothing was typed or the helper refused. Nine review rounds, each finding a real rig defect; Tier 1 proportion stretched because the rig decides whether the gate is true.

Why now: the helper source hash binds the proof, so any later helper change needs new Mac grants and a new proof. Justin has not made the next trip yet.

## Decision-point inventory

- `secureInputOwner()`, an input to `secureTargetHolds` and `allowlistApplies`: modify. The word it returns now describes the console session only.
- Proof driver `launchd-kill`: modify. A kill with no effect is now a case failure.

## 1. Over-block

Removes one: a background account's ordinary app holding secure input read `other` and refused the password at a real lock screen. Also an unlocked console no longer falls under the allowlist because a background account's loginwindow holds secure input. No new refusal: if the console session has no secure-input pid it reads `none`, which refuses, and that is true of the screen.

## 2. Under-block

`secureTargetHolds` still needs the session locked flag, the shield window and `loginwindow`, and now also needs its own session on the console, which closes a user switch landing mid-typing on another account's lock screen. The filter can only remove readings from other sessions, so it cannot create a `loginwindow` reading for the console that was not there. With no entry on the console the old behaviour stands, so the login window reads as it did.

## 3. Level-of-abstraction fit

The session is known where the registry is read, so the filter belongs in the helper. The launchd job is rig-only and lives in the driver.

## 4. Signal vs authority compliance

- [x] No new authority. `secretType`'s refusal remains the authority; its input is more accurate.

## 4b. Judgment-point check

No static heuristic at a competing-signals point; `kCGSSessionOnConsoleKey` is a fact macOS reports. Read on the Studio's real IOConsoleUsers as a boolean.

## 5. Interactions

- Case 12.4 stops agent A's tmux server and starts it under launchd; the tunnel restarts with it, as in other server-kill cases. Agent B is untouched.
- The job has no KeepAlive, so launchd does not race `start-server`.
- `launchdServePlist` carries paths only; the server reads its own config.
- The job uses the driver's node and PATH, so the install's native module still loads.

## 6. External surfaces

None. The helper change ships dark behind the locked feature flag for every caller of `allowlistApplies` and `secretType`. The rig touches only the throwaway proof user.

## 7. Rollback cost

Revert the commit. A helper revert changes the source hash, so a recorded proof would have to be run again.

## Second-pass review

**Reviewer:** independent general-purpose subagent, two rounds, given the code and not my conclusions.

Round 1, did not concur: case 12.4 could pass at `marker:owed` without a guard; a failed setup could leave the server down; a failed restart went unnoticed; a stale job could hold the port; `secureTargetHolds` did not check the console. All fixed.
Round 2, did not concur: finished markers fired `guard-acked` early. Fixed, with a test.
Round 3, did not concur: the same flaw remained for `after-create`, `after-enter`, `settled()` and evidence. Fixed at the source: `prepare()` records existing markers and each case sees only its own; `revoke` also. 
Round 4, did not concur: with isolation, 15.10 and 15.11 had no marker to revoke (the old code passed on a stale one). The spec's delayed completion asks for a held submission; a refused password gives the same open duty with no test build. Fixed.
Round 5, did not concur: person steps were asked and never checked, so 15.10 and 15.11 could pass with nobody there, and `unlocked-accepted-risk` had no rule. Fixed, with tests.
Round 6, did not concur: 12.13's event was sticky, and a stale security item could satisfy 12.8 and 12.11. Fixed.
Rounds 7 to 9, scoped to the helper diff and false passes: no helper defect found. Each named one narrower false pass where a refused or untyped password still passed 15.3 and 15.7. Each fixed as named, with tests.
Final scoped round: concur. No realistic false pass in the 30 no-person cases, by code reading only, nothing run on a Mac. One weak spot named: 12.17 does not check that the stray letter reached the helper, listed below.

Known false fails the rig can still produce, which fail visibly and cannot pass a case: 12.11's final state with the boot retry, 12.8's sampling of the security item, 15.10 missing a fast relock between samples, and 12.12 and 12.13's unmeasured lock calls. They need real runs to correct and change only the driver, not the helper. 12.17's weak spot is also a driver-only change. They are tracked in the locked-proof handoff and must be closed before the proof is recorded.
