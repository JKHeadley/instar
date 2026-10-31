# Side-Effects Review — feedback executor recovers from a failed independent review

**Version / slug:** `feedback-executor-review-failed-recovery`
**Date:** `2026-10-30`
**Author:** `echo`
**Second-pass reviewer:** `required — independent subagent (see Second pass below)`

## Summary of the change

The feedback executor closes its own fix/spec PR that failed the independent review, after a 24 h
grace with no new commit, no owner approval and no operator hold, in a crash-safe order (intent →
disarm → comment → close → finalize). The first such close in an episode re-queues the item with the
scrubbed findings as a read-only data file for the next attempt; the second parks it
(`review-failed-twice`). Spec: `docs/specs/feedback-executor-review-failed-recovery.md` (converged,
3 rounds).

## Decision-point inventory

- Close a review-failed PR — invariant (deterministic conditions; reversible).
- Rework vs park — invariant (episode count bound to the item's current `work` decision id).

## 1. Over-block

It "blocks" nothing; it closes PRs. Wrongly closing: a PR that is not the executor's own (prevented:
branch + publishing-author check), one the owner approved (approval is read first and wins), one under
an operator hold/stop (checked), one whose reviewer merely could not answer (`unparseable` is re-asked
twice first; reviewer-unavailable records no verdict). A wrong close is reversible: reopen the PR.

## 2. Under-block

A PR whose reviewers stay unavailable still holds its slot (bounded by the existing daily retry;
listed as left behind). An operator approval that arrives after the close does not reopen the PR
(the item has already been re-queued).

## 3. Level-of-abstraction fit

Inside the executor's existing per-tick PR loop, next to the existing `pr-closed` handling. No new
service.

## 4. Signal vs authority compliance

The close is driven by the existing independent review's verdict (the authority that already decides
merges), not by a new brittle check. The new code only acts on that verdict after a grace.

## 4b. Judgment-point check

No new judgement; deterministic conditions over recorded state.

## 5. Interactions

Owner approval inside the grace still merges first (check order). The two-episode block rule now also
counts `review-failed-twice`. The operator's stop/release/ignore always win (conditional writes).

## 6. External surfaces

Closes GitHub PRs and posts one comment each (marker-tagged). The action-list wording changes for
close-eligible rows only. The four PRs stuck on 2026-10-30 close within ~24 h of the first tick that
sees them, then their items are retried once.

## 6b. Operator-surface quality

Removes an action item that asked the operator to approve, push or close the agent's own failed work.

## 7. Multi-machine posture

Parent's canonical owner with epoch fencing; intents reconcile on a new owner. A close already sent
to GitHub during an ownership move is reconciled, not recalled (documented).

## 8. Rollback cost

`execute.reviewFailedGraceHours: 0` (read live) stops all closes. Closed PRs can be reopened; no item
or branch is deleted.

## Second pass

(see appended reviewer response)

### Second-pass reviewer response (independent subagent, 2026-10-30 21:38 PDT)

Concern raised: `executorPorts.ts` `closePr` returned success for a PR found MERGED, so a hand-merge
landing while the executor was closing would be finalized as `review-failed-closed`, the merge never
recorded, and the item reworked for code that already shipped.

**Resolution (applied):** `closePr` now returns `'closed' | 'merged' | 'failed'`; on `merged` the
executor keeps the close intent and the next tick's reconcile records the merge on the existing merged
path. New tests: merge during close (recorded as merged, no rework attempt) and an owner approval that
arrives after the intent (intent cancelled, merged). The reviewer confirmed every other boundary in
code: ownership check, approval-first, operator hold/stop/ignore, grace 0, crash order, episode
repair, findings-file exclusion and confinement, epoch fencing, and no change to normal PRs from the
`mergeRetryAt` reorder.

Concur with the review (after the fix above).
