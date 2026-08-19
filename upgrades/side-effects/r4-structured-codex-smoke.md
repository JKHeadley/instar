# Side-Effects Review — structured Codex smoke acceptance

**Version / slug:** `r4-structured-codex-smoke`
**Date:** `2026-08-18`
**Author:** `Instar-codey`
**Second-pass reviewer:** `/root/r4_side_effects_review`

## Summary of the change

R4 changes the Phase 4 Codex smoke acceptance contract from the human word `PASSED` to a versioned JSON success record. It modifies the Phase 4 manifest and smoke producer, adds a typed result helper, and adds both-direction unit controls. Every terminal path now sets an exit code and lets Node drain output naturally. It does not alter provider transport or credential logic.

## Decision-point inventory

- `createCodexSmoketestReporter().success` — modify — emits a success signal only for non-empty provider text and keeps JSON stdout machine-only.
- Phase 4 `codex-smoketest` gate — modify — accepts only exit zero plus the exact v1 success fields.

## 1. Over-block

The structured acceptance command rejects an otherwise exit-zero runner that prints only the old `PASSED` sentence. That is intentional for the Phase 4 gate and the manifest command changes in the same commit. The ordinary no-flag developer command retains the old human-readable sentence. A future producer that adds extra stdout around the JSON record will also be rejected; JSON-mode diagnostics must remain on stderr.

## 2. Under-block

The receipt proves only that the producer reached its non-empty-text success path. It does not independently judge whether the provider response is semantically useful, and it trusts the checked-in producer to report honestly. R4 makes no live paid call and does not refresh the manifest's historical live-provider evidence. Those are explicit boundaries, not claims this consistency repair closes.

## 3. Level-of-abstraction fit

The producer owns the low-level observation that returned text is non-empty. The existing acceptance reader owns the deterministic boundary decision and combines process exit, one-document JSON parsing, schema identity, and exact fields. R4 reuses that reader rather than creating a parallel parser or another textual detector.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] Deterministic hard-invariant validation in an enumerable machine contract.
- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with conversational context.
- [ ] Yes, with brittle judgment logic.

The acceptance gate has blocking authority, but it is not making a judgment about meaning. The valid domain is enumerable: exit zero, one JSON document, the exact schema, `status: passed`, and `responseNonEmpty: true`. This is the hard-invariant boundary exception described in the principle. The previous word search was presentation-sensitive; the new contract is typed producer evidence consumed by the existing deterministic authority.

## 4b. Judgment-point check

No static heuristic is added at a competing-signals decision point. The result fields and exit status do not conflict or require contextual arbitration; any missing, malformed, non-success, or non-zero combination deterministically refuses acceptance.

## 5. Interactions

- **Shadowing:** exit-code refusal still runs and can reject before the JSON comparison; this is intentional independent evidence, not shadowing that removes coverage.
- **Double-fire:** no second authority is added. The existing Phase 4 reader evaluates both exit and structured output once.
- **Races:** the helper is stateless. Process-backed stdout and stderr can drain asynchronously, so the smoke producer never forces `process.exit()` after writing; child-process controls observe the complete receipt and diagnostics before natural termination.
- **Feedback loops:** none. Acceptance does not feed a result back into the smoke producer.
- **Sibling gates:** R4 completes the structured-output pattern already used by the two parity gates and does not modify their consumer.

## 6. External surfaces

Developers running the ordinary smoke command see the same progress and final success sentence. Automation invoking the manifest now receives machine JSON on stdout and diagnostics on stderr. Missing or rejected credentials, empty output, and crashes retain non-zero exits. Natural process termination avoids truncating either stream. No database, ledger, user notice, remote API shape, operator action, or generated URL changes. The only runtime condition outside the repository is the existing credential/provider availability needed by the live smoke itself.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

**Replicated** — the manifest, producer, and schema ship as repository source and therefore have the same acceptance semantics on every installed machine. Credential availability and the live provider response remain machine/runtime facts, but they feed the same fail-closed contract. R4 emits no user-facing notices, holds no durable state, and generates no URLs, so it introduces no one-voice, topic-transfer, or cross-machine link requirement.

## 8. Rollback cost

Pure code/config rollback: revert the five R4 files and ship the next patch. There is no persistent state or migration. The rollback would restore presentation-sensitive acceptance brittleness but would not require agent state repair or user cleanup.

## Conclusion

The review found one intentional compatibility boundary: JSON acceptance mode refuses the legacy prose-only result and any extra stdout. The manifest and producer change together, and a production-manifest control prevents those paths from silently diverging, while the human command remains stable. Child-process controls close the output-delivery seam found during the independent pass. No new judgment authority, state, concurrency, or multi-machine seam is introduced. The change is clear for independent review as a low-severity consistency repair.

## Second-pass review

**Reviewer:** `/root/r4_side_effects_review`
**Independent read of the artifact:** concurred after two findings were corrected. The reviewer
confirmed that the finished implementation and artifact cover authority placement, fail-closed
receipt truth, stdout/stderr natural-drain behavior, production-manifest ratcheting, multi-machine
posture, and rollback. This is Phase 5 side-effects concurrence, not the eventual independent R4
judging verdict.

## Evidence pointers

- `scratchpad/phaseB/REPORT-R4.md`
- `tests/unit/phase-acceptance-smoketest.test.ts`
- `tests/unit/phase-acceptance-population.test.ts`

## Class-Closure Declaration

`defectClass: claim-vs-evidence`, `closure: guard`, `guardEvidence: { enforcementType: gate, citation: tests/unit/phase-acceptance-smoketest.test.ts, howCaught: the production manifest is ratcheted to the exact structured contract; exit-zero legacy prose and a structured non-success are rejected while only exact structured success passes; child processes prove stdout and diagnostics drain before natural exit }`, `component: phase-acceptance-codex-smoke`.
