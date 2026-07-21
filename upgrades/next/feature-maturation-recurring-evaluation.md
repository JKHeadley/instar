# Feature maturation now re-checks measurable evidence on a cadence

## What Changed

- Added bounded per-feature maturation metric contracts to existing rollout records.
- Extended the existing blocker-lifecycle metrics database and summary/trend surfaces with recurring per-feature evaluation snapshots.
- Every dark, dry-run, or live rollout now receives an explicit ready, hold, stale, insufficient, missing-contract, or missed-cadence result on the development-agent measurement substrate.
- Evaluation is measure-only: it cannot enable a feature, advance a rollout, or send a notification.

## What to Tell Your User

Instar can now show whether each feature that is still dark or soaking has fresh, measurable evidence for its next rollout step. Missing or stale evidence stays visible instead of quietly aging out, while promotion remains an operator-controlled decision.

## Summary of New Capabilities

- Track numeric maturation criteria per staged feature.
- Re-score every active rollout on a recurring cadence.
- Read per-machine maturation status and history through the existing blocker-lifecycle summary and trend surfaces.

## Evidence

- Focused ledger, scorer, contract-parser, rollout-reconciler, canonical-scan, and lifecycle e2e tests pass.
- TypeScript and repository lint pass.
- The duplicate-safety audit preserves the blocker ledger's exactly-two latency factors and prohibits a parallel maturation ledger.
