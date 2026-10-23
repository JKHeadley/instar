# Side-Effects Review — transfer drain must not hand ownership away from a session it could not close

**Version / slug:** `transfer-drain-close-refused`
**Date:** `2026-10-23`
**Author:** `Echo`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 1 (a revert fully undoes it), 6 source/test files, ~150 LOC, 1 review round. Fixes the 2026-10-23 incident (Echo Bugs topic 10000000662, feedback fb-89bac4be-9b3): a `/pool/transfer` drain ordered the remote owner to close its session and hand over; the close was refused (`not-lease-holder` — the old owner is not the serving-lease holder — and `recent-user-message`), but `SessionDrainRunner` landed the target claim anyway. Two live sessions then served one conversation.

Files: `src/core/SessionDrainRunner.ts` (a refused/thrown close aborts via the existing abort-transfer CAS, new status `refused-close-failed`; `isNothingToClose()` classifies no-local-session / not-found / already-* as not-a-refusal), `src/core/SessionManager.ts` (`topicTransferClose` additionally lifts the lease-holder gate and the `recent-user-message` keep), `src/server/routes.ts` (`/pool/transfer` returns 409 `failedNeedsRetry` with no pin for `refused-close-failed`), plus tests in `tests/unit/SessionDrainRunner.test.ts`, `tests/unit/session-manager-terminate.test.ts`, `tests/integration/pool-placement-transfer-routes.test.ts`.

## Decision-point inventory

- `SessionDrainRunner.run` step 4 (land target claim) — modify — now conditional on the local close having happened (or there being nothing to close).
- `SessionManager.#terminateSessionInternal` lease-holder gate — modify — `topicTransferClose` joins the existing runtime-private carve-outs (topic-moved closeout, local age limit).
- `ReapGuard` cascade via `bypassedReasons` — modify — `topicTransferClose` adds `recent-user-message` to the bypassed set (it already added `standing-session`).
- `/pool/transfer` drain leg — modify — `refused-close-failed` joins `aborted-emergency-stop` as a no-pin 409.

---

## 1. Over-block

A move that previously "succeeded" (pin set, ownership moved, old session alive) now returns 409 when a remaining keep-guard refuses the close: protected session, active subagent, pending injection, relay lease, recovery in flight, structural long work, active process when the turn boundary was reached cleanly (force is only set at the bound), main-process activity, spawn grace, in-flight terminate. That is the intended direction: those moves were the split. The caller is told the reason and can retry. A topic owned by a protected session can no longer be moved by drain at all — before, it moved and left the protected session as a duplicate; now it is refused. Acceptable: a protected session is by definition one the system must not end.

## 2. Under-block

- If the drain RPC times out on the holder (50 s) and the owner later aborts, the holder has already degraded to the pin path (pin set, ownership not moved). The OwnershipReconciler/closeout machinery then converges as it did before this change; this fix does not alter that path. The owner, however, can no longer move ownership away from a live session, which removes the incident's split.
- A suspended autonomous run is left suspended on abort (same as the existing emergency-stop and ledger-refused aborts). The run's state file survives with `moved_to` markers; resuming it is the operator's call. Not changed here.
- The duplicate-session stand-down (dark/dry-run) is unchanged; it is the after-the-fact detector. This fix prevents the duplicate at its source for the drain path.

## 3. Level-of-abstraction fit

Right layer. The claim CAS is the single point where ownership leaves the owner, and the owner is the only party that knows whether its session closed. Fixing it in the route alone (reading `seatMoved`) would be too late: the owner had already landed the claim. The terminate-authority change sits beside the two existing runtime-private carve-outs with the same rationale (closing this machine's own copy of a topic that is moving away).

## 4. Signal vs authority compliance

No new brittle blocking check. The change makes an existing authority (ownership hand-over) honour the result of another existing authority (the terminate chokepoint and its keep-guards) instead of ignoring it. The two lifted guards are lifted only for a runtime-private flag that only the drain runner passes after a fenced transferring CAS; public `terminateSession()` cannot supply it (it copies only inert fields).

## 4b. Judgment-point check

No competing-signals heuristic added; the classification of terminate skip reasons is a closed, deterministic mapping of the authority's own outcome codes.

## 5. Interactions

- Emergency-stop abort and ledger-refused abort share the same `abortTransfer` helper (restore delivery ledger, audit). The new status reuses it unchanged.
- `seatMoved` computation in the route is unchanged; for `refused-close-failed` the route returns before it.
- Post-transfer closeout (`localPostTransferCloseout`) is untouched; it still closes leftovers on the other paths.
- The reap-log labels a drain close's `authorityScope` as `local-post-transfer-closeout` on a non-holder (existing enum; `via: 'ws12-drain'` distinguishes it).

## 6. External surfaces

`/pool/transfer` can now answer 409 `failedNeedsRetry` with `drain.status: 'refused-close-failed'`, the refusal reason by name in `error` (for a REMOTE owner `_sendDrain` now reads the runner's `detail` as the reason — before the second pass it was dropped on the mesh hop), and `autonomousRunSuspended` (the run is suspended BEFORE the close is attempted and stays suspended on abort, exactly like the emergency-stop abort; the 409 says so). Agents already handle the 409 `failedNeedsRetry` shape for emergency stop. A remote drain close now actually ends the old owner's session (the `interrupted-mid-task` notice path already existed).

## 7. Multi-machine posture (Cross-Machine Coherence)

This is a cross-machine fix by nature: owner-side (any machine that owns a topic) and holder-side (the router). Mixed versions: an old owner still lands the claim after a refused close (old behaviour); a new owner aborts and an old holder treats the unknown status as a non-abort and degrades to the pin path (old behaviour, no worse). Both machines on the new version get the full fix. No replicated state shape changes. Named loose end in the mixed case: the holder's pin rests diverged from the owner (U4.1 `pinState: diverged` raises one item after its window) and the holder answers 200 for a move that did not happen — the pre-existing degraded behaviour, not widened here.

## 8. Rollback cost

Revert the commit and ship a patch. No data migration, no config, no persisted state introduced.

## Conclusion

Ship. The change closes the incident's mechanism with the existing abort CAS and narrows two terminate refusals to the one trusted caller that needs them.

## Second-pass review (if required)

**Reviewer:** second-pass reviewer subagent (Claude)
**Independent read of the artifact: concur**

- The diff does what the artifact says and the split is closed at the right point: `SessionDrainRunner.run` aborts via the existing abort CAS before the claim (src/core/SessionDrainRunner.ts:284), and `isNothingToClose` is a closed mapping of the terminate authority's own skip codes — no new brittle blocking authority; the drain now honours an existing authority's verdict. Signal-vs-authority: compliant.
- `topicTransferClose` is genuinely runtime-private: public `terminateSession` copies only inert fields (SessionManager.ts:2051), and the only setter is the birth-bound closure in the drain runner dep (server.ts:24344), reachable solely through the mesh `drain` verb (router-only RBAC) behind the runner's own ownership + epoch + transferring-CAS fence. A thrown close is handled in the safe direction: the internal path compensates a failed tmux kill and isolates listeners, so the one way a throw follows a real kill (an unwrapped post-kill call) leaves ownership on a machine with no live session, which cold-respawns — never two live copies.
- **Concern 1 (fix before merge; does not reopen the split):** for a REMOTE owner — the incident's own topology — the refusal reason is lost on the mesh hop. The `drain` handler returns `{ ok, ...outcome }` whose field is `detail` (server.ts:24760), but `_sendDrain` reads `r.reason` (server.ts:25167), so the route's 409 reads "(close refused)" instead of `close-refused:protected` / `active-subagent`. Q1 and Q6's "the caller is told the reason and can retry" hold only for the local-owner arm (which maps `reason: o.detail`). The integration test mocks `sendDrain` with a populated `reason`, so it cannot see this. One-line fix either side.
- **Concern 2 (reporting gap):** the suspended autonomous run is not reported. Step 2 sets the run `active:false` with `moved_to:<target>` BEFORE the close is attempted; on `refused-close-failed` the run stays suspended on the machine that kept the topic, there is no un-suspend helper in `AutonomousSessions.ts`, and the route captures `drainRunSuspended` but omits it from the 409 body (routes.ts:22789-22794). An operator who confirmed "moving suspends real work" gets the suspension without the move and is not told; a retry converges only if the keep-guard clears (never for `protected`). Add `autonomousRunSuspended: drainRunSuspended` to the 409 at minimum.
- Mixed versions (Q7) check out: `status` survives the hop, so a new owner + old holder degrades to the pin path where the place→claim repair is refused (record is `active@owner`) — no split, but the pin rests diverged (U4.1 `pinState` raises one item after its window) and the holder answers 200 for a move that did not happen. "No worse" is accurate; the diverged pin is the loose end worth naming.
- Minor: `usesLocalProcessAuthority` (SessionManager.ts:2355) omits `topicTransferClose`, so a standby write refusal is labelled `state-write-refused` rather than `local-write-refused` — both abort, cosmetic. Session-scoped writes on a read-only standby are admitted only while the pool is active, which is the same block that builds the runner, so the lease-gate lift cannot strand a close on the write guard. Lifting `recent-user-message` unconditionally relies on the target's spawn-time history carrying a message the old session accepted but had not started (`sessionQuiet` = not actively working); pre-existing drain property, now load-bearing.
- **Re-check after fixes:** Concern 1 resolved — `_sendDrain` reads `r.reason ?? r.detail` (server.ts:25166), so a remote `close-refused:<skip>` reaches the 409 by name. Concern 2 resolved — the `refused-close-failed` 409 carries `autonomousRunSuspended: drainRunSuspended` and names the suspension in `error` when true (routes.ts:22789-22798); the integration test asserts both. The run is still not un-suspended on abort (stated honestly in the response; a retry or the operator converges it). Residual: the integration mock still bypasses the server.ts mapping, but that mapping is a plain typeof fallback. Verdict moved to concur.

## Evidence pointers

- Unit: `tests/unit/SessionDrainRunner.test.ts` (refused × 5, thrown, nothing-to-close × 4).
- Unit: `tests/unit/session-manager-terminate.test.ts` (drain close on non-holder + recent message terminates; public path lease-refused; active subagent still vetoes).
- Integration: `tests/integration/pool-placement-transfer-routes.test.ts` (409, no pin, ownership/epoch untouched).

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
