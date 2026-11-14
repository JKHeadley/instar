# Side-effects: a held read re-checks the whole history every five seconds

## Summary

During a removal, each source read ran a full check that re-walks and re-verifies the whole history, so the cost grew with the square of the history. A clean run at 186 records was still going after 30 minutes. The read now runs that full check at most every five seconds. Full checks were added right after the last read and just before the role finishes.

Decision point: yes, this changes how often an existing check runs. It adds no new check and no new authority.

## 1. Over-block
No issue identified. Fewer repeat checks mean no new refusal.

## 2. Under-block
A change to the history can go unnoticed by a read for up to five seconds. This cannot reach the witness. Each read still hashes its file against the frozen inventory and still checks generation, erasure fence, dropped origins, intake, membership and hold. After the last read, `finalize()` compares disk to the frozen inventory and the full check compares disk to the plan, with nothing awaited between them. Local envelope and origin files written before the next full check are replaced on retry.

## 3. Level-of-abstraction fit
Only the held reader's non-writer path changes. Direct `preflight.assertCurrent()` calls and the writer path still run the full check every time.

## 4. Signal vs authority compliance
Follows `docs/signal-vs-authority.md`: authority stays with the full check. Only its timing on evidence-gathering reads changes.

## 5. Interactions
The session's read path uses the writer branch and is unchanged. The monotonic clock means a wall-clock jump cannot lengthen the window.

## 6. External surfaces
Removal takes less time. No wire or page change.

## 7. Multi-machine posture
Machine-local: this runs on the surviving machine doing the removal.

## 8. Rollback cost
Revert the commit. No state or format change.

## Class-Closure Declaration
Defect class: unbounded-self-action. Closure: n/a. No new trigger or loop.

## Evidence
Profile of the running removal: 80% of time in the per-read full check. Integration: `graph-source-postcas-held-reader` gains a case where a change during the read window is refused by the full check, and the three other held-source suites stay green. Timed result on the real pair is recorded in the handoff and release note.

## Second-pass review
Independent reviewer, reading the code without my conclusion, traced each durable step in `GraphOwnerMemberLossExecution.run` to its last full check. Concur. It suggested a monotonic clock and a more accurate comment, both applied. It noted the new test exercises the check rather than all of `run`, and that intake reader and custody persistence internals were not verified.
