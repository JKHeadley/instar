<!-- bump: patch -->
## What Changed

Adds the ContextBudgetSentinel's Phase 0 core (`src/monitoring/ContextBudgetSentinel.ts`): a per-machine watcher that reconciles quarantined context folds (rollback within 15 minutes; past that, end the stuck session, verify it really stopped, then roll back and raise one Attention item — or keep the conversation paused and escalate if it cannot verify), raises unreadable fold records to Attention, and prunes expired transcript checkpoints. Fold carriers of an unreadable fold record are now kept at boot instead of released. The sentinel's heartbeat becomes a fold precondition. It runs on development agents (`contextBudget.sentinel.enabled`); no fold can begin yet.

## What to Tell Your User

Nothing changes for you yet. This is the watcher that will step in if tidying a conversation's memory ever gets stuck, and tell me when it needs a person.

## Summary of New Capabilities

- ContextBudgetSentinel (dev-gated): quarantine reconciliation with verified termination, torn-record escalation, checkpoint grace pass, fold heartbeat.

## Evidence

- Unit `tests/unit/ContextBudgetSentinel.test.ts`; integration `tests/integration/context-budget-sentinel-quarantine.test.ts`; e2e `tests/e2e/context-budget-sentinel-lifecycle.test.ts` (real crash past the point of no return).
