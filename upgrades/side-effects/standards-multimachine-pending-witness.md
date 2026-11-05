# Side-Effects Review — witness-backed Pending exception (standards Amendment 6)

**Version / slug:** `standards-multimachine-pending-witness`
**Date:** `2026-11-05`
**Author:** `Dawn (claude-code), for Echo's Conversations hierarchy run`
**Second-pass reviewer:** `independent verifier (claude-code subagent, fresh context)`

## Summary of the change

Amends the 1.x constitution article *An Instar Agent Is Always a Multi-Machine Entity* (`docs/STANDARDS-REGISTRY.md`) with the clause the operator approved on 2026-11-05 ("choice A", Echo Telegram topic 137342, recorded in `docs/specs/conversation-effort-hierarchy-standard-decision.md`), verbatim, as **Amendment 6**: newly observed continuity-bearing information may be acknowledged *Saved · Pending* while an installed member is physically unreachable, only once an independent witness durably holds it, until that member catches up. Fully acknowledged graph changes, erasure tombstones and completed answers keep the all-member rule. Supporting edits outside the approved words: a scope sentence (Conversations hierarchy only; any other feature needs its own operator ruling), a pointer from "never INFORMATION" to the exception, the witness and retention definitions cited from v3 (§7.2 and frontloaded decision 7), the exception's enforcement status (reviewer-only), and a note that Pending is a transient state of `unified` state, not a posture. Also imports the approved v3 design and its provenance so the citations resolve, and records the Building area audit (`docs/audits/standards-multimachine-pending-witness-2026-11-05-r2.json`, convergence report `-r2.md`).
Tier 2 (constitution). Docs only, no code. Effort: four review rounds (independent verifier ×2, Echo ×2), 8 findings, all resolved.

## Decision-point inventory

No runtime decision point. The constitution is read by reviewers and by `/spec-converge`; the direction guard (`scripts/standards-direction-guard.mjs`) gates the edit itself and requires the operator's approving review on the head commit.

---

## 1. Over-block

No block/allow surface — over-block not applicable. (The amendment relaxes a rule for one design; it rejects nothing.)

## 2. Under-block

No block/allow surface. The risk this change carries is the opposite of a block: that the exception is read as general. Mitigated by the scope sentence placed directly after the clause and repeated in Applied through, and by the requirement of a separate operator ruling for any other feature.

## 3. Level-of-abstraction fit

Right layer: the single-machine survivability rule lives in this article (Amendment 1), so a narrowing of it belongs here, next to it, not in a feature spec alone. The feature-level detail (what a witness is, how long Pending lasts) stays in v3 and is cited rather than restated.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface.

## 4b. Judgment-point check (Judgment Within Floors standard)

No static heuristic added. The exception is a floor with an explicit bound (witness durability, all-member terminal certificate), and the reviewer questions recorded in Applied through are where judgment applies.

## 5. Interactions

The direction guard sees an edit to this article and requires the operator's approving review on the head commit; that is intended. `standards-coverage` area audit for Building is re-recorded. No other article is changed; *Cross-Machine Coherence* and *Ownership-Gated Side Effects* (merged subsections) are untouched and remain binding.

## 6. External surfaces

The constitution is public in this repository and is read by agents and reviewers. No runtime surface changes.

## 6b. Operator-surface quality

Not applicable — no dashboard, approval page or form is touched.

## 7. Multi-machine posture (Cross-Machine Coherence)

Not a state surface: this change edits a document. The rule it amends governs multi-machine posture; the amendment keeps the all-member durability rule for everything acknowledged and only allows a witnessed, temporary Pending state for new continuity-bearing information in the Conversations hierarchy design.

**Status surfaces:** none added or changed.

## 8. Rollback cost

Revert the commit and re-record the Building area audit. No state, migration or runtime effect.

## Conclusion

A scoped, operator-approved narrowing of the survivability rule, worded so that neither it nor the surrounding absolutes can be cited against the other, and so that no other feature can use it without its own ruling.

## Second-pass review

**Reviewer:** independent-verifier (Claude Code subagent, fresh context, 2026-11-05)
**Independent read of the artifact: concur**

Round 1 (on cf9ea): accept-with-fixes — amendment label collision, unqualified absolutes, missing enforcement status, undefined witness and lifetime. Round 2 (Echo, on 0b384ecfa): scope wider than approved, wrong citation for retention, "never expired" not v3's words, missing review files. Round 3 (independent verifier, final text): dropped "without atomic fencing/signing" qualifier, scope far from the clause, no place in the posture list. Round 4: the ELI16 overstated the old rule (Amendment 2 says the rule does not require every byte on every disk) and this section was a placeholder. All fixed. Round 5 (independent verifier, on this text): "Concur with the review", with two non-blocking notes (the ELI16 title slogan, and a pointer in this section), both fixed.

## Evidence pointers

- `node scripts/standards-coverage.mjs --check` → one failure, the direction guard (requires the operator's approving review on the head).
- Convergence report: `docs/specs/reports/standards-multimachine-pending-witness-2026-11-05-r2.md` (8 findings, all resolved).
