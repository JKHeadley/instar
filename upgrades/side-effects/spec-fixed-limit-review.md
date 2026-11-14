# Side-Effects Review — contest unsupported fixed limits

Date: 2026-11-06. Author: Echo. Tier 1 / SMALL: reversible review-process repair, approximately 15 files / 300 lines. One independent reviewer, four passes (classification-field parsing corrected); no spec convergence rounds. Commit/gate attempts recorded in the build summary.

## Summary
The original Skill Learning Sentinel limits passed because a classification token stood in for evidence. Both mandatory reviewer lenses and the conformance prompt now independently contest every fixed behavioral limit; the tag writer requires an invariant basis and evidence declaration. The update migration refreshes the stock skill even when its original classification marker is already present. Source: fb-10cc0a80-caf, topic 139880; the separate spec correction is PR #2871.

## Decision-point inventory
- Convergence declaration: modify structural requirements for invariant rows.
- Reviewer correctness: modify intelligent evaluation of evidence, exact boundaries and legitimate rejected cases.
- Installed-skill refresh: modify the version marker; retain fingerprint protection and idempotency.

## 1. Over-block
Existing invariant rows need explicit basis/evidence fields when reconverged. This is an intentional declaration-format change, with remediation printed by the CLI. No existing convergence tag is revoked. Genuine safety, protocol and enumerable-domain constraints remain admissible; non-gating measurements and examples are excluded from cap contests.

## 2. Under-block
A false declaration can still be written. Structural presence cannot prove semantic necessity. Both reviewers and the conformance reviewer independently contest the substance; no claim is made that regex validates truth. Reviewers can still err and the conformance service can degrade; those existing limits remain visible.

## 3. Level-of-abstraction fit
Review prompts own semantic assessment; the existing convergence writer owns declaration shape. No new runtime controller or parallel authority is introduced.

## 4. Signal vs authority
Complies with docs/signal-vs-authority.md: only missing/invalid structural declarations refuse stamping. No numeric detector blocks agent actions. Intelligent reviewers hold the existing semantic convergence decision; conformance remains advisory.

## 4b. Judgment-point check
The limit's necessity is a judgment-candidate. The validator checks only declared basis category and nonempty evidence. Reviewers must reject circular evidence even when fields are present. A fallback design must name a complete deterministic floor and arbiter rather than inventing another cap.

## 5. Interactions
Uses existing decision-point and convergence paths. New skill marker activates the existing migration once; templates and writer already refresh unconditionally via migrateFeatureMaturationGate. No duplicate FailedFileDiagnosisPeerService fix; PR #2887 is merged and #2885 remains independently owned. Ordinary merging awaits main health.

## 6. External surfaces
Convergence CLI emits a new actionable refusal for missing invariant evidence. No route schema, external write, notice or operator action is added.

## 6b. Operator-surface quality
No operator surface — not applicable.

## 7. Multi-machine posture
Replicated as shipped package content through each machine's existing update path. No mutable cross-machine state, generated URLs or notices. No status/health answer changes.

## 8. Rollback cost
Revert and release. No data migration, state repair or irreversible external action.

## Class-Closure Declaration
`defectClass: claim-vs-evidence`, `closure: guard`. `guardEvidence`: enforcementType `ratchet`, citation `tests/unit/write-convergence-tag-decision-points.test.ts`. The original invariant-labelled growth row now refuses convergence without evidence; both reviewer prompts require independent contest. The ratchet protects declaration presence and review instructions, not the correctness of an arbitrary LLM verdict.

## Second-pass review
Reviewer: /root/review_fixed_limits. **Concur with the review.** Independently exercised both table/bullet name-collision regressions, a valid evidenced invariant and a judgment rationale mentioning the old label. Earlier concern about scanning decision names was resolved by reading the classification field; reviewers may explicitly report no legitimate counterexample for genuine floors. No remaining blocking concerns.

## Evidence pointers
Fail-first: the original growth row was stamped and nine new checks failed on the old implementation. 110 unit checks, 10 conformance integration checks, 5 conformance lifecycle checks and TypeScript checking pass. Parser/CLI, conformance prompt and migration coverage verify the repair.
