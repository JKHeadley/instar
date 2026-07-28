# Convergence Report — Feature Maturation D7 recurring evaluation

## Cross-model review

Real GPT-tier (`codex-cli:gpt-5.5`) and Gemini-tier (`gemini-cli:gemini-3.1-pro-preview`) reviews ran. The local Standards-Conformance Gate was invoked but rejected the worktree path as outside its configured spec directory; this unavailable signal did not block review.

## Outcome

The converged design makes every active rollout measurable and periodically re-scored while preserving the existing rollout authority. It uses one additive table inside `BlockerLifecycleLedger`, the existing summary/trend envelopes, and one six-hour timer owned by `BlockerLifecycleService`. It does not add a maturation registry, scheduled job, database owner, promotion action, model call, or notifier.

## Iteration summary

| Round | New findings | Disposition |
|---|---:|---|
| 1 | 8 | Clarified stage terminology, cadence floor, fail-soft missed rows, timestamp bounds, source registry, contract history, and pool-local slots. |
| 2 | 6 | Pinned contract-change semantics, descriptor units/sample meaning, evidence maximum age, append-only records, and local embedded-telemetry rationale. |
| 3 | 5 | Added bounded missed-cadence recovery, contract diagnostics, honest V1 producer scope, exact margin field, and query-plan requirements. |
| 4 | 5 | Established one canonical cadence owner, reserved rather than claimed future producers, quiet-source freshness models, indexes, and rung definition. |
| 5 | 5 | Added evaluation epochs, removed rung from uniqueness, canonicalized source pairs, batched reads, and the explicit domain mental model. |
| 6 | 0 material | Fresh internal re-audit found no unresolved security, authority, duplication, migration, multi-machine, performance, or decision-completeness issue. |

## Foundation audit

The audit found one real design trap: adding maturation as a third blocker factor would violate PR #1535's exactly-two-factor contract. The resolution is a sibling evaluation table owned by the same ledger class and database. `FeatureRolloutReconciler` and `InitiativeTracker` remain feature identity/stage owners; the human/config change remains promotion authority. A source ratchet prevents a parallel maturation ledger, database, job, or read engine.

## Convergence verdict

Converged after six rounds. The last sweep produced zero new material findings. All operator requirements are represented: per-feature numeric contracts, recurring evaluation for every dark/soaking feature, explicit stale/missing/missed states, reuse of blocker summary/trend and benchmark-compatible descriptor machinery, and no parallel measurement or maturation engine.
