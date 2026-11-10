<!-- bump: patch -->
## What Changed

`SelfHealGate` (`src/core/SelfHealGate.ts`) gains four opt-in extensions for the Context Budget sentinel: a pool-shared controller that refuses unless this machine owns the target, async remediation bounded by a timeout with one remediation in flight per episode, per-incident episode keys with pruning of finished episodes, and a per-group ring (evict the oldest finished episode, refuse only when all are active) for a controller's own episode store file. Existing self-heal ladders are unchanged.

## What to Tell Your User

Nothing changes for you. This prepares the safety ladders that will watch the new memory-tidying work.

## Summary of New Capabilities

- `SelfHealGate`: pool-shared ownership refusal, async remediation, terminal-episode pruning, per-group episode ring.

## Evidence

- Unit `tests/unit/SelfHealGate-extensions.test.ts`; integration `tests/integration/self-heal-gate-pool-ladder.test.ts`; e2e `tests/e2e/self-heal-gate-async-crash.test.ts` (real crash mid-remediation).
