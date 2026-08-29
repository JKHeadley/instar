# Side-Effects Review — window-lifecycle self-action convergence model

**Slug:** w29-ledger-selfaction-model · **Date:** 2026-08-29 · **Author:** Codey (W29 Lane C2), commit ritual by Echo/Observer 1 · **Tier:** 1 (test infrastructure, 40 LOC)

## Summary
Registers the WindowLifecycleObligationLedger's owned 60s notify tick in `src/testing/selfActionRegistry.ts` (a faithful convergence model of its save-before-send dedupe brake) plus the `@self-action-controller` annotation at the real emit site in `src/server/routes.ts`. Closes the ACT-320 closure:gap declared at the W28 merge.

## 1. Over-block
None — the change blocks nothing; it is a registry entry + comment. The ratchet could over-fail future edits to the real brake; that is its purpose.

## 2. Under-block
The model covers the dedupe-brake class only (one issue → one emit, restart-surviving). It does not model the tick's other behaviors (evaluation cost, remediation flows) — those are not self-action emits.

## 3. Level-of-abstraction fit
Matches the established registry pattern (30th entry, same shape as the other 29): modeled trigger→brake→emit under the pinned PressureFixture. No new mechanism.

## 4. Signal vs authority compliance
No decision authority anywhere — pure test infrastructure. The ratchet is CI signal.

## 5. Interactions
The forcing lint (`lint-no-unregistered-self-action`) stops flagging this emit (verified); no other check consumes the registry entry. No double-fire risk — the annotation is a comment.

## 6. External surfaces
None. No runtime behavior, routes, or messaging changes.

## 7. Multi-machine posture
Not applicable — test-only code; the modeled controller itself is Echo-local by the W28 spec's non-leakage rule.

## 8. Rollback cost
Revert the commit; the lint returns to report-only flagging of the emit. No data or state involved.

## Fidelity verification (the load-bearing check)
The model records the issue into durable state BEFORE emitting, mirroring `routes.ts` where `ledger.surfacedIssues.push(...)` + `windowStore.save(...)` precede the async `sendToTopic` (verified at the shipped lines during this review). Ratchet: 141/141 including the new entry's bounded-emission and restart cases.

## Review record
Lane C2 (codex): 1 review cycle, clean, stop conditions declared before cycle 1, last-material-defect cycle 0 (none found). Observer independently verified fidelity + gates at commit time.

## Conclusion
Clear to ship.
