# Side-Effects Review — no automatic re-run after a merge conflict

## Summary of the change

`LocalVerifyService.handleErrorRetry(entry, errorStep)` returns before deciding a re-run when `errorStep === 'conflict'`. One new unit test. Nothing else changes.

## Decision-point inventory

One existing decision point: whether an errored run is re-run once automatically (`decideVerifyRetry`). The change narrows when it applies.

## 1. Over-block

A conflict that would have disappeared on an immediate second try is no longer retried. That needs main to move between the two tries in a way that removes the conflict, within about a second; the run re-reads its base at start, so it is possible but was never the purpose of the retry. Such a head is run again by an explicit request for it (a conflict is an error record, so any explicit request re-runs it; a non-explicit one does not, even on a new base), like any head after its retry is spent.

## 2. Under-block

None: the change removes a re-run; it adds no path to green.

## 3. Level-of-abstraction fit

The call site already receives the error step for exactly this kind of distinction (`preflightErrorNeedsBypass(errorStep)`). Two of the three callers pass no error step (a crashed or invalid run): those are unchanged and still retried.

## 4. Signal vs authority compliance

A deterministic rule over an enumerable value (the error step); no detector gains authority.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment point added or removed.

## 5. Interactions

- The peer path has its own handling of a conflict returned by a peer (`peerFault = errorStep !== 'conflict'`, attempts spent without degrading the peer); its tests pass unchanged. A conflict record imported from a peer reaches the same hand-off code only through the local completion path.
- The waiting list and explicit requests are unaffected: a conflicted head (an error record) is still re-run only by an explicit request.
- The status reconciler posts one failure status per conflict instead of two.

## 6. External surfaces

Half as many `record` / `run-detail` rows and status posts per conflict. Anything counting conflict verdicts from the audit log (the throughput brainstorm's "conflict verdicts per 24 h") will read about half its earlier value for the same number of real conflicts; noted for that measure.

## 6b. Operator-surface quality

No operator-facing surface.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the retry decision belongs to the lease holder's queue. `LocalVerifyService.ts` is in the verifier version, so coordinator and peer must run the same build, as with any verifier change.

## 8. Rollback cost

Revert the commit.

## Conclusion

Removes a retry that cannot succeed and halves the noise per conflict. Low risk.

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude), given the diff and the production code before the author's conclusions; read-only (no test run)

It traced the three callers (only the local run-completion path passes an error step; the journal, index, status and merge offer are all written before the retry decision; a conflict returned by a peer never reaches this function), confirmed the base is re-read before the first start so the retry was not correcting a stale base (in the live log, 158 conflict records: every immediate pair ran on the same base and none ended in anything but a conflict), and confirmed the head's later path is the same as before, reached one run sooner. Corrections it asked for and that were made: "requested against a new base" was wrong (any explicit request re-runs an error record; a non-explicit one never does); the evidence times in the release note; the test title no longer claims "once". Noted and left: the file header's general sentence that every error re-runs once. "Concur with the review".

## Evidence pointers

`.instar/logs/local-verify.jsonl`, 2026-11-14: paired conflict records one second apart for PRs 3053, 3072, 3103, 3106, 3114, 3097, 3098, 3161, 3079.
