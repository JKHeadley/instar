# Side-effects: a held read re-checks the stable removal state every five seconds

## Summary

The five-second rule covered the held preflight but not the two other stable checks in the held reader's scope. Those are the removal hold (`authority.assertMemberLossHeld`) and the removal progress with its signed consent (`progress.assertCurrentNativeContext`). With 200 records of history, a removal still ran 90 minutes and then lost its lease. A live profile of the finishing removal showed 63% of time in the progress check and 18% in the hold check, re-verified on every record read. On the read path, both now run at most every five seconds. They also run in full at the start of the reader, after intake is verified, on every write and every held-writer call, and in both checks inside `finalize()`.

Decision point: yes, this changes how often existing checks run. It adds no new check and no new authority.

## 1. Over-block
No issue identified. Fewer repeat checks mean no new refusal.

## 2. Under-block
A read can miss a change to the hold or the progress record for up to five seconds. Reads only gather evidence. Every write through the held mutation path, with or without a snapshot writer, still runs the full check before writing. `finalize()` runs the full check before and after its disk comparison. The durable steps sit behind full checks of their own. Stage receipts are returned only after `assertFinalized()`. The plan origin re-checks the progress and hold around its publish. Read-session uploads and binding promotions run the hold and progress checks on every call. The role finish runs `#final` first. A change in the window is therefore refused before anything takes effect. Every read still checks component identity, local custody, the removed-recorder rule, the continuation binding, the lease bridge and live admission. It also still checks intake, the physical scope, generation, the negative hash and dropped origins.

## 3. Level-of-abstraction fit
Only the non-writer read path of `verifyHeldSourceReader`'s `scope` changes. The planned-intent hold (`assertHeldIntent`) is unchanged. The member-loss hold check is throttled whether or not the hold has a native continuation; the floor check (`assertObservedContext`) still runs on every read.

## 4. Signal vs authority compliance
Follows `docs/signal-vs-authority.md`: authority stays with the full check. Only its timing on evidence-gathering reads changes.

## 5. Interactions
It shares the monotonic timer from the earlier five-second change. The timer is set only after a full read-path scope passes, so a failed check never extends the window.

## 6. External surfaces
Removal takes less time. No wire or page change.

## 7. Multi-machine posture
Machine-local: this runs on the surviving machine doing the removal.

## 8. Rollback cost
Revert the commit. No state or format change.

## Class-Closure Declaration
Defect class: unbounded-self-action. Closure: n/a. No new trigger or loop.

## Evidence
- CDP profile of the live finishing removal at 200 records: `assertCurrentNativeContext` took 63% of time inclusive, and `assertMemberLossHeld` took 17.6%.
- Integration: `graph-source-postcas-held-reader` gains a case. A change to the removal progress record mid-read lets the throttled read succeed, and `finalize()` then refuses with the progress error. Without the throttle the read itself would reject, so the case tells the two paths apart.
- Ten held-source and removal suites pass: 109 tests.
- The timed result on the real pair is recorded in the handoff note.

## Second-pass review
An independent reviewer read the code without my conclusion. It traced held writes, `finalize`, stage receipts, plan origin, witness bootstrap upload, role finish and sender-stage promotions to a full check. Concur. It found `lastHeldPreflight` is set only after every check passes. It raised two notes, both applied. First, section 3 wrongly said the non-native path was unchanged, and section 2 named the wrong backstop. Second, the test swallowed the second read's error and could not tell the throttled path from an unthrottled one; it now asserts that the read succeeds and that `finalize()` names the progress error.
