# Side-Effects Review — Local Verify keeps a run that is still alive after a server restart

**Version / slug:** `lv-adopt-running-verify`
**Date:** `2026-11-13`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 by reversibility (a live switch and a revert both undo it; no stored data changes shape), with an independent second-pass review because the file is the merge gate's coordinator and the change alters what a boot does to a running verify. 3 source files, 1 test file (29 new cases). Stacked on PR 3139 (the `settled` latch in `onExit`). No spec review rounds.

At boot the service killed a healthy, identity-confirmed run that had survived the server's death (on macOS the run child is its own launchd job), then re-ran the PR from the start. Every unplanned server restart on 2026-11-13 cost the run in flight this way.

Change: such a run is kept when nothing in `whyNotAdoptable()` speaks against it and the saved queue still has its entry; `tick()` notices its end and the normal exit handling reads its result. Everything else is stopped and re-run as before.

Part of CMT-1718. Not fixed here: a run that finished while the server was down is re-run (the boot's `gone` branch does not read its result, and its files are left in the runs directory); `main` verifies and peer attempts are not kept; a graceful shutdown still stops a run in the middle.

## Decision-point inventory

- **What a boot does with a live run from before the restart**: was "kill when identity is confirmed, block when it is not"; now "keep when identity is confirmed, every condition in `whyNotAdoptable()` holds and the saved queue claims it; otherwise kill as before; block when identity is not confirmed, as before".
- **When an adopted run has ended**: result object on disk, or group gone, or leader definitely gone (no such process) or its pid reused, or past the run ceiling plus 5 minutes (about three hours from the run's start: 120 minutes plus two 30-minute waits plus the grace). A cancelled adopted run ends when its group is gone, or at that ceiling.
- **Whether an adopted run's record may be journaled**: only when it matches the entry it was kept for and this server's verifier and policy.
- Unchanged: record validation in `complete()`, the merge hand-off and every merge gate.

## 1. Over-block

- A kept run is stopped when it is past its ceiling plus grace although it might still have finished. The ceiling is the same bound the restart hold uses for any run.
- A run is not kept in several recoverable cases (identity unreadable at boot because `ps` timed out; a request for the same PR arriving before the restore; an entry managed by the preflight-replay store). It is then stopped and re-run: the previous behaviour, no worse.

## 2. Under-block

- The cases listed in the summary as not fixed.
- Where the `isPidAlive` seam is not provided (it is optional; the real seams provide it), an adopted run whose leader died without a result while a straggler keeps the group alive is noticed only at the ceiling plus grace, unless the leader's pid is reused. `ps` is not used for this: it answers nothing both for a dead pid and when it times out, and a live run must not be ended on the second.
- The launchd job, plist and pid file of an adopted run stay until the next spawn's `sweepStale` (the poller that cleans them lived in the dead server). The plist holds the run's environment and is 0600 in the state directory.

## 3. Level-of-abstraction fit

The reap, the queue restore and the exit handling already live in this service; adoption is a third outcome of the reap, resolved by the restore that follows it. A supervisor-side fix (not killing the server) would not help: the run already survives the kill; it was the boot that ended it.

## 4. Signal vs authority compliance

No new writer and no new source of verdicts. An adopted verdict rests on the same thing as any other: the content of `runs/<token>.result.json`, named by a 16-byte token generated per spawn and written 0600 by the child. Adoption is a higher bar than the kill it replaces: the same pid-and-arguments check, plus the input file's repo, PR, head, base, verifier version and policy hash, plus the restore's PR-open and head-unmoved checks, plus the record-matches-entry check before journaling.

A wrong process cannot produce a wrong record: the record is read only from this run's token-named file. The failure mode of adopting the wrong process is waiting, which is bounded by the ceiling.

The base: an adopted entry keeps the base its run started against. A normal run is not cancelled when `main` moves either, and the record carries the base it tested. (`offerMerge` computes and audits whether that base is still current `main`; nothing acts on it today, for adopted and normal runs alike.) An adopted green is in the same position as the green of a normal run that was never interrupted; the reviewer found no case where the first is accepted and the second would not be.

## 4b. Judgment-point check

Not applicable: no judgment call is replaced by a rule.

## 5. Interactions

- **Only the boot adopts.** `reapOrphan({ allowAdopt: true })` is called from `boot()` alone; the reap `tick()` runs while blocked always stops. Otherwise a run found adoptable after the restore would never be matched and the queue would stay blocked until the next restart (the reviewer's blocker; two tests hold it).
- **Boot failure.** Everything after the reap runs inside a `try`; if the boot does not reach the end of the restore, a run the reap decided to keep is stopped, so nothing waits on it.
- **While adoption is pending** `blockedBy` is set, so `pump()` and peer starts refuse; the tick timer starts only after `boot()` returns.
- **After adoption** the marker on disk is unchanged, so `PlannedRestartVerifyGuard` and `restartHolds()` hold a planned restart for it; the queue is persisted with the entry marked in flight again, so a second server kill finds it adoptable again (tested).
- **Cancel and shutdown** work on the process group alone, as for any run; a clean stop settles a written result or interrupts (PR 3139's logic). A cancelled adopted run gets no exit event either, so `tick()` clears it once its group is gone (tested with a moved head), or at the ceiling if it never goes.
- **The tick's order.** The adopted-run check runs only when there is an adopted run. Run unconditionally it added an await at the top of every tick, which delayed the peer heartbeat and poll behind it; an existing peer test caught that before commit.
- **Self-action (class `unbounded-self-action`, closure: guard, `tests/unit/self-action-convergence.test.ts`).** No new controller: a kept run that ends without a result re-drives through the existing, registered local-verify retry rule (bounded error retries, then an error record); the past-ceiling stop fires at most once per run.
- **Suite slot.** The run child holds its own slot; adoption publishes no service claim.
- **Accounting.** No interruption and no error retry are counted for a kept run. A kept run that ends without a result is an error with a retry, as any crashed run.
- **A second service or a recycled pid.** The token is in the leader's arguments only for this run; a recycled pid with other arguments is not adopted, and one that appears later ends the adopted run as crashed.

## 6. External surfaces

`GET /local-verify` shows an adopted run as the in-flight run. New audit events: `orphan-adoptable`, `adopted`, `orphan-not-adopted` (with a reason), `adopted-run-ended` (with why), `adopted-record-mismatch`. New live config key `monitoring.localVerify.adoptRunningRun` (absent means on), read like the existing Local Verify switches; no config default is written and no migration is needed.

## 7. Multi-machine posture

Machine-local by design: each coordinator adopts only its own run on its own machine. A peer-only service never adopts, and a hand-off run found on a coordinator is refused (`peer-attempt`): the coordinator that dispatched it has its own timeout and re-dispatch.

## 8. Rollback cost

Set `monitoring.localVerify.adoptRunningRun` to false (takes effect at the next boot), or revert the commit. Either returns the boot to stop-and-re-run.

## Conclusion

An unplanned server restart no longer costs the PR run in flight. The change adds no way to produce or alter a verdict; its risks are liveness risks, each bounded and tested. Ship behind its switch (on).

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent (general-purpose, read-only; it read the code and did not run the tests, so the pass counts in the release note are mine).

**Round 1: Concern raised.** It found no path to a false green and judged adoption not unsafe in principle for the gate ("it adds no new writer and no new trust beyond what the queue restore already places in the state directory"; the problems were liveness). Findings and what I did:

- BLOCKER B1: a reap from `tick()` could set the adoptable state after the restore had run, and nothing would ever clear it: the queue blocked until the next restart (identity unreadable at boot then readable at the next tick; or an unmatched run surviving its first SIGKILL). Fixed: only the boot may adopt. Two tests; both fail if the fix is removed (checked).
- S1: the end of an adopted run was "group gone" only, with no bound. Fixed: a written result ends it at once, a reused leader pid ends it, and past the ceiling plus grace it is stopped. I did not take "leader pid no longer answers" as an end condition: `readProcessArgs` answers nothing both for a dead pid and for a `ps` that timed out, and ending a live run on the second would kill healthy work.
- S2: the boot's `finally` did not cover the steps between the reap and the restore. Fixed and tested.
- S3: the adopted run's input and record were not fully cross-checked. Fixed: repo, base and base ref added to the input check, a peer hand-off refused, and the record held to the entry before journaling.
- S4: test gaps. Added: both B1 scenarios, a second server kill, a straggler after the result, the ceiling, a reused pid, an unreadable `ps`, a record mismatch, a failed boot, a hand-off input, the switch wiring, cancelling an adopted run on a moved head. Not added: an entry under the preflight-replay store with a live run.
- Nits: the suite-priority publish on adoption removed; a stale comment fixed. Left as stated in section 2: launchd job files until the next spawn; a finished-while-down run is re-run.

**Round 2: Concur.** The fixes verified in the code; no blocker. While it read, I found and fixed one more case myself, which it confirmed would have been real: a cancelled adopted run (a moved head) returned early from the end check, got no exit event, and would have held the in-flight slot for good. Its remaining findings, applied:

- S1: a leader that crashed with a straggler alive still held the gate until the ceiling (about three hours). It pointed out a safe way to tell a dead leader from an unanswered `ps`: a signal-0 probe of the leader pid, which fails with "no such process" only when it is gone. Added as an optional `isPidAlive` seam; the pid-reuse check stays.
- S2: section 4 claimed the merge step compares the record's base with current `main`. It computes and audits that and nothing acts on it. Corrected.
- S3: stale counts and an item listed as not tested that now is. Corrected.
- Nits: the ceiling now also ends a cancelled adopted run whose group never goes; the mismatch audit carries the record's own identity; the mismatch test asserts an error record; the plain-language overview says how long the ceiling is.

**Reviewer concurred:** yes (round 2). The changes made after its second read (the `isPidAlive` seam and the nits above) are covered by tests and were not re-read.

