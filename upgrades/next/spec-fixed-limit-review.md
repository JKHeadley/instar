# Spec review contests fixed behavioral limits

## What Changed
Spec reviewers now inventory and independently contest every fixed limit on agent behavior. An invariant classification must declare a concrete basis and evidence; the convergence writer refuses missing declarations, and reviewers reject circular explanations such as “deterministic counts.” The conformance prompt asks the same question. Existing stock skills receive the update through the migration path.

## What to Tell Your User
Spec reviews now challenge arbitrary limits on agent growth and behavior. Real safety and protocol constraints still require evidence explaining the particular boundary.

## Summary of New Capabilities
No new user action. Reviewers distinguish genuine floors from arbitrary caps and require an intelligent assessment path when appropriate.

## Evidence
Feedback fb-10cc0a80-caf; the original growth-cap row fails before and passes the refusal regression after the fix. See tests/unit/write-convergence-tag-decision-points.test.ts, tests/unit/standards-conformance-gate.test.ts, tests/unit/PostUpdateMigrator-judgment-floors.test.ts and upgrades/side-effects/spec-fixed-limit-review.md.
