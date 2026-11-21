# Side-Effects Review — Local Verify: hold a change and move a change to the front, without a restart

**Version / slug:** `local-verify-queue-controls`
**Date:** `2026-11-19`
**Author:** `echo`
**Second-pass reviewer:** `pending`

## Summary of the change

Two operator controls on the Local Verify coordinator, each an HTTP route that takes effect at once and never touches a running verify: **hold** (`POST /local-verify/queue/hold`, ended by `/release`) and **front** (`POST /local-verify/queue/front`, ended by `/unfront`). Both are off unless `monitoring.localVerify.queueControls` is `true` on that machine (absent means off; the routes then answer 404). Spec: `docs/specs/local-verify-queue-controls.md` (approved, converged in 6 rounds).

The operator's choices are stored per pull-request number, not on a queue entry, in a new file `state/local-verify/operator-queue.json` (written atomically, with the previous good copy kept beside it). The store is a new module, `src/localVerify/operatorQueue.ts`. `src/localVerify/LocalVerifyService.ts` reads it at four moments: admission (`request()`), the start check (`nextRunnableQueuedEntry()`), the peer hand-off (`dispatchable()` and the pick inside `dispatchOnce()`), and completion (`complete()`, which ends a front mark). `src/localVerify/waitingList.ts` gains `put()` (place a change on the list without a refusal) and the removal reason `held`. `src/localVerify/localVerifyRoutes.ts` gains the four routes and their strict body parser. `src/server/routes.ts` passes the merge watcher's `applyHold` to those routes and now cleans the merge-side reason through one shared function. `src/localVerify/localVerifyWiring.ts` wires the live switch and gives the three new notices plain titles. Also: a `boot` audit row at each start with the restart reason when one was carried, a state-registry entry, a ladder entry, an awareness entry.

`LocalVerifyService.ts` is part of the verifier's version, so the verifier version changes with this build: every machine re-verifies open changes once after it installs.

## Decision-point inventory

- `LocalVerifyService.request()` (admission) — modify — a held change answers `held` and admits nothing; an operator front or release may admit over the cap within its own budget of 5.
- `LocalVerifyService.nextRunnableQueuedEntry()` (the start check) — modify — a held change is never started; fronted changes are first among changes. The turn between the `main` verify and changes (`decideStart`) is not changed.
- `LocalVerifyService.dispatchable()` and the pick in `dispatchOnce()` (the peer hand-off) — modify — a held change is never handed to a peer; the same order as the local pick; the choice is made again after the base read, at the point of reserving.
- `LocalVerifyService.complete()` — modify — a result for a fronted change's current commit and target branch ends its mark.
- `LocalVerifyService.doRestoreQueue()` — modify — the restore bound is raised by 5 when the controls are on or over-cap admissions were recorded; a restored entry of a held change goes to held.
- `OperatorQueueStore.load()` (unreadable file) — add — the previous good copy is used; if that fails too the store starts empty and the service reports it at once.
- The four routes' gates (`controlGate` in `localVerifyRoutes.ts`) — add — 503 with no service, 404 with the switch off, 409 on a machine without the coordinator lease, 400 for a body that is not exactly the allowed fields.
- `decideStart` (main verify against changes), the main-red hold, the update pause, the memory hold, the verifier hold — pass-through — unchanged; front passes none of them.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

- A held change whose hold was forgotten is refused testing until someone releases it. That is the control's purpose, bounded by one reminder (at `until`, or after 24 hours) and by the queue view listing every hold with its age. The reminder is sent once; a hold nobody acts on after that stays in force with no further notice.
- The watcher's request for a held change answers `held` every ten minutes and costs one GitHub read each time (whether the change is still open).
- A reason longer than 500 characters or a `by` longer than 100 is refused with 400, never cut. An operator pasting a long note must shorten it.
- A fourth front is refused (`front-limit`) even when the three existing marks are on changes that are held or already running. The answer names the three so one can be unfronted.
- A release that finds the queue and the operator overflow both full puts the change at the head of the waiting list instead of the queue. The waiting list holds only the change number, so a saved re-test against a newer base that the hold carried is **not** kept in that one case: the change is admitted by its next ordinary request, under the ordinary rules. The answer says so (`detail: "placed on the waiting list; the saved re-test was not kept"`) and the audit row carries `savedEntryDropped: true`. This is a narrower result than the spec's "release restores what the hold took".
- A `until` that is not a date a calendar can hold (a number such as 1e300) is refused with 400 before anything is stored. A hold or front mark on disk with such a time, or with a bad `by` or `reason`, is left out at load; that change is then not held. A hold whose saved queue entry or waiting-list place is malformed (a wrong type, a negative count, a branch name the record validator refuses) stays in force without it. Both cases write one `operator-file-invalid-record` audit row per pull request and raise the unreadable-file attention item once; the file is rewritten without the bad parts, so the next start does not repeat it.
- With the switch on, a replay admission for a held change is skipped while it is held (it spends no admission attempt) and resumes after the release.

## 2. Under-block

**What failure modes does this still miss?**

- A hold stops testing, not merging: a held change that already has a passing result can still merge unless the request carried `blockMerge: true`. The answer states which of the two holds applied.
- A hold that arrives while the change is running does not stop that run, and its result is recorded as usual (a pass can then merge). This is the spec's rule: no control cancels a running verify.
- If neither the operator file nor its previous copy can be read, the service continues with no holds. A held change may then be tested. This is reported at once (audit row and one attention item); stopping a wrong change from merging is the merge-side hold's job.
- If the coordinator lease moves to another machine, that machine has no holds. The old holder sends one notice listing them to the session that operates the line: an agent message through the server's own message router (the sender behind `POST /messages/send`) to the session named in `monitoring.localVerify.operatorSession`. It counts as sent only when the router reports it delivered. When the setting is absent, the message is only queued (the session is not running) or the send fails, the notice is an attention item instead, and the audit row records the path and the router's phase. The setting is not set by default, so until an operator sets it the notice reaches the attention queue only.
- `by` is a label, not a proof of identity. Anyone who holds the server's credential can hold or front, and can write any name.
- A front mark on a change whose verify ends in an error that is not re-run (a merge conflict, or the one automatic re-run already spent) is ended, because no result is coming. A mark on a change that is never requested again and never gets a result stays until it is unfronted or the change closes, and uses one of the three places.
- The operator overflow counts an entry for as long as it is queued, so five over-cap admissions that sit in the queue block a sixth even after the queue has drained below the cap.

## 3. Level-of-abstraction fit

**Is this at the right layer?**

Yes. The queue, its order and its start decision live in `LocalVerifyService`; the controls are read exactly there, at the moment of each decision, not in a wrapper that could disagree with it. The store is a small separate module with no knowledge of what a hold means, modelled on `waitingList.ts`. The existing main-red hold is the closest neighbour: it filters entries that stay in the queue. The operator hold takes the entry out instead, because the spec requires the held change to stop counting toward the cap and to free its place; the start check and the dispatch check still filter held changes, so an entry that could not be moved yet (the operator file was unwritable) is refused all the same. The merge-side hold is not re-implemented: `blockMerge` calls the same `GreenPrAutoMerger.applyHold` the existing route calls.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [x] No — this change has no block/allow surface with brittle logic: an exact number-in-list check under an explicit operator instruction.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [ ] ⚠️ Yes, with brittle logic — STOP. Reshape the design.

The block is an explicit operator instruction, not an inference. A change is held only because an operator (an agent session or a person holding the server's credential) named that change number and gave a reason; the code compares a number against a list. Nothing here guesses intent from text, labels or timing, and no model is involved. The spec declares each decision point an invariant over an enumerable domain (the change number is in the hold list or it is not). The `do-not-merge` label is deliberately not turned into a hold.

## 4b. Judgment-point check (Judgment Within Floors standard)

**Does this change add a static heuristic at a competing-signals decision point?**

No new static heuristic at a competing-signals decision point. The five decision points in the spec's `## Decision points touched` table are invariants over enumerable domains: held or not held, fronted with a rising number or not, a counted budget of 5 and a limit of 3, running or not running, file readable or not. The one place where signals compete, whose turn it is between the `main` verify and changes, is left to the existing `decideStart` and is not changed: a due `main` verify always goes next.

## 5. Interactions

- **Shadowing:** the held check in `request()` runs before the main-unhealthy check and before the PR view is read, so a held change answers `held` where it would otherwise have answered `main-unhealthy`, `recorded` or `in-flight`. Callers treat all of these as "nothing queued". The replay admission loop would have counted `held` as a failed admission; it now skips a held change instead. The red-to-green re-run of failures logs `held` for a held change and moves on.
- **Double-fire:** a hold removes the entry and the start and dispatch checks also filter held changes. Both can be true for the same entry only when the removal's file write failed; then the entry stays queued and is refused by the checks. The sweep and a hold request both call one function (`takeToHeld`), which is a no-op when there is nothing to take. Each hold has one reminder (`reminded` is stored); the lease notice is sent once (`leaseNoticeAt` is stored).
- **Races:** a hold request does its room check first (the only wait), then writes the file, takes the entry and answers with no further wait; a start (`pump()` from pick to `start()`) and a peer reservation (the re-check to `persistQueue()`) are also unbroken once their base read has returned. So a hold and a start cannot interleave: whichever runs first decides both the answer (`running`) and whether the verify starts. The base read between a pick and its start is the one wait; after it the local path picks again from scratch, and the peer path now re-runs its pick and gives way when a different entry ranks first (at most three times per dispatch pass). A release that is reading the change when a second hold arrives sees its `releasing` mark gone and places nothing more.
- **Feedback loops:** a front admission adds queue entries past the cap, which the restore bound must then bring back; the bound is raised by the same 5. A held change's entry leaving the queue lets the waiting list fill the place, which is intended. The switch going off puts held-and-wanted changes back through ordinary admission once (the saved entry, waiter and wanted mark are cleared as each is placed), so repeated ticks do not re-admit.
- **Self-triggered work added, and its bounds:** the hourly check (at most one GitHub read per due hold plus 25 others per pass; one reminder per hold, ever); the tick retry of a release or a front admission that could not read the change (at most 20 ticks each, then given up with an audit row); the switch-off re-admission (one placement per record, the unreadable case bounded at 20 tries); the lease notice (once). None is registered in `src/testing/selfActionRegistry.ts`: the emit detector does not fire on these calls, and no convergence model was written. Listed for the reviewer.

## 6. External surfaces

- **Other agents on the same machine:** none. The file is under this agent's state directory.
- **Other users of the install base:** none until an operator sets the switch. With it off the four routes answer 404, `GET /local-verify` has no `operator` block, and the queue behaves as before; the 328 existing unit tests of the service, the main-red hold, the waiting list, the peers and the routes pass unchanged. Two things happen on every install regardless of the switch: one `boot` row is written to the Local Verify audit log at each start, and the verifier version changes.
- **External systems:** with `blockMerge: true` the hold calls GitHub through the existing merge-side hold (a `[HOLD]` marker on the change). Nothing else new reaches GitHub; a held change's request costs one "is it open" read.
- **Persistent state:** one new file, `state/local-verify/operator-queue.json`, with `operator-queue.json.prev` beside it; at most 200 records. Registered in `src/data/state-coherence-registry.json` as `local-verify-operator-queue` (machine-local, fixed cardinality).
- **Timing:** the hourly check runs on the service's existing 30-second tick.
- **Operator surface (Mobile-Complete Operator Actions):** the controls are HTTP routes used by an agent session (the operator of the line is the throughput session), reached conversationally. There is no dashboard or phone form. The spec records this as a deliberate later change (Frontloaded Decision 9: "A phone or dashboard surface for these controls is a later change"). A person who wants to hold or front a change from a phone asks the agent.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable. No dashboard renderer, approval page or form is added or changed.

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN.** The queue belongs to the machine holding the coordinator lease and its files are machine-local (operator-ratified exception, commit 6a8c3a2c26afeb3df573d5a9ae9e93ce775b3f17, the approved Local Verify capacity spec). The holds describe that machine's queue. The limit this leaves is stated in the spec: if the lease moves, the new holder cannot read the file and starts with no holds, as it starts with no queue.

- **User-facing notices:** three, all raised by the coordinator only (the routes answer 409 elsewhere, and the hourly check and the pending work run only while the lease is held). The exception is the lease notice, which by its nature is raised by the machine that just lost the lease, once.
- **Durable state:** yes, and it strands on a lease move. That is announced by the notice above, and a machine that gets the lease back keeps its records and writes one audit row listing them.
- **URLs:** none generated.
- **The peer:** needs no change. A held change is never handed to it, and it receives changes in the coordinator's order.

**Status surfaces:** `GET /local-verify` gains an `operator` block (held and fronted changes, the overflow in use) only while the switch is on. It is this machine's view and is lease-gated like the rest of that route: a machine without the lease answers 409 naming the holder, so a dark holder is never shown as "nothing held". No `/status`, `/health`, `/capabilities` or `/channels` answer changes.

## 8. Rollback cost

- **Hot-fix release:** set `monitoring.localVerify.queueControls` to `false` (or remove it). It is read live. Held changes that were wanted are put back through ordinary admission on the next tick, the routes answer 404, and the order is the order as it was. No release is needed to back out.
- **Data migration:** none. The operator file is ignored while the switch is off. To clear the stored choices delete BOTH `operator-queue.json` and `operator-queue.json.prev`: deleting only the file makes the next start restore the holds from the previous copy (and report that it did). A build without this change reads neither.
- **Agent state repair:** none. A revert of the code changes the verifier version again, so each machine re-verifies open changes once more.
- **User visibility:** none for agents that never turned the switch on.

## Conclusion

The review changed the build in four places. The start check and the dispatch check filter held changes in addition to the removal, so an unwritable operator file cannot let a held change start. Front marks no longer reorder the queue itself, so an unfronted change is back in its ordinary place (the first version left it at the front). The replay admission loop skips a held change instead of spending attempts on it. The switch-off re-admission retries an unreadable change a bounded number of times.

After the second pass: times are bounded to what a calendar can hold at the route and on disk; a double corruption is reported once; the lease notice goes to the operating session when one is named; a release that cannot keep a saved re-test says so; a saved entry from disk is checked field by field. Still open: the self-triggered work is bounded but has no entry in the self-action registry; the integration and end-to-end tests were written and type-checked but not run in this session.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (general-purpose, fresh context, read-only), run by the scaling session on 2026-11-19 between 00:55 and 01:25 PST against the uncommitted change
**Independent read of the artifact: concur**

First read: **object**, with three must-fixes and two should-fixes. It confirmed that nothing changes with the switch off, that front cannot move a due main verify, and that a held change cannot start by any re-entry path. Its findings, all fixed in this commit:

- A date outside JavaScript's range was stored and then broke the audit row and the queue view. Times are now bounded at the route, in the service and on disk, and formatting cannot throw.
- After a double corruption of the operator file, the "holds were lost" notice repeated on every restart. The bad previous copy is now moved aside and an empty file written once.
- The lease-loss notice went to the attention queue, not to the session that operates the line (an approval condition). It now goes to the session named in `monitoring.localVerify.operatorSession` through the server's message router, counts as sent only when the router reports it delivered, and falls back to the attention item otherwise.
- A release into a completely full queue dropped a saved re-test without saying so. The answer and the audit row now say so.
- Fields of a saved entry read from disk were not validated. Every field is now checked; a damaged saved entry is dropped while the hold itself is kept, with an audit row and one attention item, and a hold whose own fields are damaged is dropped with the same notice.

Second read, of the fixes: **concur**. It ran the four new unit files with `LocalVerifyService.test.ts` (268 passed) and checked that the notifier path cannot throw into the service, send with the switch off, or repeat. On its advice the failure direction for a damaged saved entry was changed from "drop the hold" to "keep the hold" before this commit, and the notice's "sent" rule was tightened to delivered only; those two last edits were tested (269 passed in the same five files; 132 in the four new files with `record.test.ts`) but not re-read by the reviewer.

Not checked by the reviewer: the integration and e2e files were read but not run; `tsc` and lint were run by the builder (both clean), not by the reviewer.

---

## Evidence pointers

- Unit: `tests/unit/localVerify/operatorQueue.test.ts`, `operatorHoldService.test.ts`, `operatorFrontService.test.ts`, `operatorQueueRoutes.test.ts` (harness: `tests/helpers/operatorQueueHarness.ts`).
- Integration (written and type-checked, not run here): `tests/integration/local-verify-queue-controls.test.ts`.
- End to end (written and type-checked, not run here): `tests/e2e/local-verify-queue-controls-lifecycle.test.ts`.
- Unchanged behaviour with the switch off: `tests/unit/localVerify/LocalVerifyService.test.ts`, `mainRedHoldService.test.ts`, `waitingListService.test.ts`, `peerVerifier.test.ts`, `localVerifyRoutes.test.ts` pass with no edit.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This change fixes no defect in a prompt, hook, config, skill or standards text. On the self-action class: the change adds bounded self-triggered work inside `LocalVerifyService` (see section 5, last bullet) and does not register a controller; that is flagged for the second pass rather than declared closed here.
