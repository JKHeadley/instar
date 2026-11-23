# Side-Effects Review — Isolate the Actions merge fixture

Date: 2026-11-23. Author: Echo. Tier 1: one test environment entry plus documentation; one review round. This change makes the Actions-contract integration test select its intended existing mode. Production scripts and settings are unchanged.

## Decision-point inventory
No production decision point changes. The fake subprocess explicitly selects Actions mode; the existing Actions and local authorities remain intact.

## 1. Over-block
No production block or allow surface. Local-mode behavior remains covered by its separate suite.

## 2. Under-block
No verification requirement is removed. The fake Actions tests still refuse absent checks and require complete producer-bound evidence. This fixture is not proof that a real change is mergeable.

## 3. Level-of-abstraction fit
The mode belongs in the test subprocess environment because that subprocess exercises the Actions contract. Changing the live agent configuration would affect unrelated work and would be the wrong layer.

## 4. Signal vs authority compliance
Reference: docs/signal-vs-authority.md. No new production authority or detector. Existing merge authorities are unchanged.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point.

## 5. Interactions
The explicit child setting overrides inherited local-floor selection only for this test. The fake GitHub executable remains scoped to the temporary fixture. No queue, receipt, or real pull-request state is mutated. No new race, double action, or feedback loop was identified.

## 6. External surfaces
Tests and documentation only. No shipped runtime change, API, persistent state, external request, or capability claim.

## 7. Multi-machine posture
Test-process-local by design. The test gives the same result on computers configured for either supported verification mode. No status surface, notice, URL, or cross-machine state changes.

## 8. Rollback cost
Revert the commit. No migration or agent-state repair is necessary.

## Evidence
Before correction, six Actions-fixture tests failed with refused:verify-record-unmeasurable on the locally configured host. After correction, the six Actions tests and eighteen local-floor tests pass together. The full integration runs otherwise passed; complete verification remains required before merge.

## Conclusion
The fixture selects its documented contract without weakening production merge checks. Independent review is recorded in the accompanying development trace after it completes.

## Class-Closure Declaration
No agent-authored prompt, hook, config, skill, standards-text defect or self-triggered controller change — not applicable. This is a subprocess test fixture correction.
