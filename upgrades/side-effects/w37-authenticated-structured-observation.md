# Side-Effects Review — authenticated structured observation

**Version / slug:** `w37-authenticated-structured-observation`
**Date:** `2026-08-18`
**Author:** `Instar Agent (instar-codey)`
**Second-pass reviewer:** `/root/w37_side_effects_review`
**Independent judgement:** pending

## Summary

The protected standards execution plan now authorizes an exact collector SHA-256. The verifier compares and materializes those protected bytes, and H1 binds the collector's signed structured observation into the authenticated child-exit receipt. A digest-mismatched exact-schema forgery fails closed before execution.

## Decision points

- Protected execution schema — adds the exact `runnerSha256` authority field.
- Execution verifier — reads the runner from the protected snapshot, compares before materialization and immediately before each execution, authenticates sequenced signed observations, and retains receipt linkage.
- Node test runner — emits signed ready and observation events around the existing `TestsStream` summary.
- Measurement output — exposes the exact observation digests and explicit receipt binding.
- Negative control — proves a forged exact-schema runner returns UNKNOWN with no artifact and does not execute.

## Over-block

Any protected plan without the current collector digest becomes UNKNOWN. Collector updates therefore require an independently reviewed protected-plan digest update. Missing, duplicated, malformed, unsigned, out-of-sequence, or receipt-unbound events also fail closed. This is intentional because those cases lack authorship proof.

## Under-block

The protected collector establishes mechanical provenance for counts and assertion classification; it does not establish semantic adequacy of the chosen observer, subject, or mutation. Those still require independent review. Node itself and the outer grading harness remain environmental instruments and must be pinned for a particular hand-verification claim.

## Abstraction fit

The change repairs the narrow authority boundary instead of inventing a second test protocol. It preserves the native `node:test.run()` TestsStream source and the existing clean/mutated/pristine execution design, adding only protected content addressing and receipt linkage.

## Signal vs authority

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Hard invariant over enumerable structure.

The protected snapshot, exact SHA-256 comparison, Ed25519 signatures, monotonically sequenced events, exact observation digest, and H1 receipt linkage are mechanical authority checks. Human stdout remains diagnostic only. Ambiguity cannot promote.

## Judgment-point check

No static heuristic is added at a competing-signals decision point. This is a hard-invariant boundary over an enumerable execution-plan schema, exact file bytes, cryptographic event linkage, and exact child outcomes; it does not interpret conversational meaning or choose among live contextual signals.

## Interactions

- Existing C1/C3 two-way discrimination remains unchanged.
- Both old TAP-like and new glyph-like forged renderer summaries remain ignored.
- H1's core file is unchanged; W3.7 consumes its existing authenticated observer-event boundary.
- Timeout and isolated workspace cleanup remain unchanged.
- Candidate ledger records remain ignored as authority.
- The W3.7 worktree shares W3.5 `node_modules`; final hand evidence disables Vitest cache and pins the complete resolved shared input tree before and after execution, excluding only Vitest's disabled runtime-results output.

## External surfaces

Protected schema-v3 execution plans gain a required `runnerSha256`. Protected main currently has no such live plans, so there is no persisted migration. No network, database, user, operator, CI, or deployment surface changes.

## Operator-surface quality

No operator surface — not applicable.

## Multi-machine posture

Collector and observation identities are portable because they are content-addressed. Ephemeral event keys, sessions, process IDs, timestamps, receipts, and artifact hashes are machine-local by design. The hand-evidence harness pins each machine's Node binary and resolved dependency tree separately.

The mechanism emits no user-facing notices, holds no durable runtime state, and generates no URLs. It therefore needs no one-voice notification gate, topic-transfer replication, or cross-machine URL treatment.

## Rollback

A code revert removes the digest and event-receipt binding and restores the accepted J18 evidence-authorship fault. There is no data migration.

## Conclusion

The review found the exact-digest and receipt-linkage checks to be hard invariants at the correct authority layer. The shared-tree review caused Vitest cache to be disabled and the complete remaining transitive input tree to be pinned. Independent b03 grading remains separate.

## Second-pass review

**Reviewer:** `/root/w37_side_effects_review`
**Independent read of the artifact:** concur

Concur with the review — the protected digest gate, materialized runner, signed observation-to-receipt linkage, fail-closed controls, and disclosed shared-tree pinning place authority correctly and are accurately represented.

## Evidence

- `scratchpad/phaseB/REPORT-W37.md`
- `tests/unit/standards-enforcement-measurement.test.ts`
- `tests/unit/standards-coverage-ratchet.test.ts`

Independent b03 judgement remains pending. This record claims only BUILT WITH HAND EVIDENCE.

## Class-Closure Declaration

`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence: { enforcementType: gate, citation: tests/unit/standards-enforcement-measurement.test.ts, howCaught: an exact-schema collector forgery with a marker write is rejected by a protected expected-digest mismatch before execution, returns UNKNOWN, and mints no artifact while the genuine receipt-bound C1 path still reaches ratchet }`.
