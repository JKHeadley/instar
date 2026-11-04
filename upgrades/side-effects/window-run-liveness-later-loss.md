# Side-Effects Review — Later liveness loss after recovered autonomous run

**Version / slug:** `window-run-liveness-later-loss`  
**Date:** 2026-11-02  
**Author:** Echo  
**Second-pass reviewer:** `/root/outage_fallback_review` — concurred after equality-boundary correction

## Summary of the change

Tier 1 narrow, reversible incident fix. One authority branch in `src/core/WindowRunLivenessAuthority.ts` now bounds a later at-risk episode from its own transition after a previously completed recovery; it preserves the original deadline while the first episode is still unresolved and never actuates recovery twice. Unit, authenticated HTTP, and production-boot lifecycle tests cover the boundary. This is a 4-code-file change at draft time, with one review round and no commit attempt yet.

## Decision-point inventory

- `WindowRunLivenessAuthority.evaluateAndMaybeRecover()` — modified — chooses the deadline for an at-risk run with an existing recovery attempt.
- Recovery actuation, predicate sampling, active promotion, and terminal projection — passed through — unchanged.

## 1. Over-block

A later loss still fails if any predicate remains red for 15 minutes from its new at-risk transition. A transient later loss does not fail immediately only because the old deadline expired. The original unresolved loss still fails on its original ceiling. No additional legitimate input is rejected.

## 2. Under-block

Repeated short outages could re-enter active between episodes without another refresh. This is already possible whenever all five predicates become green; the change allows observation to distinguish distinct episodes, while the one recovery attempt remains spent. There is no new path to active with a red predicate. A later loss with no usable `atRiskSince` or a non-finite deadline fails closed.

## 3. Level-of-abstraction fit

The authority owns its recovery attempt, at-risk transition, and terminal deadline, so it is the right layer. The change uses those persisted fields and adds no competing monitor.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md).

- [x] No — this change maintains an existing server-owned authority's deterministic timing invariant, with all five independent predicate inputs still required for active.

The exact ordering of one completed attempt and a later transition is recorded by the authority. The new arithmetic cannot fabricate a green predicate or recovery receipt.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The 15-minute ceiling is the configured existing invariant; this change selects the correct episode start for that invariant.

## 5. Interactions

- **Shadowing:** active promotion still requires all predicates green before the deadline branch.
- **Double-fire:** the persisted `recoveryAttempt` continues to suppress a second recovery call.
- **Races:** the authority's existing mutation lock serializes tick and state transitions; `atRiskSince` is written before this branch.
- **Feedback loops:** a later recovered episode returns to active, clearing `atRiskSince`; a new red sample starts a new bounded interval.

## 6. External surfaces

Users may no longer receive a false terminal failure for a later brief outage; after 15 minutes of continuing failure, the same terminal notice is sent. The durable record shape and HTTP schema are unchanged. No new operator action, URL, credential, or message source is introduced.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design:** the liveness authority is bound to the run's current executor and uses that executor's transcript heartbeat plus its server-owned window state. The existing ownership/binding path determines which machine samples and projects the result. This change emits the existing failure notice at the later episode's real deadline, holds the same durable state, and generates no URLs. Topic transfer requires the existing rebind proof; this change does not add a new transfer path.

## 8. Rollback cost

Revert the branch and ship a patch. No schema migration or state cleanup is needed. During rollback propagation, a recovered run could again fail immediately on a later brief loss.

## Conclusion

The incident sequence is reproducible from the production authority record: first recovery returned active, then a later red sample was compared with the old ceiling. The patch preserves one recovery actuation and bounds each distinct at-risk interval. Unit tests and TypeScript pass; authenticated HTTP and production-boot tests are queued behind the host suite lane. Do not ship until those tests and the full required gates pass.

## Second-pass review (if required)

**Reviewer:** `/root/outage_fallback_review`  
**Independent read of the artifact:** concur. The reviewer found the same-millisecond boundary in the first pass; I changed `>` to `>=` and added a test where recovery takes 14 minutes and the later loss is sampled in the completion millisecond. The second pass found no further blocker, subject to pending HTTP/E2E and full gates.

## Evidence pointers

- `.instar/autonomous/130742-evidence.md` — two live terminal incidents and the third run's admission receipt.
- `tests/unit/window-run-liveness-authority.test.ts` — focused unit receipt, 56 tests passed.
- `tests/integration/window-run-liveness-routes.test.ts` and `tests/e2e/window-run-liveness-production-wiring.test.ts` — added, queued.

## Class-Closure Declaration (display-only mirror)

No new self-action emit is introduced: the existing recovery attempt remains spent and the changed branch only chooses the at-risk deadline. The targeted unit and production-boot cases are the regression ratchet for the expired-prior-deadline defect. The `unbounded-self-action` class is not newly implicated by this diff; no agent-authored artifact is being corrected.
