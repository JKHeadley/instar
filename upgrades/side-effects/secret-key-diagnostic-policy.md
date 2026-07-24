# Side-Effects Review — Secret-key diagnostic policy

**Version / slug:** `secret-key-diagnostic-policy`
**Date:** 2026-07-18
**Author:** Instar Agent (instar-codey)
**Second-pass reviewer:** not required

## Summary of the change

Machine doctor passes `config.secrets.forceFileKey` to its read-only `SecretStore`, and two source-scanning regression tests now validate their region boundaries explicitly. This closes the three review findings concerning diagnostic-policy disagreement and a fragile end marker without changing vault data or key selection semantics.

## Decision-point inventory

No new block, allow, dispatch, or semantic judgment is introduced. An existing explicit configuration value reaches an existing read-only diagnostic store.

## 1. Over-block

Not applicable: the command remains diagnostic and does not prevent an operation.

## 2. Under-block

The change does not infer policy from whether a machine looks headless. It preserves the operator’s configured choice and reports that choice through the existing `SecretStore` resolution.

## 3. Level-of-abstraction fit

Policy propagation belongs at the `SecretStore` construction site. Boundary validation belongs in the source-level tests that rely on those markers.

## 4. Signal vs authority compliance

The configured key policy remains authoritative. The diagnostic label is a derived signal and cannot alter the policy.

## 4b. Judgment-point check

No competing-signals judgment point is added.

## 5. Interactions

- No new writers, events, retries, or races.
- The doctor command may initialize key resolution exactly as before; only its existing policy input is now consistent.
- Marker assertions fail loudly if server section labels drift, preventing unrelated code from satisfying the constructor count.

## 6. External surfaces

Only the accuracy of the existing human-readable doctor label changes. No API, credential, secret value, or persistence format changes.

## 6b. Operator-surface quality

The corrected label is more actionable because it names the configured backend rather than a contradictory default-path result.

## 7. Multi-machine posture

The vault key remains machine-local. This change neither replicates key material nor changes secret-sync transport; it only aligns one machine’s diagnostic read with that machine’s policy.

## 8. Rollback cost

A direct revert restores the former diagnostic construction and test assertions. No migration is needed.

## Conclusion

The change narrows diagnostic ambiguity and strengthens a regression boundary without expanding authority or persistence. Focused tests are green.

## Second-pass review

Not required: messaging, session lifecycle, recovery, and guard behavior are unchanged.

## Class-Closure Declaration

No agent-authored-artifact controller or self-triggered loop is involved.
