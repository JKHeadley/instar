# Side-Effects Review — CI re-runs when a review is submitted or dismissed

**Version / slug:** `ci-rerun-on-review`
**Date:** `2026-08-22`
**Author:** `echo`
**Second-pass reviewer:** `not required — one workflow trigger and its pinned contract`

## Summary of the change

`.github/workflows/ci.yml` gains a `pull_request_review` trigger (`submitted`, `dismissed`), and `scripts/standards-coverage.mjs` pins that trigger in The Root's self-wiring contract.

**Found in production, on the first real use of the feature it completes.** The direction guard now accepts the operator's approving review as proof that a constitutional change was authorised. But CI fired on `push`, minutes before any approval could exist, so the guard ran, correctly found no approval, and failed. The operator then approved — and nothing happened. The check was already finished and red, with no event to re-run it. It only did not strand him because someone was watching and re-ran the job by hand.

An approval flow whose result depends on a human remembering to re-run the job is not a flow.

## Decision-point inventory

- CI trigger set — **modify** — adds the event that makes an approval re-evaluate the guard.
- The Root self-wiring contract in `standards-coverage.mjs` — **modify** — pins the new trigger and its two types.

No agent-runtime decision point is touched.

## 1. Over-block

`dismissed` is included deliberately and is the only arm that can newly turn a check RED. That is the point: withdrawing an approval must re-run the guard and fail it again. **A gate that re-evaluates only in the direction of passing is not a gate** — it would let an operator's change of mind be silently ignored while the stale green sat there. This is over-blocking in the correct direction and is the whole reason `dismissed` is pinned rather than merely allowed.

## 2. Under-block

`pull_request_review` fires for `submitted`/`dismissed`, so a review EDITED in place (rare) does not re-trigger. Named rather than papered over: the guard binds to the head sha, so the practical exposure is an edited review body — not a state change — which cannot flip approval either way. A `synchronize` on any new push already re-runs everything.

## 3. Level-of-abstraction fit

One trigger on the workflow that already runs the check. No new job, no polling, no bot. The alternative — a scheduled job re-running checks — would be strictly worse: slower, noisier, and it would not know what it was waiting for.

## 4. Signal vs authority compliance

Unchanged. This alters WHEN the check runs, never what it decides. The guard's authority and the ruleset's authority are untouched.

## 4b. Judgment-point check

None added. A workflow trigger is a deterministic event subscription.

## 5. Interactions

- **The direction guard's path B** is the feature this completes; without it, path B is only usable by someone manually re-running jobs.
- **The self-wiring contract** pins the trigger so it cannot be dropped silently. Dropping it would not fail any test otherwise, and the symptom would be an operator approving into a void — exactly the failure being fixed.
- **CI cost:** one extra run per review event on open PRs. Reviews are rare here (the operator is asked only for constitutional changes), so this is not a meaningful load.
- **The event SHAPE, found on rebase (2026-08-23) and the reason this branch is not a two-line change.** Adding a trigger gives the workflow a THIRD event shape, and three places assumed exactly two. The evidence step branched on `!= "pull_request"`, so a review event fell into the push branch, where the pull request is resolved by matching `github.sha` against `merge_commit_sha` — on a review event `github.sha` is the merge REF and matches nothing. The step would have resolved no pull request, written an empty context, and refused. The trigger added to make an approval count would have reliably rejected it, while every assertion about the trigger's presence stayed green: the event fires, the job runs, the check goes red. `AUDIT_CHANGE_KIND` / `_BASE_SHA` / `_HEAD_SHA` had the same two-shape assumption and would have handed the decision audit an EMPTY change kind — an unscoped run reporting clean. Both are fixed here and the first is pinned as a fourth regression route. This is the producer/consumer split in its exact shape: the trigger is the producer, and firing it is not the same fact as the checks handling it.

## 6. External surfaces

None. No route, no message, no notification.

## 6b. Operator-surface quality

This IS an operator-surface fix. Before: approve, and the red check stays red with no explanation. After: approve, and the check re-runs and goes green on its own.

## 7. Multi-machine posture

`unified` — trivially. A CI trigger; no state, no per-machine behaviour.

## 8. Rollback cost

The trigger, the event-shape handling in the evidence step and the three `AUDIT_CHANGE_*` expressions, plus their pinned counterparts in the contract. Reverting restores today's behaviour, in which an operator's approval requires a manual re-run to take effect — which is why the revert should not happen quietly. Reverting the event-shape handling ALONE is worse than reverting the whole change: the trigger would still fire and the check would then fail on every approval.

## Conclusion

Ship. It closes a gap found on the first real use of the approval path, in the direction of the operator's time rather than the agent's.

## Second-pass review

Ran, and it found something. Rebasing onto `main` after #1970 landed put this branch's trigger next to that change's push-path resolution for the first time, and the two together produced a third event shape neither had handled. See §5. The design question worth a second look — whether `dismissed` belongs — is answered under §1 and is the load-bearing half.

## Evidence pointers

- Observed live: PR #1960, approved at 22:03, standards check still red and finished; a manual re-run of the same job then passed with no other change. That difference is the bug.
- `tests/unit/standards-coverage-ratchet.test.ts` 38/38, including the negative controls that assert a workflow missing the required triggers FAILS, whose fixtures and expected error text moved with the contract.
- **Correction, on rebase.** An earlier version of this document cited moving the suite's population literals 88/89/89 → 89/89/89 as evidence. Those literals are GONE — #1970 removed them on `main`, because `protectedBase` is measured against the merge base and therefore depends on WHERE the test runs, so no literal can satisfy both the branch and the merged state. The rebase takes `main`'s removal. The claim is withdrawn rather than restated.
- The fourth regression route (`pull_request_review` folded back into the push branch) is asserted in the same suite and fails the check when applied, alongside the three routes #1970 pinned.
- `scripts/standards-coverage.mjs --check` run against this worktree: PASSED, so the pinned literal matches the workflow as it now stands rather than as it was described.

## Class-Closure Declaration (display-only mirror)

The class is "a check whose input can change without the check re-running." Closed for the review path specifically. NOT closed generally: any other check whose inputs are not repository content has the same shape, and nothing enumerates those. Named, not claimed.
