# Side-Effects Review — W3.8 live-artifact closure

**Version / slug:** `w38-live-artifact-closure`
**Date:** `2026-08-18`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** different judging lane, pending after PR by operator assignment

## Summary of the change

The standards execution verifier now recursively freezes authenticated artifacts and revalidates their content address plus every copied observation count/classification against the signed observation. Standards measurement now records whether protected execution authority is operational, prospective, a test stand-in, or unavailable; the CLI prints that record. Canonical status becomes operational only when the canonical snapshot contains both the protected runner and a valid schema-v3 verdict record binding its exact SHA-256.

## Decision-point inventory

- `isLiveAuthenticatedExecutionArtifact` — **modify** — adds exact mechanical integrity checks before an artifact can contribute to promotion.
- `describeProtectedExecutionAuthority` — **add** — classifies an enumerable canonical-state condition and records the specific missing admissions.
- standards-coverage fallback and CLI output — **modify** — makes absence/non-operation visible instead of silently omitting authority state.

## 1. Over-block

Artifacts created under the W3.7 schema are rejected by the W3.8 live predicate because the schema advances from v3 to v4 and the clean/confirmation copies now include assertion classification fields. There is no persisted artifact migration: artifacts are ephemeral, minted and consumed inside one measurement. A canonical ledger that merely contains a digest-shaped nested value is also rejected; it must contain a structurally valid schema-v3 proof record. That stricter condition is intentional because malformed records are not authority.

## 2. Under-block

This repair establishes internal mechanical consistency, not semantic adequacy. A separately admitted observer, subject, or mutation can still be poorly chosen; independent judgment remains responsible for that meaning. The live WeakSet continues to ensure cloned objects are not promoted even when internally consistent. The prospective authority record does not merge the missing runner or ledger and cannot make canonical protection operational by itself.

## 3. Level-of-abstraction fit

The artifact validator is the correct layer because it owns the exported reusable predicate and has all signed event, receipt, copied-field, and address inputs. The canonical-authority description belongs beside protected snapshot measurement because only that layer knows the snapshot source and reads both canonical files. The CLI only renders the structured record; it does not independently infer authority.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Hard-invariant validation over an enumerable domain.

The modified block path checks exact schema, SHA-256 equality, recursive frozen state, exact signed-field equality, and exact presence of two canonical artifacts. It interprets no conversational meaning and weighs no competing signals. Deterministic refusal is appropriate for this cryptographic/structural authority boundary.

## 4b. Judgment-point check

No static heuristic is added at a competing-signals judgment point. The states are mechanically enumerable: protected runner bytes absent/present, valid ledger absent/present, exact digest binding mismatched/matched, and canonical/test source.

## 5. Interactions

- **Shadowing:** the new checks extend the existing live-artifact predicate; they do not bypass event or receipt authentication.
- **Double-fire:** there is one predicate and one authority record. The CLI renders the record produced by measurement and adds an explicit unavailable fallback only when measurement cannot produce one.
- **Races:** artifacts are deep-frozen before entering the live WeakSet. Measurement still consumes the artifact immediately, but correctness no longer depends on that timing.
- **Feedback loops:** none. The record is report output and does not mutate canonical state.

## 6. External surfaces

The JSON standards report gains `measurement.basis.executionAuthority`, and non-quiet CLI output gains one human-readable authority line. No network API, database, user message, operator action, or durable ledger write is added. The production resolver already reads canonical GitHub main; this change only describes the resolved state. No operator-facing action is introduced.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Machine-local by design for ephemeral artifacts; portable for canonical status.** Each execution artifact contains machine-local process IDs, sessions, receipts, and timestamps and is consumed in-process. Its structural validation is identical on every machine. The authority record derives from content-addressed canonical repository bytes and therefore converges across machines that resolve the same main SHA. The change emits no user-facing notice, holds no new durable state, and generates no URL.

## 8. Rollback cost

Pure code and documentation revert. No data migration, agent-state repair, or persisted-artifact cleanup is required. Rolling back would reopen the reusable-artifact integrity gap and remove the explicit prospective-state warning.

## Conclusion

The review found the repair at the existing hard-invariant boundaries. The implementation was tightened during review so an operational ledger binding requires a fully valid proof record, and fallback reports also carry an explicit non-operational state. Independent judgment remains assigned to another lane and is not claimed here.

## Second-pass review

**Reviewer:** different judging lane after PR
**Independent read of the artifact:** pending

The builder does not self-judge. The operator explicitly assigned independent judgment to a different lane.

## Evidence pointers

- `scratchpad/phaseB/REPORT-W38.md`
- `tests/unit/standards-enforcement-measurement.test.ts`
- `tests/unit/standards-coverage-ratchet.test.ts`

## Class-Closure Declaration

`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence: { enforcementType: gate, citation: tests/unit/standards-enforcement-measurement.test.ts, howCaught: W38_C4 requires the genuine live artifact and every nested copy to remain frozen, while W38_C5 re-addresses each of the fifteen copied observation-field tampers and requires internal consistency and the exported live predicate to reject them; W38_C6 refuses to label fixtures or incomplete canonical snapshots operational }`.
