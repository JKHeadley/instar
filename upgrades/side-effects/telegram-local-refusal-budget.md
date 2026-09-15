# Side-Effects Review — Local capacity refusals preserve transport budget

**Version / slug:** `telegram-local-refusal-budget`
**Date:** 2026-09-14
**Author:** Echo
**Second-pass reviewer:** review_local_refusal (independent Codex agent)

## Summary of the change

A prepared Telegram operation currently spends one of nine transport attempts when its credential-capacity reservation fails locally, before any network invocation. The egress closure now supplies private, single-use evidence bound to the exact sealed request. Only that evidence permits the outcome transaction to return the claim's transport attempt. The dispatched intent and failed-attempt audit remain durable. This repairs local refusal accounting; it does not establish delivery for a request that reached the network.

## 1. Over-block

No new message-content decision or permission check. A custom transport throwing a capacity-shaped exception without the private proof remains uncertain. That is intentional: exception names alone cannot establish non-invocation.

## 2. Under-block

The proof is minted only around capacity reserve/consume, before the network callback. Concurrent or repeated invocation cannot mint proof after another invocation starts sending. Wrong-request use does not consume the real proof. The transaction rejects stale leases, repeated outcomes, accepted receipts with a refund, and refund requests before dispatch intent. A failed persistence write leaves the original dispatched claim charged and subject to uncertain-outcome recovery.

## 3. Level-of-abstraction fit

The wire closure owns whether it invoked transport; the canonical outbox owns durable attempt accounting. The existing recovery scheduler still owns review cadence. A response-shaped error or an LLM explanation supplies neither proof nor permission.

## 4. Signal vs authority compliance

Per docs/signal-vs-authority.md, this is constrained transport accounting, not semantic blocking. The exact in-process non-invocation fact feeds the existing claim-fenced transaction. Current content, destination, lease, emergency-stop, and origin authorities remain in the send path.

## 5. Interactions

The attempt refund and outcome transition are one transaction. Capacity debits are never refunded or renewed. Local refusals retain the first transport backoff interval; automatic recovery also retains its durable 15-minute review interval. The original six-hour deadline bounds persistence and retries. No old failed/unknown operation or original budget is manually reset. Mixed-version workers conservatively retaining charges must not be claimed as upgraded until activated.

## 6. External surfaces

Audit attempts remain visible while the child transport counter excludes proven local refusals. The new metric is attempt:local-refusal-not-charged. HTTP holds continue to tell callers not to resend. Agent awareness explains that custody is not delivery and migrates the exact old shipped sentence without touching custom text.

## 6b. Operator-surface check

No new operator surface. Existing audit and hold responses are retained.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local BY DESIGN: capacity ownership and executable outbox custody already belong to the credential owner; origin evidence retains the source machine. The private proof never crosses the network or grants remote execution authority. The resulting durable audit is exposed through existing origin audit/pool readers. No new notice or URL is produced and no topic-transfer storage path is introduced.

## 8. Rollback cost

A normal patch release can revert runtime accounting. No schema change is needed. Retained audit rows and restored counters remain readable by the older worker; it resumes charging subsequent local failures. Rollback must not reconstruct or replay previously uncertain operations.

## Conclusion

The candidate closes local capacity refusal charging without weakening uncertain-delivery replay rules. Broader network evidence, unresolved-delivery escalation, snapshot freshness, never-dispatched expiry investigation, and terminal recovery-row cleanup remain distinct repairs in the existing tracked delivery assignment. This artifact does not certify the whole assignment or a fleet deployment.

## Second-pass review

review_local_refusal independently concurred with the runtime change, including request-bound proof, atomic refund, stale-fence behavior, immutable deadlines, and unchanged credential debits. It recommended wrong-request/single-use proof, expired-lease, persistence-loss, and deadline tests; those have been added and are in validation. Final independent review concurred with the added boundary tests and corrected paragraph-scoped migration; no code blocker found.

## Evidence pointers

First stable focused run: /tmp/echo-local-refusal-focused-2.log — 55 passing tests across unit, outbox, HTTP and production restart. Expanded run: /tmp/echo-local-refusal-focused-3.log — 248 passed, one incorrect public-wrapper error expectation corrected. /tmp/echo-local-refusal-final-focused.log — local/deadline/migration cases passed, one HTTP cleanup timeout. /tmp/echo-local-refusal-cleanup-recheck.log repeated cleanup timeouts; /tmp/echo-local-refusal-cleanup-trace.log passed all four HTTP cases and narrowed delay to Boot before runtime close without proving a cause. Temporary diagnostics removed. Build passed. Full suite/CI/release pending.

The frozen aggregate completed normally with 51,919 passing tests and one failure,
solely the expired-deadline preflight gate. All frozen inputs remained unchanged.
The candidate was then rebased without conflicts onto v1.3.1238 at
15cd5876d6d285a39fc105aeb57e5fde705ad540, which contains the upstream deadline
updates. No local deadline exception was applied. Build, countdown lint and all
60 rebased unit/store/HTTP/restart/preflight checks passed. Independent review
concurred again after checking the upstream relogin changes for interactions.
Complete release validation on this base remains pending.

## Class-Closure Declaration (display-only mirror)

Recovery continues through the existing paced recovery implementation; no new controller is introduced. The control edge is local refusal → original queued child → paced recovery. Its steady-state bounds are the existing 15-minute durable review reservation and original six-hour deadline; repeated invocation and process restarts cannot reset either. The executable twelve-refusal/one-attempt, original-deadline and restart tests exercise the accounting boundary in tests/unit/telegram-origin-store.test.ts and tests/e2e/telegram-origin-late-capacity-lifecycle.test.ts. The unbounded-self-action declaration cites those concrete bounds rather than claiming a new controller registration.

## Release-run cleanup correction

The frozen d9c2d0cc2 aggregate ended normally with51,936passing tests and one
failure: the existing receipt-restart case exceeded its10-second afterEach
cleanup limit after the delivery assertions passed. All5670frozen inputs were
unchanged. The new local-refusal restart case passed. Dedicated integration
and E2E stages did not run because the aggregate exit was nonzero.

Independent tracing of this same lateCapacityHttpHarness/production Boot close
path measured5763ms in notice-policy watcher close,1470ms in config-reader
watcher close,0ms joining canaries, and3ms in runtime close. The reviewed
correction gives this lifecycle fixture an explicit30-second cleanup bound,
continues awaiting actual closure, and restores mocks in finally. No runtime
deadline, delivery assertion, or retry policy changes. The production canary
shutdown defect remains separately tracked in topic69507.
<!-- tracked: topic-69507 -->

After the run ended, the correction passed both lifecycle cases in
/tmp/echo-local-refusal-cleanup-focused.log. Reviewer review_local_refusal
concurred with applying the measured bound to this shared shutdown path.
Fresh full validation and CI remain required.
