# Side-Effects Review — a rework attempt keeps the review findings across attempts that never published

**Version / slug:** `executor-rework-keeps-findings`
**Date:** `2026-11-16`
**Author:** `echo`
**Second-pass reviewer:** `not required (no gate, block or session-lifecycle decision changes)`

## Summary of the change

Tier 1 (a revert undoes it). When an executor fix PR fails the independent review and is closed after its grace period, the next attempt for that item is meant to start from the review's findings (docs/specs/feedback-executor-review-failed-recovery.md §2). `writePreviousReview` only looked at the attempt immediately before. If that rework attempt stopped before publishing anything (reroute capacity, a lost lease, a restart), the attempt after it found a `reroute-capacity` or `stale-epoch` row, wrote no findings file, and repeated the same mistakes blind.

Live evidence: item `feedback-17ab2960` (PR 3199, closed 2026-11-16 19:08Z after failing review) started its rework attempt a2 at 19:09Z; a2 stopped at 19:18Z on `reroute-capacity`, so a3 would have run without the findings. Item `feedback-e588a2a1` lost the findings of PR 2442 the same way across attempts a4–a11 (profile-unenforceable, stale-epoch).

Fix: "previous attempt" now means the latest earlier attempt that published a PR (`prNumber !== null`). Attempts that never published produced no code to review and are skipped. The conditions for writing the file are unchanged: that attempt must be `stopped / review-failed-closed` with stored findings.

Effort: one build round, one commit attempt. 1 source file (+6/-1), 1 test file (+22).

## Decision-point inventory

None changed. This decides which stored, scrubbed findings text is handed to the confined session as a read-only data file. The review gate, the close, the episode count and the merge gate are untouched.

## 1. Over-block

None. Nothing is blocked.

## 2. Under-block

An attempt that published a PR which was closed for some other reason (`pr-closed`) still ends the chain: the later attempt gets no findings, as before. That is correct, since the newer PR's code superseded the reviewed code.

## 3. Level-of-abstraction fit

Right layer: the one function that picks the findings to pass on.

## 4. Signal vs authority compliance

No authority. The findings file is data for the session, written by trusted code from the executor's own stored review output (never text read back from GitHub), exactly as before.

## 5. Interactions

The "rework once, then park" episode logic uses `episodeDecisionId`, not attempt adjacency, so a rework that needed two starts still counts as one rework. Existing tests for park, crash safety and grace all pass unchanged.

## 6. External surfaces

None. The confined session receives the same file it was always meant to receive.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the executor runs on the lease owner only, and the attempt rows it reads live in its store.

## 8. Rollback cost

Revert. Reworks after a stopped attempt would again run without findings.

## Conclusion

Ship.
