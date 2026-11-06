# Side-effects review — canonical coverage source boundary

## Summary

Tier1 narrow reversible correction to the pending coverage reader and warning. The full runtime verifier ran59514unit tests and found two genuine regressions: advisory capability receiver consumption and a place-pointer message. The correction reads actual local definition data through its existing owner, leaves the authority ratchet untouched, and gives the warning its own action. No new activation, policy, flag or database.

## Decision points

The census identifies registered definitions only. It cannot establish availability, routing, placement or admission. Generic readiness remains advisory measurement; it is not authority over those operations. The new baseline/promotion proposal remains a separate unapproved Tier2 design.

## 1. Over-block

Foreign projection origin refuses local attribution. Truncation and non-observed sources keep known definitions but mark the source unavailable. Enabled mesh with unknown identity remains unavailable; a standalone local alias remains valid. These hold completeness claims, not ordinary services.

## 2. Under-block

A definition is not proof of a working model. No availability posture is inferred. Missing/corrupt fallback and unknown-mesh branches are conservative by inspection; new explicit cases cover populated, empty, truncated and foreign durable projections. No exhaustive model-quality claim.

## 3. Level of abstraction

CapabilityRegistry owns validated producer projection and canonical doorway-source reads. MeasurementCoverageRead consumes that definition inventory, never the receiver's advisory snapshot/classification. No regex evasion, receiver alias, ratchet exception or second catalog is introduced.

## 4. Signal vs authority

Per docs/signal-vs-authority.md, definition membership is a census fact, not permission to execute a capability. No source was promoted into admission/placement/routing authority. Existing FD-17 ratchet remains unchanged and passes.

## 5. Interactions

Existing raw projection validation and width/origin checks are reused. Observed-empty can be zero; source failure is not zero. Known truncated entries remain counted as a lower bound with an unavailable source flag. Same kind/origin namespaces and existing generic target resolution remain. Core read failure retains its existing degradation reporting.

## 6. External surfaces

Existing board read only. Capability posture is registered-definition, never available. Warning copy says coverage cannot be read and offers the existing ask action in place. No protocol/auth/service-control change.

## 6b. Operator-surface quality

Concise source-unavailable warning with its own action. No location pointer. Definitions and measurements are plainly distinct; detailed source metadata remains expandable.

## 7. Multi-machine posture

Read each origin's own validated local catalog; standalone local alias is allowed, a real foreign origin is not. Existing selected-origin peer bounds and source-failure reporting remain. No new replication claim or machine-local continuity-bearing store.

## 8. Rollback cost

Revert code/copy; no data/config migration. The old regressions would again fail required checks, so no release with the reverted regression is claimed.

## Verification

Full-run failures reproduced locally before repair.102unit (ratchet, console97, coverage-view4),22real-route integration and6production-AgentServer E2E pass. Actual persisted raw catalog fixtures cover populated, observed-empty, truncated and foreign origins. Full-suite rerun is required; prior lanes stopped early and are not called green.

## Second-pass review

**Reviewer:** /root/coverage_fix_review — independent native Codex fresh-eyes reviewer under the SMALL build review requirement.

Concur. Validated producer definitions are not receiver availability/routing authority. Foreign/truncated/observed-empty handling and actual route/production tests are meaningful. Missing/corrupt fallback, non-observed state and unknown mesh identity are nonblocking inspected test gaps; no blocking regression found. This is one distinct repair review, not a claim of an additional original generic-contract convergence round.
