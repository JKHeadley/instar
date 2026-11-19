# Side-Effects Review — Local Verify: a planned restart no longer cancels a verify that has just finished

**Version / slug:** `planned-restart-exit-gap`
**Date:** `2026-11-19`
**Author:** `echo`
**Second-pass reviewer:** `pending`

## Summary of the change

A narrow bug fix plus observability. A planned restart (`state/restart-requested.json` with `plannedRestart: true` and no `bypassHolds`) is supposed to wait for a running Local Verify. The shared guard, `plannedRestartVerifyState()` in `src/core/PlannedRestartVerifyGuard.ts`, held only while the pid named in `state/local-verify/inflight.json` was alive. The marker is cleared, and the `settling` merge hold written, only inside `LocalVerifyService.onExit()`, which runs when the server's event loop handles the child's exit. In the gap between the two, a restart consumer saw a dead pid and took the restart. On 2026-11-19 at 01:18Z that cancelled a verify 39.6 minutes in whose child had exited with status 0.

The guard now also holds while the marker is present and the pid is gone, for at most 60 seconds from the first sighting (`EXIT_SETTLE_RESTART_HOLD_MS`), ending at once when the marker is cleared. The first sighting is written to a new sibling file, `state/local-verify/inflight-exit-seen.json` (`{ v, attemptToken, seenAt }`), because the two consumers (`ForegroundRestartWatcher.check()` in the server, `ServerSupervisor.checkRestartRequest()` in the lifeline) are separate processes. `LocalVerifyService.clearInFlight()` removes that file with the marker.

`LocalVerifyService.shutdown()` is unchanged in what it does to a run. `finishedResultAtShutdown()` still refuses to settle a finished result when the verifier changed on disk; it now reports that it found one, and `shutdown()` writes a `finished-result-discarded-at-shutdown` audit row with the reason. `shutdown()` also writes one `restart-interrupted-runs` audit row at every stop.

`src/core/restartRequestAttribution.ts`: consumed-request records gain `plannedRestart` and `bypassHolds`. `src/localVerify/operatorQueue.ts` (`bootReason`): the `boot` audit row gains the same two when a request explains the boot.

Files: `src/core/PlannedRestartVerifyGuard.ts`, `src/core/restartRequestAttribution.ts`, `src/localVerify/LocalVerifyService.ts`, `src/localVerify/operatorQueue.ts`, eight test files, an ELI16, an upgrade note. No route, config, hook, skill or template changes. The approved spec `docs/specs/planned-restart-local-verify-hold.md` is referenced and not edited.

`LocalVerifyService.ts` and files in its import graph change, so the verifier version rotates: each machine re-verifies open changes once after it installs.

## Decision-point inventory

- `plannedRestartVerifyState()` / `localVerifyHoldUntil()` (hold or release a planned restart) — modify — a gone pid with the marker still present now holds for a bounded settle window instead of releasing at once.
- `exitSettleHoldUntil()` (new, inside the guard) — add — reads or writes the first-sighting file; decides the end of the window; a failed write does not hold.
- `ForegroundRestartWatcher.check()` and `ServerSupervisor.checkRestartRequest()` — pass-through — unchanged code; they consume the guard's answer as before.
- `LocalVerifyService.finishedResultAtShutdown()` (settle or discard a finished result at stop) — modify in shape only — the same decision as before (settle unless the verifier changed on disk); it now also returns what it found so the discard can be recorded.
- `LocalVerifyService.shutdown()` — modify — two audit rows added; the cancel, the interruption count and the re-queue are unchanged.
- `bootReason()` — modify — two more fields on the row; the rule for when a request explains a boot is unchanged.
- `decideMergeHandoff` (no hand-off while stopping), the three-hour bound, `bypassHolds`, the peer hold, the merge hold — pass-through — unchanged.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The surface is "a planned restart is delayed". Cases where it is delayed and need not be:

- A server that died and left `inflight.json` behind, with its child also gone. Nothing will clear the marker until the next boot's reap. A planned restart that meets it is delayed 60 seconds, once (the sighting is not renewed, and a second request meeting the same marker is not delayed at all). In practice the lifeline restarts a dead server on its own health check, and that boot clears the marker.
- A run that was cancelled (head moved, peer cancel) and whose exit has not been handled yet. The restart waits the fraction of a second until `onExit()` clears the marker, or at most 60 seconds if the event loop is stuck. There is no result to protect in this case; the delay is the cost of not distinguishing it.
- A run child that crashed without a result. Same as above: `onExit()` records the error and clears the marker.

A forced restart (`bypassHolds: true`), an unplanned request and a request three hours old are not delayed; tests assert each.

---

## 2. Under-block

**What failure modes does this still miss?**

- **The lifeline runs old code.** The supervisor keeps the guard it started with until the lifeline itself restarts (this was seen with the peer hold on 2026-11-06). Until then only the server's own watcher has the settle window. The measured loss went through the server's watcher, and the watcher polls every 10 seconds like the supervisor, so the gap stays open on the supervisor side until its next restart.
- **An exit handler that takes longer than 60 seconds** from the first sighting. The restart then goes ahead; if the result is on disk and the verifier is unchanged, `shutdown()` settles it; if the verifier changed, it is discarded and now counted (`finished-result-discarded-at-shutdown`). Measured gaps were well under a second.
- **A sighting that cannot be written** (disk full, permissions). The guard does not hold and logs one line. This is the behaviour before the change.
- **Forced restarts and signals.** A `bypassHolds` request, a SIGTERM from outside, or the updater's ceiling still stop the server mid-run by design. They are now counted by `restart-interrupted-runs`, not prevented.
- **A finished result at a stop with a changed verifier is still discarded.** Recording it was examined and refused: the merge hand-off is refused while the service is stopping, the status poster is already stopped (`server.ts` stops it before `shutdown()`), a merge is several network calls, and teardown has a hard 20-second deadline. A record with no merge would be skipped by the next verifier's index and would also take the entry out of the queue.
- **Attribution of a stop to a request** uses the last consumed request if it is at most two minutes old and is not the request this process's own `boot` row named (a process that boots from a request and is stopped by a signal within two minutes is therefore not labelled with it). What remains: a stop by signal within two minutes of a request that was consumed but did not lead to a new boot of this service (for example, a request recorded while the service was not yet started) would be labelled with that request.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The guard is the one function both restart consumers already call, so the window is added once and neither consumer changes. The alternative, closing the gap inside the server (for example having the watcher ask the service object), would not cover the lifeline, which has no service object. The alternative of making `shutdown()` rescue the result was examined and is the wrong layer: by then the hand-off cannot complete.

The audit rows are written by the service, which is the only place that knows the in-flight run and the accepted peer attempts. The request fields are recorded by the existing recorder both consumers already use.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change adds no refusal and no new authority: it extends a bounded, deterministic delay that the approved spec already classes as an invariant (explained below).
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design. Brittle detectors must not own block authority. Either promote the logic to smart-gate level (with proper context) or demote it to a signal that feeds an existing smart gate.

The second box is ticked with its wording adjusted, because the stock wording ("no block/allow surface") would overstate it: there is a surface, a delay. The guard delays (never refuses) a planned restart using a deterministic rule over two files and a pid probe. That is the same kind of authority the guard already held under the approved spec (`planned-restart-local-verify-hold.md` classes it as an invariant: "typed marker plus PID liveness, bounded at three hours; unreadable input never defers; `bypassHolds` overrides"). The domain is enumerable (marker present or absent, pid alive or gone, sighting inside or outside 60 seconds), the delay is bounded and cannot renew, every unreadable input releases, and the operator override is unchanged. No message content or human intent is judged.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

**Does this change add a static heuristic at a competing-signals decision point? If yes: why is it not a judgment point within a floor?**

No new static heuristic at a competing-signals decision point. The rule added is an invariant over an enumerable domain: "a run whose marker is still present is not finished being handled; wait at most 60 seconds for the marker to go". There are no competing live signals to weigh; the bound is a safety limit on a delay, and the existing override (`bypassHolds`) stays the operator's.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** the settle window is computed inside `localVerifyHoldUntil()`, before the peer hold and the merge hold are combined, exactly where the pid check was. It cannot shadow the merge hold: `onExit()` writes the `settling` marker before it clears `inflight.json`, so a consumer sees the settle window, then the merge hold, never neither. A unit test asserts the take-over.
- **Double-fire:** both consumers may see the gone pid in the same second and both write the sighting. The write is atomic (temporary file and rename) and both write nearly the same time; whichever lands last decides, and the difference is bounded by the gap between the two polls. Later calls read the file and never rewrite it for the same attempt token.
- **Races:** `clearInFlight()` removes the sighting after the marker. If a consumer reads the marker just before it is removed and then writes a sighting after `clearInFlight()` ran, a sighting file is left with no marker. It is harmless: it is keyed by the attempt token, the guard reads it only when a marker with that token is present, and the next run's sighting replaces it.
- **Callers inside the service:** `notePause()` and the peer-hold audit call `readPlannedRestartVerifyState()` on each tick, so the service itself can write the sighting when a planned request is pending and its own child's pid is gone. That is the intended first sighting. `notePause()` reads `pending` and `deferredDelivery`, not `hold`, so its pause decision is unchanged. The peer-hold audit reads `hold`; with the window it can now see `hold: true` for up to 60 seconds longer, which matches what the restart consumers see.
- **`markPlannedRestartDeferred()`:** it calls the guard and so now also marks a request as deferred when it waited only for the settle window. That gives the request the extended delivery time, which is correct: it did wait for a verify.
- **A record written in the window can still be unusable after the restart.** When the verifier changed on disk and the run was red, or the merge line is off, the record written in the window is skipped by the next boot's index and the entry has left the queue. That is existing behaviour for any run that finishes just ahead of an update restart. The window's saving is the green run with a merge hand-off, and restarts that do not change the verifier.
- **A failure while building the `restart-interrupted-runs` row** is caught inside `shutdown()`: a minimal row with the error is written and the cancel, the interruption count and the queue persist run as before. Fields read from files (the request log, persisted queue entries) are type-checked and left out when malformed.
- **Feedback loops:** none. The window does not renew, and while a planned restart waits the service starts no new run (existing pause), so a new marker cannot appear to extend the wait.
- **The `restart-interrupted-runs` row** is written before the cancel, so `childExited` is read before the group is signalled. It reads `logs/restart-requests.jsonl` once (tail only, 8 KB).

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- Other agents on the same machine: no.
- Other users of the install base: a planned restart can be up to 60 seconds later in the cases listed under Over-block. The verifier version rotates, so every install with Local Verify on re-verifies open changes once.
- External systems: none. No GitHub, Telegram or network call is added.
- Persistent state: one new small file, `state/local-verify/inflight-exit-seen.json`, written through `SafeFsExecutor.atomicWriteJsonSync` and removed with the in-flight marker. Two new audit events in `logs/local-verify.jsonl` (`restart-interrupted-runs`, `finished-result-discarded-at-shutdown`). Two new fields on records in `logs/restart-requests.jsonl` and on the `boot` audit row. Readers of older records see the fields absent; `readLastRestartRequest` accepts both shapes and a test covers it. The new file is not in the state-coherence registry; neither are its siblings `merge-hold.json` and `peer-hold.json`, which are written the same way, and `npm run lint` (which runs the registry lint) passes.
- Timing: the pid probe and the file read happen on the consumers' existing 10-second polls; no new timer.
- **Operator surface:** No operator-facing actions. The new rows are read from the log; no route or dashboard is added.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The in-flight marker, the sighting file, the pid and the restart request all describe one machine's server process and its own child. A restart of the Studio must not wait for the M5's child, and a pid means nothing on another machine. The audit rows are per-machine observability of that machine's restarts; the pool-wide question ("how many restarts interrupted work") is answered by reading each machine's log, as with the existing `interrupted` and `boot` rows.

No user-facing notice is emitted. The durable state added (one file) is tied to one run on one machine and does not move with a topic. No URL is generated.

**Status surfaces:** none new or changed. `/health`'s `bootReadiness.previousRestart` returns the consumed-request record, which now has two more fields; its scope (this machine) is unchanged.

---

## 8. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix release:** revert the change and ship a patch. The verifier version rotates again on the revert, so open changes are re-verified once more.
- **Data migration:** none. A leftover `inflight-exit-seen.json` is ignored by older code. The extra fields in the two logs are ignored by older readers.
- **Agent state repair:** none.
- **User visibility:** none beyond the one re-verify. If the window itself misbehaved (held when it should not), the worst case before a rollback is a 60-second delay per planned restart, and `bypassHolds: true` skips it.

---

## Conclusion

The review confirmed the fix belongs in the shared guard, bounded and non-renewing, with the first sighting in a file so both processes agree. It changed one design point during the work: the shutdown path was not changed to record a finished result under a changed verifier, because the record could not be merged before exit; the discard is recorded instead. Two limits are stated plainly for the reviewer: the lifeline keeps its old guard until it restarts, and the e2e and integration cases added here were written and not run on the authoring machine. The class-closure fields below are not applicable in the reviewer's sense, with the reason given. Clear to ship after the second-pass review and a green Local Verify.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, read-only), run by the scaling session on 2026-11-19 at about 04:30 PST against the uncommitted change
**Independent read of the artifact: concur**

The reviewer traced both restart consumers through the guard and confirmed the cause of the measured loss in the code: the in-process watcher emits its restart event and the shutdown runs in the same tick the test process is seen as gone, before the queued exit handler can record the result. With the change the watcher returns on the hold, the exit handler runs, and the run is settled. It confirmed that forced and non-planned restarts and the lifeline's other restart paths are never held, that a stale marker holds once for at most 60 seconds, that a new run always gets its own window, and that with no Local Verify configured nothing runs. It agreed that refusing to settle a finished result at shutdown when the verifier changed on disk is the right call, and that no version check was weakened. Its run: five unit files, 280 tests passed; `tsc` clean.

Its recommendations, all applied in this commit: the shutdown row is wrapped so a malformed record can never stop the shutdown's own bookkeeping, with type-safe field reads; one sentence about the order of two steps was corrected in the constant's comment, the plain overview and the upgrade note; and a request already named by this process's own boot row no longer explains its stop. These last edits were tested (five unit files, 412 passed) but not re-read by the reviewer.

Stated plainly, as the reviewer asked: the lifeline keeps its old guard until the lifeline itself restarts, so until then its poll can still take a planned restart in the gap; the measured loss went through the in-process watcher, which has the fix as soon as the server restarts.

Not checked by the reviewer: the e2e and integration cases were read but not run; lint was run by the builder (clean).

**Second round, after main was merged in (2026-11-19, about 05:10 PST).** Main had gained "run the test files most likely to fail first" (PR 3497), which adds a comparison run to the same service. One conflict, in the service's shutdown step, was resolved by hand: a stop first ends any comparison run (main's lines), then writes the restart row and settles or interrupts the verify (this change's lines). A second independent reviewer (Codex, `codex exec`, read-only, fresh context, no access to the first round's conclusions beyond this file) read the merge delta and the merged files. **Independent read of the merged result: concur**, no must-fix. What it confirmed in the code: ending a comparison run touches only the comparison's own state and cannot change the verify's result; a stop cannot queue or start a comparison run, on the coordinator or through a helper's exit path; a comparison run has its own marker file, so it neither extends nor triggers the settle window; the tests of both sides are intact and still test what they say. One thing it asked to be stated plainly: when a stop interrupts only a comparison run, the restart row lists no interrupted verify (correct: no verdict was lost) and the comparison's end is written in its own row, so the restart row must not be read as "no test work was thrown away". No test covers a stop during a settle window while a comparison is pending; the reviewer judged the static reading enough. After the merge: `tsc` clean; ten unit files (538 tests) passed on the authoring machine; the e2e and integration cases were again read but not run.

---

## Evidence pointers

- Unit, run on the change: `tests/unit/planned-restart-verify-guard.test.ts`, `tests/unit/ForegroundRestartWatcher.test.ts`, `tests/unit/boot-readiness.test.ts`, `tests/unit/localVerify/operatorQueue.test.ts`, `tests/unit/localVerify/operatorHoldService.test.ts` (135 tests, 5 files, passed); `tests/unit/localVerify/LocalVerifyService.test.ts`, `tests/unit/localVerify/peerVerifier.test.ts`, `tests/unit/self-action-convergence.test.ts`, `tests/unit/supervisor-kickstart-race.test.ts`, `tests/unit/server-supervisor-respawn-guarantee.test.ts` (1201 tests, 5 files, passed).
- Written, not run on the authoring machine: the exit-gap case in `tests/e2e/planned-restart-local-verify-lifecycle.test.ts` and in `tests/integration/planned-restart-local-verify.test.ts`.
- The measured loss: 2026-11-19 01:18Z, a verify 39.6 minutes in, child exit status 0, cancelled at shutdown after a plain planned restart request was consumed by the server's own watcher.
- Plain-words overview: `docs/specs/planned-restart-exit-gap.eli16.md`. Upgrade note: `upgrades/next/planned-restart-exit-gap.md`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is in TypeScript code (a liveness check with a blind spot), not in a prompt, hook, config, skill or standards text.

On the self-action clause: this change adds no self-triggered controller and does not change what any controller does. It changes one input to two existing restart consumers so that they act later, never more often. For the record, the convergence argument for the added hold: the trigger is a planned request meeting a marker whose pid is gone; the action is "do not consume the request on this poll"; the bound is 60 seconds from one stored first sighting per attempt token, never renewed, and capped by the run's and the request's existing three-hour bounds; the brake is that a spent sighting is read and never rewritten, and that no new run starts while a planned restart waits. `tests/unit/self-action-convergence.test.ts` was run on the change and passed.
