# Side-Effects Review — Feature maturation plan visibility

**Version / slug:** `feature-maturation-plan-visibility`
**Date:** `2026-07-21`
**Author:** `Instar-codey`
**Second-pass reviewer:** `maturation_second_pass`

## Summary of the change

This strengthens the existing Maturation Path registry article, adds a pure Markdown structure detector, emits a WARN-only diagnostic from the existing convergence tag writer, and delivers both files through PostUpdateMigrator with hash-based customization detection and durable replacement.

## Decision-point inventory

- `findMaturationPlanGaps` — add — pure structural signal with no blocking authority.
- convergence tag writer — modify — reports the signal but retains exit status and stamping behavior.
- migration stock/custom classification — add — deterministic closed-world content-hash invariant protecting user customizations.

## 1. Over-block

No runtime block exists. A valid non-canonical plan can warn, but v1 still stamps convergence. The canonical accepted form is documented and tested.

## 2. Under-block

A syntactically complete but poor plan is not rejected. This is intentional: structural parsing is a cheap signal; the lessons-aware reviewer holds semantic authority.

## 3. Level-of-abstraction fit

The validator sits beside the existing `findDecisionPointGaps` convergence seam. The standard is updated in place. Runtime graduation remains owned by FeatureRolloutReconciler and InitiativeTracker; no parallel engine exists.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate.

The Markdown parser only reports missing deterministic structure. It cannot veto convergence or judge plan quality.

## 4b. Judgment-point check

No new heuristic at a competing-signals decision point. Stock-file hash membership and structural field presence are closed-world invariants. Semantic maturation quality remains a reviewer judgment.

## 5. Interactions

- **Shadowing:** the warning runs after existing open-question and decision-point hard gates, and before tag writing. It cannot shadow either gate.
- **Double-fire:** one invocation emits at most one stable warning line.
- **Races:** migration writes use unique sibling temps, exclusive create, file and directory sync, and same-filesystem rename.
- **Feedback loops:** none in v1; no scheduler or initiative cadence is added.

## 6. External surfaces

Developers may see a new stderr warning during spec convergence. No messages, routes, external APIs, persistent runtime records, or operator actions are added.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Unified: the detector, tag writer, and standard are git/package artifacts delivered identically to each machine. V1 emits no notice, durable rollout state, or URL. Existing customized targets remain local by user choice and are reported untouched.

## 8. Rollback cost

Revert and ship a patch. The warning creates no data. Installed stock files retain durable pre-migration backups; customized files are never modified.

## Conclusion

The change is bounded to warning visibility, extends the correct existing owners, and preserves semantic authority. The main risks—parser false positives and migration corruption—are non-blocking or covered by adversarial and injected-failure tests.

## Second-pass review (if required)

**Reviewer:** maturation_second_pass
**Independent read of the artifact:** concur

Concur with the review — the implementation now preserves WARN-only signal authority, exact gate classification, customization-safe durable migration parity, and the v1-only boundary with all 26 targeted tests passing.

## Evidence pointers

- `tests/unit/feature-maturation-plan-gate.test.ts`
- `tests/unit/write-convergence-tag-maturation-plan.test.ts`
- `tests/unit/PostUpdateMigrator-feature-maturation.test.ts`

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. This is a new WARN-stage guard, not a defect repair or self-triggered controller.
