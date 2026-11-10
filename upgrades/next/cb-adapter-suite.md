<!-- bump: patch -->
## What Changed

Adds the adapter verification suite for the Context Budget work (`src/monitoring/adapterVerificationSuite.ts`, `adapterSuiteCli.ts`): a re-runnable check, on a throwaway headless Claude Code session, of every engine capability the feature relies on (transcript read, `/compact` and `/clear`, pre-compaction steering, the post-compaction summary, the seeds after compaction and clear, the per-prompt delta, the tool policy, checkpoint restore, the framework discriminator), each recorded as supported, partial or absent per machine, engine and version. The ContextBudgetSentinel runs it in its own process when the engine version has no recorded result (`contextBudget.adapterSuite.enabled`, default off), and `GET /context-budget/sentinel` shows the results. On this machine Claude Code 2.1.322 supports all twelve measured capabilities.

## What to Tell Your User

Nothing changes for you. I now check, instead of assume, that each Claude Code version on a machine really does everything my memory-tidying relies on, and I re-check whenever it updates.

## Summary of New Capabilities

- Adapter verification suite for Claude Code, triggered by engine version changes; results in `GET /context-budget/sentinel`.

## Evidence

- Unit `tests/unit/adapter-verification-suite.test.ts`; integration `tests/integration/adapter-verification-suite-runner.test.ts`; e2e `tests/e2e/adapter-suite-lifecycle.test.ts`; live run against Claude Code 2.1.322 recorded.
