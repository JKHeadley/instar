# Side-Effects Review — refresh PR 2885 with main

Tier 1, reversible merge-conflict resolution of an existing PR. One test file required manual resolution; existing source changes and artifacts merge from the already-open PR. No spec review rounds. One independent review pass; one commit attempt planned.

## Decision-point inventory
No newly designed runtime decision point. Existing PR outage and check diagnostics combine with main's lease-preparation ownership handling. The conflict resolution only keeps both test groups.

## 1. Over-block
No assertion or case removed. Actual ownership loss remains covered by main's tests. Unique temporary IDs remain as authored in the existing repair; no third repair is introduced.

## 2. Under-block
Source auto-merge still needs validation. Run all executor-service and diagnosis-peer tests and require full merge verification before landing.

## 3. Level-of-abstraction fit
Resolve the conflict in the existing test file and existing PR. No new controller, policy or parallel PR.

## 4. Signal vs authority
Complies with docs/signal-vs-authority.md. No authority or detector is added by this merge resolution. Existing runtime source is preserved from both parents.

## 4b. Judgment-point check
No new judgment point or static behavioral limit is introduced. The only manual decision is preserving both independent test groups.

## 5. Interactions
Retain main's lease-reacquisition and lost-ownership cases alongside the PR's outage and timeout-diagnostic cases. Both parents remain ancestors, so a normal fast-forward push cannot overwrite a concurrent divergent PR update.

## 6. External surfaces
No new surface. Original PR's notice and diagnostic changes keep their original artifacts. No new operator action.

## 6b. Operator-surface quality
No operator surface added by this merge — not applicable.

## 7. Multi-machine posture
Existing source and tests ship through the repository/package path. No new durable state, notices, URL, status/health answer, or machine-local assumption in this resolution.

## 8. Rollback cost
Restore the previous PR head or revert the merge resolution before release. No data migration or production side effect performed here.

## Class-Closure Declaration
No agent-authored-artifact defect — not applicable. This resolves a textual test conflict; the underlying original repairs retain their own evidence.

## Second-pass review
Reviewer /root/review_fixed_limits: concur. Both main’s four lease tests and the PR’s two diagnostic tests remain separate; combined source preserves preparation epoch carry-forward, lost-owner checks, outage reporting and stage details. Unique attempt IDs remain unchanged.

## Validation
Executor service: 107/107 pass. Diagnosis peer: 7/8 pass; the restart-intent case cannot spawn ps in this tool sandbox (EPERM). No assertion or test was skipped or changed to hide that restriction. Full native merge verification must pass all cases before merge.
