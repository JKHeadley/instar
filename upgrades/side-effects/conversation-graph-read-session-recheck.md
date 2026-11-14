# Side-effects: the removal's read session re-checks stable state every five seconds

## Summary

After fa8180ecd9 the first read phase of a removal ran fast. Its longest single stretch at 200 records was 1.8 seconds. The removal then spent its time in the next phase, the read session that streams each record to the witness. Profiles of that phase showed 70–80% of the time going to the same stable checks, run several times per row:

- The read session's `current()` re-ran the hold check and the removal-progress check, with its signed consent, three times per row.
- Each `current()` also called the held reader's finished-writer read. That held reader always ran in full for a held writer.
- That in turn called the snapshot writer's `readCurrent`. It re-walked the whole intake store and re-checked progress every time, which made the cost grow with the square of the history.

Three changes, all to reads that happen after the writer has finished:

1. The read session's `current()` runs the hold and progress checks at most every five seconds. Its `final()` forces them twice.
2. In the held reader's `scope`, a finished writer's read counts as a read for the five-second window. A writer that has not finished still checks in full every time.
3. The snapshot writer's `readCurrent` (exposed as `assertReadCurrent`) re-walks intake and re-checks progress at most every five seconds. Its `live()` path, used by writes and commit, now always runs the full check directly.

Decision point: yes, this changes how often existing checks run. It adds no new check and no new authority.

## 1. Over-block
No issue identified. Fewer repeat checks mean no new refusal.

## 2. Under-block
A row read can miss a change to the hold, the removal progress, or the intake store for up to five seconds. These reads stream rows to the witness's staging area, including historical-rewrap rows, on the throttled checks. A staged upload takes effect only when it finishes. Before it finishes, or anything else takes effect:

- The read session's `finalize()` and `assertFinalized()` run `final()`. That re-checks the hold and progress, runs the held reader's full `#final` including `heldIntake.finalize()`, then the preflight and the transfer inventory.
- `GraphWitnessBootstrapStream` calls `assertFinalized()` before it commits.
- Every write and every commit through the snapshot writer still runs the full check.

Every row read still checks component scope, local custody, the erasure fence, generation, the negative hash and dropped origins.

## 3. Level-of-abstraction fit
Only post-write read paths change. The sender stage used when there are no records (`prepareMemberLossHeldSenderStage`) is unchanged.

## 4. Signal vs authority compliance
Follows `docs/signal-vs-authority.md`: authority stays with the full checks. Only their timing on evidence-gathering reads changes.

## 5. Interactions
Each of the three timers is set only after its full check has passed, so a failed check never extends a window. The read session timer and the held reader timer are separate. A forced full check in one does not reset the other. In the held reader, a finished-writer read runs the snapshot's read check rather than the preflight check, but it refreshes the same timer. A plain read within the next five seconds can therefore skip the preflight check. The full checks before every effect still include it.

## 6. External surfaces
Removal takes less time. No wire or page change.

## 7. Multi-machine posture
Machine-local: this runs on the surviving machine doing the removal.

## 8. Rollback cost
Revert the commit. No state or format change.

## Class-Closure Declaration
Defect class: unbounded-self-action. Closure: n/a. No new trigger or loop.

## Evidence
- CDP profiles of the live removal at 200 records, after fa8180ecd9: 70–80% of time in the held scope under the read session. About 90 of 120 seconds went to the snapshot writer's `readCurrent`. Within that, the progress check took about 57 seconds and the intake check 30.
- Ten held-source and removal suites pass on the final code: 109 tests.
- The timed result on the real pair is recorded in the handoff note.

## Second-pass review
An independent reviewer read the code without my conclusion. It confirmed that the read session's `final()` reaches full hold, progress and held-intake checks. The snapshot's own intake is covered through `preflight.assertCurrent()`, which runs after the snapshot writer has committed. Stage finish, `stage()`, plan origin, the server `run()` steps and snapshot-writer writes each run a full check before taking effect. No timer is set after a failed check. Concur. It raised two notes, both applied. Rows reach the witness's staging area on throttled checks, and the code comment and section 2 now say so. The finished-writer path shares the preflight timer, now noted in section 5.
