# Side-Effects Review — Local Verify suite-slot priority

**Version / slug:** `local-verify-suite-priority`
**Date:** 2026-10-27
**Author:** Echo
**Second-pass reviewer:** dedicated independent Codex review

## Summary of the change

Local Verify publishes a short host-local claim while it has runnable merge-gate work. The host test semaphore gives its next full-suite slot to a Local Verify child; ordinary full suites wait, and targeted runs retain their separate lane. The change touches the semaphore, Local Verify service and production seams, the status route, agent guidance and migration, registry metadata, and tests. It is driven by the 2026-10-26 starvation incident and the approved host test-runner bound and Local Verify merge-authority specs.

## Decision-point inventory

- `LocalVerifyService.pump` — modified: determines when work is runnable and publishes or clears the claim before checking current holders.
- `HostTestRunnerSemaphore.acquire` — modified: an ordinary suite yields to a live claim; the Local Verify child may take the available suite slot.
- Targeted-lane admission, the suite cap, Local Verify result authority, and merge eligibility — passed through unchanged.

## 1. Over-block

An ordinary full suite can wait with zero holders while a queued verifier starts or a prepared child seeks the suite slot. That is intentional priority, observable as `mergeGatePriority.active`. The coordinator clears its claim during child install/build/lint, so that long preparation does not idle-block the slot. A live queue with many successive verifies can still make an ordinary suite exhaust its existing 45-minute acquisition budget; this is the requested merge-first policy, and the timeout is reported as capacity contention. A stalled coordinator or child loses priority after the two-minute lease. The 64-claim ceiling fails open with an audit if reached.

## 2. Under-block

Suites launched from older, unre-based worktrees do not read the priority claim. They can still take the slot until those worktrees update to a revision containing this limiter change. The priority rule applies to current-code suite runners on the same host. A failed claim write or unreadable claim directory fails open and is audited by the service. Suites already holding the slot complete normally.

## 3. Level-of-abstraction fit

The queue's runnable-work decision belongs to Local Verify, which already knows pause, hold, and main-red state. Host-wide admission belongs to the existing semaphore, the single chokepoint used by test suites. The claim carries only the coordinator's short-lived state between these two authorities; it does not create a second scheduler or change merge eligibility.

## 4. Signal vs authority compliance

Required reference: [Signal vs Authority](../../docs/signal-vs-authority.md).

This is a deterministic resource-ordering invariant inside the existing host semaphore, not a judgment about message meaning or user intent. The coordinator's decision that it has runnable work comes from its existing queue policy. The semaphore reads a valid live claim and applies the explicit scheduling rule. The rule is bounded, logged, and fails open on claim uncertainty. It adds no brittle detector with independent blocking power over a conversational action.

## 4b. Judgment-point check

No new static heuristic at a competing-signals judgment point. A suite either belongs to the targeted lane, is a Local Verify child, or is an ordinary full suite; a claim is either valid and live or ignored. The order is an explicit resource policy from the incident, not a guess about relative user urgency.

## 5. Interactions

- **Shadowing:** existing holder capacity still wins; priority never increases the suite cap. The ordinary suite checks the claim only at the available-slot decision.
- **Double-fire:** multiple Local Verify coordinators can each hold a claim, but all their children still compete under cap one. One agent's clear cannot erase another agent's file.
- **Races:** atomic replacement prevents torn reads; a dead PID, expired lease, corrupt row, or foreign hostname is ignored. A retiring server checks PID and hostname before clearing its claim. A narrow same-process replacement race remains if two service instances share the same agent key and PID; normal server construction has one service instance.
- **Feedback loops:** a queued verifier claims before observing an occupied slot and renews every 30 seconds; it clears at child spawn. The child claims immediately before seeking the lane slot, renews while waiting, and clears on acquisition or error. Hold, pause, empty queue, or shutdown also clear the coordinator claim. The lease expires after two minutes without renewal.

## 6. External surfaces

Other agents on this host can see their full suite wait until a queued merge verify takes the next slot. `GET /test-runner-limiter` reports `mergeGatePriority.active`, and the wait line names the cause even with zero holders. The per-agent claim files live under `~/.instar/host-test-runner-priority/`; the registry bounds them to 64 keys. There is no external API call, user-facing operator action, credential, or URL. A full-suite wait can reach its existing 45-minute acquisition budget and produce the existing capacity-timeout error; the priority rule does not extend that budget.

## 7. Multi-machine posture

Machine-local by design: each host has its own physical suite slot, semaphore, and Local Verify runner. Claims are not replicated because a claim on the Studio must not block a suite on the Mini. The route reports the current host's state. The change emits no user-facing notice, holds no topic-bound durable work, and generates no cross-machine URL.

## 8. Rollback cost

Revert the code and ship a patch, or set the existing limiter kill switch `INSTAR_HOST_TEST_SEMAPHORE=off` for emergency host admission. Claim files expire after two minutes; stale files have no authority and may be left for bounded pruning. Existing agent guidance is additive and can be removed by a later migration if the policy is reverted. No test result or merge record needs repair.

## Conclusion

The scheduling change is narrow and reversible. Independent review found that claiming through child install/build would idle-block ordinary suites; the claim is now split between queue wait and lane-slot acquire, leaving the preparation interval open. It closes the observed current-code starvation path while preserving the host cap and fail-open behavior. Mixed-version worktrees and long ordinary-suite waits under sustained merge backlog are the rollout limits to monitor. Build, lint, and focused unit tests pass; the full three-tier suite waits for the occupied host slot.

## Second-pass review

**Reviewer:** dedicated independent Codex review
**Independent read of the artifact:** Concur after one concern and revision. The first design kept priority active through fetch/install/build/lint; the revised coordinator clears at child spawn, and the child claims only while seeking the suite slot. The reviewer found no remaining blocker in the code, tests, or stated rollout limits.

## Evidence pointers

- Incident: `.instar/state/local-verify/runs/ff28d073242750b541347c3acb49c5e8.log` records `overlap` with no run started; `GET /test-runner-limiter` showed a long-lived ad-hoc suite holder.
- Unit tests: `tests/unit/host-test-runner-semaphore.test.ts`, `tests/unit/localVerify/LocalVerifyService.test.ts`, `tests/unit/test-runner-budget-awareness.test.ts`.
- Integration and E2E: `tests/integration/test-runner-limiter-route.test.ts`, `tests/e2e/test-runner-limiter-lifecycle.test.ts`, `tests/e2e/local-verify-lifecycle.test.ts`.

## Class-Closure Declaration

This changes an existing self-triggered verifier scheduling path, rather than adding a new action loop. The control-loop edge is `pump` publishing a claim, then checking for a runnable start. The steady-state bound is one suite holder per host, at most 64 live claim keys, and a two-minute claim lease. The settling brake is a clear at child spawn and lane-slot acquisition, plus hold, pause, empty queue, shutdown, or process death. Unit tests exercise both claim and release sides. No agent-authored prompt, hook, config, skill, or standards-text defect is being repaired; the class-closure registry declaration is not applicable.

## Merge reconciliation review

**Reviewer:** Independent Codex read-only reviewer (/root/priority_review).

The branch was merged with `origin/main` after the verify queue reported a conflict. The resolution combines the new suite-priority seam with main's starvation callback and preserves both E2E lifecycle tests. Independent Codex review of the staged merge found no remaining conflict-resolution error. The full Local Verify run on the merged head remains the merge authority.
