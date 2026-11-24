# Side-effects review — required Enter persistence

Date: 2026-11-17. Author: Echo. Tier 2 under approved/review-converged docs/specs/desktop-locked-screen.md P15. Dependency e39495165 (PR3358). Design independently concurred by /root/lock_call_measurement_design, relayed by parent. Parent final source review and independent /root/lock_call_measurement_design implementation review concurred. Parent authorized normal commit after fast guards; no push.

## Summary and proportion

One native helper safety correction, exact production Swift execution tests, a viewer refusal regression, and three documentation artifacts. Native source +46/-7 lines. One design review and one independent implementation review; one expected red test run; one initial test-string escaping error corrected without runtime changes. Normal commit follows this frozen artifact; commit result is recorded in the handoff. SMALL build scope with Tier 2 security review.

## Decision-point inventory

Modified: the existing Enter-intent transaction now requires exact request/key/current producer PID/nonempty kernel start, owed state and absent or strictly Boolean-false relockNow, followed by successful outer persistence. Only that success permits the existing Enter pair. Passed through: final abort/secure-target checks, safe field abandonment and generic state-unavailable refusal. No new telemetry authority or proof predicate.

## 1. Over-block

A valid password can be refused if process identity cannot be read or the store cannot be saved. That is intentional fail-closed behavior: submission without its relock record is unsafe. A normal same-duty retry with the same serial producer remains accepted. Native input-stream executes one command at a time, so another concurrent attempt from that producer cannot replace this reservation before its Enter boundary.

## 2. Under-block

Check and event posting are not atomic. The lock is released before dispatch; cancellation can arrive in that gap. Existing guard kill-and-confirm-before-terminal behavior remains responsible for preventing events after closure. Successful intent persistence is not proof of actual event consumption or successful unlock. Missing Enter metadata proves nothing about past submission. No attempt ledger or cancellation-proof acceptance is added. The store uses atomic replacement without fsync: same-boot process-crash persistence only, not a power-loss durability claim. Same-user malicious modification remains outside this existing honest-helper boundary.

## 3. Level-of-abstraction fit

The native helper owns both the persistent duty and Enter dispatch, so it can enforce this prerequisite without moving passwords or adding a network authority. Pure state validation plus a tiny commit/dispatch function isolate the exact production boundary for real Swift execution. LockedStore.withLock remains the one store writer; no parallel store implementation or held-lock key posting.

## 4. Signal versus authority

Reference: docs/signal-vs-authority.md. This is hard-invariant validation and a safety guard on an irreversible input action, covered by the principle's explicit exceptions. Exact ownership and completed persistence are enumerated mechanical facts, not heuristics about intent. No detector receives independent authority over conversational behavior.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The named invariant is that Enter requires successful persistence for its still-owed exact producer/request duty.

## 5. Interactions

Validation rejects before changing metadata. On a failed outer write the transaction does not report success. Refusal preserves existing duty, counters and previous Enter metadata; the existing abandonField path may clear dirty state after clearing the field, as before. No reservation reset, attempt refund, duty closure or new retry occurs. Existing prior Enter metadata remains intact on refusal; this fix does not reinterpret it as a current-attempt measurement. Common helper compile and hash recipes already include this file; no shared source is added.

## 6. External surfaces

Uses the existing state-unavailable refusal string and secret-result protocol. DirectDesktopAccess reports refusal and never sent:true for this result, and does not count it as the cause of an unlock. No HTTP route, capability or UI is added; therefore no new agent-awareness text or installed-text migration is needed. Existing discovery and handling remain sufficient. No plaintext or extra identifier is persisted. Native source hash changes: retained-helper rollout and TCC/input-permission validation belong to the rollout owner. No live Mac action occurred.

## 6b. Operator-surface quality

No new operator surface — not applicable. Existing native/browser viewer refusal handling is used; no raw state or new action is displayed.

## 7. Multi-machine posture

Machine-local BY DESIGN: a Mac's login session, native producer and relock record cannot authorize input on another Mac. No new notice, URL, transferable state or status route. Existing per-Mac state is not migrated or replicated.

## 8. Rollback cost

Revert the helper source and tests and publish a patch; no schema migration or state repair. Rollback reintroduces the ignored-write defect, so prefer correction if an unexpected refusal appears. Helper hash/permission rollout cost applies to rollback too.

## Test scope and evidence

Unit tests execute the exact marked production Swift enum with Foundation and inert commit/post callbacks. They cover inner refusal, absent store result, failed persistence after a valid body, and preserved duty/counters/metadata across same-duty retry and refusal. Source assertions supplement execution to verify the actual secretType wiring. The real DirectDesktopAccess path exercises refusal/control output and unlock-cause behavior with an inert host. There is no password HTTP route to extend. Existing integration/E2E initialization and route contracts are unchanged; those suites and the real hardware P15 gate remain with Local Verify/rollout owners. No new integration/E2E test is claimed to execute native safety behavior through a mocked HTTP route.

Fast guards: 802/802 across 30 files in six batches of five, all exit0. Logs /tmp/topic138345-enter-guards-1.log through -6.log, summary /tmp/topic138345-enter-guards-summary.json.

Final logs: /tmp/topic138345-enter-final-five.log (49/49), /tmp/topic138345-enter-final-typecheck.log (exit0). Earlier logs: /tmp/topic138345-enter-red.log (expected missing boundary); /tmp/topic138345-enter-targeted.log (25 passed, one fixture string-output failure); /tmp/topic138345-enter-green.log (corrected 2/2); /tmp/topic138345-enter-response.log (final response batch); /tmp/topic138345-enter-typecheck.log (full common helper typecheck, exit0).

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. Explicit negative self-action declaration: `defectClass: unbounded-self-action`, `closure: n/a`. Reason: this is a one-shot user-originated secretType Enter boundary, not a self-triggered loop. It adds no producer, restart, kill, retry, notification or re-drive edge. Existing guard convergence bounds remain unchanged; field abandonment is the existing immediate refusal action.

Causal autopsy: latent. The existing pre-Enter transaction ignored missing ownership and failed persistence, allowing dispatch without successfully saved relock state. This change makes that existing safety prerequisite authoritative; no prior-PR causal attribution is claimed.

## Conclusion and second-pass review

Final targeted 49/49 tests passed across five files, including actual Swift execution with complete JSONSerialization roundtrips. Full common-helper typecheck passed after the strict Boolean correction. Independent implementation reviewer /root/lock_call_measurement_design: “CONCURS, no remaining blocker.” Reviewer confirmed exact Swift inner/outer gate, current producer identity, strict CFBoolean including JSON representations, transaction return before post, retained final checks and abandonment, and substantive exact-block/DirectDesktopAccess tests. Parent final source review also concurs. No hardware proof or publication claim.
